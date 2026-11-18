import { ulid } from "ulid";
import type { Db } from "../index.js";
import { ConfigError, parseAcceptDomains } from "../../config.js";
import { hashPassword, passwordMatches } from "../../api/password.js";
import { SettingsError, type ResetSeal, type SenderName } from "./settings.js";

export type UserRole = "admin" | "member";
export type UserStatus = "active" | "disabled";

export interface SessionPrincipal {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  isOwner: boolean;
  quotaSendDay: number;
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  quota_send_day: number;
  notes: string | null;
  reset_seal: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

export interface AllocationRow {
  id: string;
  user_id: string;
  localpart: string;
  domain: string;
  can_send: number;
  created_at: number;
}

export interface AllocationPublic {
  id: string;
  localpart: string;
  domain: string;
  pattern: string;
  kind: "exact" | "prefix" | "domain";
  canSend: boolean;
  createdAt: number;
}

export interface UserSummaryPublic {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  isOwner: boolean;
  quotaSendDay: number;
  sentLast24h: number;
  messageCount: number;
  unreadCount: number;
  notes: string | null;
  createdAt: number | null;
  lastLoginAt: number | null;
  allocations: AllocationPublic[];
}

export class UserError extends Error {
  readonly code: "bad_input" | "conflict" | "not_found" | "forbidden";

  constructor(message: string, code: "bad_input" | "conflict" | "not_found" | "forbidden" = "bad_input") {
    super(message);
    this.name = "UserError";
    this.code = code;
  }
}

export const OWNER_USER_ID = "owner";
const USERNAME_HANDLE_RE = /^[a-z0-9][a-z0-9._+-]{1,63}$/;
const LOCALPART_EXACT_RE = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]{1,64}$/;
const LOCALPART_PREFIX_RE = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]{1,63}\*$/;
const ADDRESS_SIMPLE_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(.+)$/;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

/**
 * SQL fragment matching any recipient address in `envelope_to` or `to_addrs`
 * against `user_allocations` for `:viewerUserId` (or a custom parameter name).
 * Supports:
 * - `*@domain` (whole domain)
 * - `prefix*@domain` (localpart prefix wildcard)
 * - `alice@domain` (exact mailbox + RFC 5233 `alice+tag@domain` subaddressing)
 */
export function memberMessageMatchSql(tableAlias: string, userIdParam = ":viewerUserId"): string {
  const checkJsonCol = (col: string) => `
    EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(${tableAlias}.${col}) THEN ${tableAlias}.${col} ELSE '[]' END) je
      JOIN user_allocations ua ON ua.user_id = ${userIdParam}
      WHERE typeof(je.value) = 'text'
        AND instr(je.value, '@') > 1
        AND lower(substr(trim(je.value), instr(trim(je.value), '@') + 1)) = ua.domain
        AND (
          ua.localpart = '*'
          OR lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)) = ua.localpart
          OR (
            instr(ua.localpart, '*') = 0
            AND substr(lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)), 1, length(ua.localpart) + 1) = ua.localpart || '+'
          )
          OR (
            substr(ua.localpart, -1) = '*'
            AND length(ua.localpart) > 1
            AND substr(lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)), 1, length(ua.localpart) - 1) = substr(ua.localpart, 1, length(ua.localpart) - 1)
          )
        )
    )`;
  return `(${checkJsonCol("envelope_to")} OR (${tableAlias}.to_addrs IS NOT NULL AND ${checkJsonCol("to_addrs")}))`;
}

export function normalizeUsername(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (!text || text.length > 128 || CONTROL_RE.test(text)) {
    throw new UserError("invalid username");
  }
  if (text.includes("@")) {
    const match = ADDRESS_SIMPLE_RE.exec(text);
    if (!match || text.includes("*")) throw new UserError("invalid username");
    const at = text.lastIndexOf("@");
    const local = text.slice(0, at);
    const domain = normalizeDomain(match[1] ?? "");
    if (!LOCALPART_EXACT_RE.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
      throw new UserError("invalid username");
    }
    return `${local}@${domain}`;
  }
  if (!USERNAME_HANDLE_RE.test(text) || text.includes("..")) {
    throw new UserError("invalid username");
  }
  return text;
}

