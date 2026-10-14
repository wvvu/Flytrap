import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { ResetSeal } from "../db/repos/settings.js";

/** Compare both sides in constant time, including when the lengths differ. */
export function credentialsMatch(username: string, password: string, expectedUser: string, expectedPassword: string): boolean {
  const userOk = digestEqual(username, expectedUser);
  const passOk = digestEqual(password, expectedPassword);
  return userOk && passOk;
}

/** A saved hash replaces the environment password. The username stays the environment one. */
export function loginOk(
  username: string,
  password: string,
  expectedUser: string,
  expectedPassword: string,
  storedHash: string | null,
): boolean {
  if (!digestEqual(username, expectedUser)) return false;
  if (storedHash) return passwordMatches(password, storedHash);
  return digestEqual(password, expectedPassword);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 32).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

export function passwordMatches(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt" || !parts[1] || !parts[2]) return false;
  const salt = parts[1];
  const expect = Buffer.from(parts[2], "base64url");
  const got = scryptSync(password, salt, 32);
  if (got.length !== expect.length) return false;
  return timingSafeEqual(got, expect);
}

function digestEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

export const RESET_CODE_TTL_MS = 10 * 60 * 1000;
export const RESET_MAX_ATTEMPTS = 5;
export const RESET_RESEND_MS = 60 * 1000;

export function sameAccount(left: string, right: string): boolean {
  return digestEqual(left, right);
}

export function makeResetCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function sealResetCode(code: string, now: number): ResetSeal {
  const salt = randomBytes(16).toString("base64url");
  return {
    salt,
    hash: codeHash(salt, code),
    expiresAt: now + RESET_CODE_TTL_MS,
    attempts: 0,
    sentAt: now,
  };
}

/** A wrong or expired code returns the seal to store, or null when it must be dropped. */
export function resetCodeOk(code: string, seal: ResetSeal, now: number): { ok: true } | { ok: false; seal: ResetSeal | null } {
  if (now >= seal.expiresAt || seal.attempts >= RESET_MAX_ATTEMPTS) return { ok: false, seal: null };
  if (codeHashEquals(seal, code)) return { ok: true };
  const attempts = seal.attempts + 1;
  if (attempts >= RESET_MAX_ATTEMPTS) return { ok: false, seal: null };
  return { ok: false, seal: { ...seal, attempts } };
}

function codeHash(salt: string, code: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("base64url");
}

function codeHashEquals(seal: ResetSeal, code: string): boolean {
  const got = Buffer.from(codeHash(seal.salt, code));
  const expect = Buffer.from(seal.hash);
  if (got.length !== expect.length) return false;
  return timingSafeEqual(got, expect);
}
