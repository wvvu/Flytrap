import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