export function normalizeDomain(raw: string): string {
  try {
    const parsed = parseAcceptDomains(raw);
    const domain = parsed[0];
    if (!domain || parsed.length !== 1) throw new UserError("invalid domain");
    return domain;
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (err instanceof ConfigError) throw new UserError("invalid domain");
    throw new UserError("invalid domain");
  }
}

export function parseAllocationSpec(input: {
  address?: string;
  localpart?: string;
  domain?: string;
  canSend?: boolean;
}): { localpart: string; domain: string; canSend: boolean } {
  let rawLocal = input.localpart?.trim().toLowerCase() ?? "";
  let rawDomain = input.domain?.trim().toLowerCase() ?? "";
  if (input.address !== undefined && input.address.trim().length > 0) {
    const addr = input.address.trim().toLowerCase();
    const at = addr.lastIndexOf("@");
    if (at <= 0 || at === addr.length - 1) {
      throw new UserError("invalid allocation address");
    }
    rawLocal = addr.slice(0, at).trim();
    rawDomain = addr.slice(at + 1).trim();
  }
  const domain = normalizeDomain(rawDomain);
  const localpart = normalizeAllocationLocalpart(rawLocal);
  return {
    localpart,
    domain,
    canSend: input.canSend !== false,
  };
}

export function normalizeAllocationLocalpart(raw: string): string {
  const local = raw.trim().toLowerCase();
  if (!local || local.length > 64) throw new UserError("invalid mailbox localpart");
  if (local === "*") return "*";
  if (local.endsWith("*")) {
    if (!LOCALPART_PREFIX_RE.test(local)) throw new UserError("invalid mailbox prefix");
    const stem = local.slice(0, -1);
    if (stem.startsWith(".") || stem.includes("..")) throw new UserError("invalid mailbox prefix");
    return local;
  }
  if (!LOCALPART_EXACT_RE.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    throw new UserError("invalid mailbox localpart");
  }
  return local;
}

export function allocationMatchesAddress(
  alloc: { localpart: string; domain: string },
  rawAddress: string,
  options: { allowSubaddress?: boolean } = {},
): boolean {
  const text = rawAddress.trim().toLowerCase();
  const at = text.lastIndexOf("@");
  if (at <= 0) return false;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1).replace(/\.$/, "");
  if (domain !== alloc.domain.toLowerCase()) return false;
  const rule = alloc.localpart.toLowerCase();
  if (rule === "*") return true;
  if (rule.endsWith("*")) {
    const prefix = rule.slice(0, -1);
    return prefix.length > 0 && local.startsWith(prefix);
  }
  if (local === rule) return true;
  if (options.allowSubaddress !== false && local.startsWith(`${rule}+`) && local.length > rule.length + 1) {
    return true;
  }
  return false;
}

export function canMemberUseAddress(
  db: Db,
  userId: string,
  address: string,
  requireSend = false,
): boolean {
  const rows = listUserAllocations(db, userId);
  return rows.some((row) => {
    if (requireSend && row.can_send !== 1) return false;
    return allocationMatchesAddress(row, address, { allowSubaddress: true });
  });
}

export function canMemberViewMessage(db: Db, userId: string, messageId: string): boolean {
  const sql = `
    SELECT 1 AS ok
    FROM messages m
    LEFT JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
    WHERE m.id = :messageId
      AND ums.deleted_at IS NULL
      AND ${memberMessageMatchSql("m", ":viewerUserId")}
    LIMIT 1
  `;
  return Boolean(db.prepare(sql).get({ viewerUserId: userId, messageId }));
}

export function canMemberViewAttachment(db: Db, userId: string, sha256: string): boolean {
  const sql = `
    SELECT 1 AS ok
    FROM message_attachments ma
    JOIN messages m ON m.id = ma.message_id
    LEFT JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
    WHERE ma.sha256 = :sha256
      AND ums.deleted_at IS NULL
      AND ${memberMessageMatchSql("m", ":viewerUserId")}
    LIMIT 1
  `;
  return Boolean(db.prepare(sql).get({ viewerUserId: userId, sha256 }));
}

export function getUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getUserByUsername(db: Db, username: string): UserRow | undefined {
  return db
    .prepare("SELECT * FROM users WHERE lower(username) = lower(?)")
    .get(username.trim()) as UserRow | undefined;
}

export function findUserForPasswordReset(db: Db, email: string): UserRow | undefined {
  const clean = email.trim().toLowerCase();
  const direct = getUserByUsername(db, clean);
  if (direct && direct.status === "active") return direct;
  const at = clean.lastIndexOf("@");
  if (at <= 0) return undefined;
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  const byAlloc = db
    .prepare(
      `SELECT u.*
       FROM users u
       JOIN user_allocations ua ON ua.user_id = u.id
       WHERE u.status = 'active'
         AND ua.domain = ?
         AND ua.localpart = ?
       ORDER BY u.created_at ASC
       LIMIT 1`,
    )
    .get(domain, local) as UserRow | undefined;
  return byAlloc;
}

export function authenticateManagedUser(
  db: Db,
  username: string,
  password: string,
  now: number,
): SessionPrincipal | null {
  const user = getUserByUsername(db, username);
  if (!user || user.status !== "active") return null;
  if (!passwordMatches(password, user.password_hash)) return null;
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, user.id);
  return toPrincipal(user);
}

export function toPrincipal(user: UserRow): SessionPrincipal {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role === "admin" ? "admin" : "member",
    isOwner: false,
    quotaSendDay: user.quota_send_day,
  };
}

export function ownerPrincipal(ownerUsername: string): SessionPrincipal {
  return {
    id: OWNER_USER_ID,
    username: ownerUsername,
    displayName: null,
    role: "admin",
    isOwner: true,
    quotaSendDay: 10_000,
  };
}

export function resolveSessionPrincipal(
  db: Db,
  ownerUsername: string,
  sessionData: { user?: string; userId?: string },
): SessionPrincipal | null {
  if (!sessionData.user) return null;
  if (
    sessionData.userId === OWNER_USER_ID ||
    (!sessionData.userId && sessionData.user.toLowerCase() === ownerUsername.toLowerCase())
  ) {
    return ownerPrincipal(ownerUsername);
  }
  const row = sessionData.userId
    ? getUserById(db, sessionData.userId)
    : getUserByUsername(db, sessionData.user);
  if (!row || row.status !== "active") return null;
  return toPrincipal(row);
}

export function listUserAllocations(db: Db, userId: string): AllocationRow[] {
  return db
    .prepare(
      `SELECT id, user_id, localpart, domain, can_send, created_at
       FROM user_allocations
       WHERE user_id = ?
       ORDER BY domain ASC, localpart ASC`,
    )
    .all(userId) as AllocationRow[];
}

export function presentAllocation(row: AllocationRow): AllocationPublic {
  const kind = row.localpart === "*" ? "domain" : row.localpart.endsWith("*") ? "prefix" : "exact";
  return {
    id: row.id,
    localpart: row.localpart,
    domain: row.domain,
    pattern: `${row.localpart}@${row.domain}`,
    kind,
    canSend: row.can_send === 1,
    createdAt: row.created_at,
  };
}

export function createUser(
  db: Db,
  ownerUsername: string,
  input: {
    username: string;
    displayName?: string | null;
    password: string;
    role?: UserRole;
    quotaSendDay?: number;
    notes?: string | null;
    allocations?: ReadonlyArray<{ address?: string; localpart?: string; domain?: string; canSend?: boolean }>;
  },
  now: number,
): UserSummaryPublic {
  const username = normalizeUsername(input.username);
  if (username.toLowerCase() === ownerUsername.trim().toLowerCase()) {
    throw new UserError("username reserved by owner", "conflict");
  }
  if (getUserByUsername(db, username)) {
    throw new UserError("username already exists", "conflict");
  }
  validatePassword(input.password, username);
  const displayName = cleanOptionalText(input.displayName, 40, "display name");
  const notes = cleanOptionalText(input.notes, 300, "notes");
  const role: UserRole = input.role === "admin" ? "admin" : "member";
  const quotaSendDay = normalizeQuota(input.quotaSendDay ?? 100);
  const specs = (input.allocations ?? []).map(parseAllocationSpec);
  const id = ulid();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (
        id, username, display_name, password_hash, role, status, quota_send_day, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(id, username, displayName, hashPassword(input.password), role, quotaSendDay, notes, now, now);

    const insertAlloc = db.prepare(
      `INSERT INTO user_allocations (id, user_id, localpart, domain, can_send, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, localpart, domain) DO UPDATE SET can_send = excluded.can_send`,
    );
    for (const spec of specs) {
      insertAlloc.run(ulid(), id, spec.localpart, spec.domain, spec.canSend ? 1 : 0, now);
    }
  })();

  const created = getUserById(db, id);
  if (!created) throw new Error("failed to read created user");
  return buildUserSummary(db, created, now);
}

export function updateUser(
  db: Db,
  id: string,
  input: {
    displayName?: string | null;
    role?: UserRole;
    status?: UserStatus;
    quotaSendDay?: number;
    notes?: string | null;
  },
  now: number,
): UserSummaryPublic {
  if (id === OWNER_USER_ID) throw new UserError("cannot modify owner record here", "forbidden");
  const current = getUserById(db, id);
  if (!current) throw new UserError("user not found", "not_found");
  const displayName =
    input.displayName === undefined ? current.display_name : cleanOptionalText(input.displayName, 40, "display name");
  const notes = input.notes === undefined ? current.notes : cleanOptionalText(input.notes, 300, "notes");
  const role: UserRole = input.role ?? current.role;
  const status: UserStatus = input.status ?? current.status;
  const quotaSendDay = input.quotaSendDay === undefined ? current.quota_send_day : normalizeQuota(input.quotaSendDay);

  db.prepare(
    `UPDATE users
     SET display_name = ?, role = ?, status = ?, quota_send_day = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
  ).run(displayName, role, status, quotaSendDay, notes, now, id);

  const updated = getUserById(db, id)!;
  return buildUserSummary(db, updated, now);
}

export function updateUserPassword(db: Db, id: string, nextPassword: string, now: number): UserRow {
  if (id === OWNER_USER_ID) throw new UserError("owner uses settings password", "forbidden");
  const current = getUserById(db, id);
  if (!current) throw new UserError("user not found", "not_found");
  validatePassword(nextPassword, current.username);
  db.prepare(
    `UPDATE users SET password_hash = ?, reset_seal = NULL, updated_at = ? WHERE id = ?`,
  ).run(hashPassword(nextPassword), now, id);
  return getUserById(db, id)!;
}

export function readUserResetSeal(row: UserRow): ResetSeal | null {
  if (!row.reset_seal) return null;
  try {
    const parsed = JSON.parse(row.reset_seal) as Record<string, unknown>;
    if (
      typeof parsed.salt !== "string" ||
      typeof parsed.hash !== "string" ||
      !Number.isFinite(parsed.expiresAt) ||
      !Number.isFinite(parsed.attempts) ||
      !Number.isFinite(parsed.sentAt)
    ) {
      return null;
    }
    return {
      salt: parsed.salt,
      hash: parsed.hash,
      expiresAt: parsed.expiresAt as number,
      attempts: parsed.attempts as number,
      sentAt: parsed.sentAt as number,
    };
  } catch {
    return null;
  }
}

export function saveUserResetSeal(db: Db, userId: string, seal: ResetSeal | null, now: number): void {
  db.prepare("UPDATE users SET reset_seal = ?, updated_at = ? WHERE id = ?").run(
    seal ? JSON.stringify(seal) : null,
    now,
    userId,
  );
}

export function deleteUser(db: Db, id: string): UserRow {
  if (id === OWNER_USER_ID) throw new UserError("cannot delete owner", "forbidden");
  const current = getUserById(db, id);
  if (!current) throw new UserError("user not found", "not_found");
  db.transaction(() => {
    db.prepare("DELETE FROM user_allocations WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_message_state WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_settings WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  })();
  return current;
}

export function addUserAllocation(
  db: Db,
  userId: string,
  specInput: { address?: string; localpart?: string; domain?: string; canSend?: boolean },
  now: number,
): AllocationPublic {
  const user = getUserById(db, userId);
  if (!user) throw new UserError("user not found", "not_found");
  const spec = parseAllocationSpec(specInput);
  const existing = db
    .prepare("SELECT * FROM user_allocations WHERE user_id = ? AND localpart = ? AND domain = ?")
    .get(userId, spec.localpart, spec.domain) as AllocationRow | undefined;
  if (existing) {
    db.prepare("UPDATE user_allocations SET can_send = ? WHERE id = ?").run(spec.canSend ? 1 : 0, existing.id);
    return presentAllocation({ ...existing, can_send: spec.canSend ? 1 : 0 });
  }
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM user_allocations WHERE user_id = ?").get(userId) as { n: number }
  ).n;
  if (count >= 100) throw new UserError("too many allocations for user");
  const id = ulid();
  db.prepare(
    `INSERT INTO user_allocations (id, user_id, localpart, domain, can_send, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, spec.localpart, spec.domain, spec.canSend ? 1 : 0, now);
  return presentAllocation({
    id,
    user_id: userId,
    localpart: spec.localpart,
    domain: spec.domain,
    can_send: spec.canSend ? 1 : 0,
    created_at: now,
  });
}

export function updateUserAllocation(
  db: Db,
  userId: string,
  allocId: string,
  canSend: boolean,
): AllocationPublic {
  const row = db
    .prepare("SELECT * FROM user_allocations WHERE id = ? AND user_id = ?")
    .get(allocId, userId) as AllocationRow | undefined;
  if (!row) throw new UserError("allocation not found", "not_found");
  db.prepare("UPDATE user_allocations SET can_send = ? WHERE id = ?").run(canSend ? 1 : 0, allocId);
  return presentAllocation({ ...row, can_send: canSend ? 1 : 0 });
}

export function removeUserAllocation(db: Db, userId: string, allocId: string): boolean {
  const res = db.prepare("DELETE FROM user_allocations WHERE id = ? AND user_id = ?").run(allocId, userId);
  return res.changes === 1;
}

export function countUserSentSince(db: Db, userId: string, sinceMs: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND created_at >= ?")
    .get(userId, sinceMs) as { n: number };
  return row.n;
}

export function listUsersWithStats(
  db: Db,
  ownerUsername: string,
  acceptDomains: readonly string[],
  now: number,
): UserSummaryPublic[] {
  const since24h = now - 86_400_000;
  const globalTotal = (
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE trashed_at IS NULL").get() as { n: number }
  ).n;
  const globalUnread = (
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE trashed_at IS NULL AND read_at IS NULL").get() as { n: number }
  ).n;
  const ownerSent = (
    db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE (user_id IS NULL OR user_id = 'owner') AND created_at >= ?").get(since24h) as { n: number }
  ).n;

  const ownerEntry: UserSummaryPublic = {
    id: OWNER_USER_ID,
    username: ownerUsername,
    displayName: "主管理员",
    role: "admin",
    status: "active",
    isOwner: true,
    quotaSendDay: 10_000,
    sentLast24h: ownerSent,
    messageCount: globalTotal,
    unreadCount: globalUnread,
    notes: "环境变量根账号，拥有全局域与管理权限",
    createdAt: null,
    lastLoginAt: null,
    allocations: acceptDomains.map((domain, index) => ({
      id: `owner:${index}`,
      localpart: "*",
      domain,
      pattern: `*@${domain}`,
      kind: "domain",
      canSend: true,
      createdAt: 0,
    })),
  };

  const rows = db.prepare("SELECT * FROM users ORDER BY created_at ASC").all() as UserRow[];
  return [ownerEntry, ...rows.map((row) => buildUserSummary(db, row, now))];
}

export function buildUserSummary(db: Db, row: UserRow, now: number): UserSummaryPublic {
  const allocations = listUserAllocations(db, row.id).map(presentAllocation);
  const since24h = now - 86_400_000;
  const sentLast24h = countUserSentSince(db, row.id, since24h);

  let messageCount = 0;
  let unreadCount = 0;
  if (row.role === "admin") {
    messageCount = (
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE trashed_at IS NULL").get() as { n: number }
    ).n;
    unreadCount = (
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE trashed_at IS NULL AND read_at IS NULL").get() as { n: number }
    ).n;
  } else if (allocations.length > 0) {
    const counts = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN ums.read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread
         FROM messages m
         LEFT JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
         WHERE ums.deleted_at IS NULL
           AND ums.trashed_at IS NULL
           AND ${memberMessageMatchSql("m", ":viewerUserId")}`,
      )
      .get({ viewerUserId: row.id }) as { total: number; unread: number } | undefined;
    messageCount = counts?.total ?? 0;
    unreadCount = counts?.unread ?? 0;
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role === "admin" ? "admin" : "member",
    status: row.status === "disabled" ? "disabled" : "active",
    isOwner: false,
    quotaSendDay: row.quota_send_day,
    sentLast24h,
    messageCount,
    unreadCount,
    notes: row.notes,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    allocations,
  };
}

// --- Per-User Personal Settings (Blocked Senders & Sender Display Names) ---

const USER_BLOCKED_KEY = "blocked_senders";
const USER_SENDERS_KEY = "sender_names";

export function readUserBlockedSenders(db: Db, userId: string): string[] {
  const raw = readUserSettingRaw(db, userId, USER_BLOCKED_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeAddressList(parsed.filter((item): item is string => typeof item === "string"), false);
  } catch {
    return [];
  }
}

export function saveUserBlockedSenders(db: Db, userId: string, addresses: readonly string[], now: number): string[] {
  const normalized = normalizeAddressList(addresses, true);
  writeUserSettingRaw(db, userId, USER_BLOCKED_KEY, JSON.stringify(normalized), now);
  return normalized;
}

export function readUserSenderNames(db: Db, userId: string): SenderName[] {
  const raw = readUserSettingRaw(db, userId, USER_SENDERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SenderName[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const address = (item as { address?: unknown }).address;
      const name = (item as { name?: unknown }).name;
      if (typeof address !== "string" || typeof name !== "string") continue;
      try {
        out.push({ address: normalizeSingleAddress(address), name: cleanRequiredText(name, 40, "sender name") });
      } catch {
        continue;
      }
    }
    return out.slice(0, 200);
  } catch {
    return [];
  }
}

export function saveUserSenderNames(db: Db, userId: string, input: readonly SenderName[], now: number): SenderName[] {
  if (input.length > 200) throw new SettingsError("at most 200 sender names");
  const map = new Map<string, string>();
  for (const item of input) {
    map.set(normalizeSingleAddress(item.address), cleanRequiredText(item.name, 40, "sender name"));
  }
  const saved = [...map]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([address, name]) => ({ address, name }));
  writeUserSettingRaw(db, userId, USER_SENDERS_KEY, JSON.stringify(saved), now);
  return saved;
}

/**
 * During inbound parse, auto-trash messages in `user_message_state` for any active member
 * whose personal blocklist matches the sender and whose allocations match the recipient.
 */
export function applyMemberBlocklistsOnInbound(
  db: Db,
  messageId: string,
  senderAddresses: readonly (string | null | undefined)[],
  recipientAddresses: readonly string[],
  now: number,
): void {
  const senders = senderAddresses
    .map((addr) => (addr ? addr.trim().toLowerCase() : ""))
    .filter(Boolean);
  if (senders.length === 0 || recipientAddresses.length === 0) return;

  const rows = db
    .prepare(
      `SELECT us.user_id, us.value
       FROM user_settings us
       JOIN users u ON u.id = us.user_id
       WHERE us.key = 'blocked_senders' AND u.status = 'active' AND u.role = 'member'`,
    )
    .all() as Array<{ user_id: string; value: string }>;

  if (rows.length === 0) return;

  const upsertTrash = db.prepare(
    `INSERT INTO user_message_state (user_id, message_id, trashed_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET trashed_at = excluded.trashed_at, updated_at = excluded.updated_at`,
  );

  for (const row of rows) {
    let blocked: string[] = [];
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (Array.isArray(parsed)) blocked = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      continue;
    }
    if (!senders.some((s) => blocked.includes(s))) continue;
    const allocs = listUserAllocations(db, row.user_id);
    if (allocs.some((alloc) => recipientAddresses.some((rcpt) => allocationMatchesAddress(alloc, rcpt)))) {
      upsertTrash.run(row.user_id, messageId, now, now);
    }
  }
}

function readUserSettingRaw(db: Db, userId: string, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?")
    .get(userId, key) as { value: string } | undefined;
  return row ? row.value : null;
}

function writeUserSettingRaw(db: Db, userId: string, key: string, value: string, now: number): void {
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(userId, key, value, now);
}

function validatePassword(password: string, username: string): void {
  if (password.length < 8 || password.length > 200) {
    throw new UserError("password must be 8 to 200 characters");
  }
  const lower = password.toLowerCase();
  if (lower === "admin" || lower === "password" || lower === "12345678" || lower === username.toLowerCase()) {
    throw new UserError("password is too weak");
  }
}

function normalizeQuota(raw: number): number {
  if (!Number.isInteger(raw) || raw < 0 || raw > 100_000) {
    throw new UserError("quota must be an integer from 0 to 100000");
  }
  return raw;
}

function cleanOptionalText(value: string | null | undefined, max: number, label: string): string | null {
  if (value === undefined || value === null) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length > max || CONTROL_RE.test(cleaned)) {
    throw new UserError(`${label} is invalid`);
  }
  return cleaned;
}

function cleanRequiredText(value: string, max: number, label: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > max || CONTROL_RE.test(cleaned)) {
    throw new SettingsError(`${label} must be 1 to ${max} characters`);
  }
  return cleaned;
}

function normalizeSingleAddress(raw: string): string {
  const text = raw.trim().toLowerCase();
  const match = ADDRESS_SIMPLE_RE.exec(text);
  if (!match || text.includes("*")) throw new SettingsError(`invalid sender address (${raw})`);
  let domain: string;
  try {
    domain = normalizeDomain(match[1] ?? "");
  } catch {
    throw new SettingsError(`invalid sender address (${raw})`);
  }
  const at = text.lastIndexOf("@");
  return `${text.slice(0, at)}@${domain}`;
}

function normalizeAddressList(addresses: readonly string[], strict: boolean): string[] {
  if (addresses.length > 500) throw new SettingsError("at most 500 blocked senders");
  const out: string[] = [];
  for (const raw of addresses) {
    try {
      const normalized = normalizeSingleAddress(raw);
      if (!out.includes(normalized)) out.push(normalized);
    } catch (err) {
      if (strict) throw err;
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}
