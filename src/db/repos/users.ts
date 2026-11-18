import { ulid } from "ulid";
import { ConfigError, parseAcceptDomains } from "../../config.js";
import { normalizeAddress } from "../../mail/address.js";
import type { Db } from "../index.js";

export const OWNER_USER_ID = "owner";
export const DEFAULT_DAILY_SEND_QUOTA = 100;
export const MAX_DAILY_SEND_QUOTA = 10_000;

export type UserRole = "admin" | "member";
export type UserStatus = "active" | "disabled";

const USERNAME_RE = /^[a-zA-Z0-9._@+-]{2,128}$/;
const LOCALPART_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

export class UserError extends Error {
  readonly code: "bad_request" | "conflict" | "not_found";

  constructor(message: string, code: "bad_request" | "conflict" | "not_found" = "bad_request") {
    super(message);
    this.name = "UserError";
    this.code = code;
  }
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  recovery_email: string | null;
  role: UserRole;
  password_hash: string;
  status: UserStatus;
  quota_send_per_day: number;
  notes: string | null;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface UserMailboxRow {
  id: string;
  user_id: string;
  localpart: string;
  domain: string;
  display_name: string | null;
  notes: string | null;
  can_send: number;
  created_at: number;
}

export interface PublicMailbox {
  id: string;
  userId: string;
  localpart: string;
  domain: string;
  address: string;
  displayName: string | null;
  notes: string | null;
  canSend: boolean;
  dkimSigned: boolean;
  createdAt: number;
}

export interface UserMailStats {
  totalMessages: number;
  unreadMessages: number;
  sentToday: number;
  totalSent: number;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  recoveryEmail: string | null;
  role: UserRole;
  status: UserStatus;
  quotaSendPerDay: number;
  notes: string | null;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
  mailboxes: PublicMailbox[];
  stats: UserMailStats;
}

/**
 * SQLite scalar subquery that resolves an email string expression (e.g. `je.value`)
 * to `user_mailboxes.user_id` with deterministic specificity priority:
 * 1. Exact `localpart@domain`
 * 2. Base `localpart` before `+tag` (RFC 5233 subaddressing)
 * 3. Whole-domain catch-all `*@domain`
 * Returns NULL when unallocated (owned by primary `'owner'`).
 */
export function sqlResolvedOwner(addrExpr: string): string {
  const trimmed = `trim(${addrExpr})`;
  const atPos = `instr(${trimmed}, '@')`;
  const rawLocal = `lower(trim(substr(${trimmed}, 1, ${atPos} - 1)))`;
  const rawDomain = `lower(trim(substr(${trimmed}, ${atPos} + 1)))`;
  const plusPos = `instr(${rawLocal}, '+')`;
  const baseLocal = `CASE WHEN ${plusPos} > 1 THEN substr(${rawLocal}, 1, ${plusPos} - 1) ELSE ${rawLocal} END`;
  return `(
    SELECT um.user_id
    FROM user_mailboxes um
    WHERE ${atPos} > 1
      AND um.domain = ${rawDomain}
      AND um.localpart IN ('*', ${rawLocal}, ${baseLocal})
    ORDER BY CASE
      WHEN um.localpart = ${rawLocal} THEN 1
      WHEN um.localpart = '*' THEN 3
      ELSE 2
    END ASC
    LIMIT 1
  )`;
}

export function hasAnyUsers(db: Db): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM users LIMIT 1").get() as { ok: number } | undefined;
  return Boolean(row);
}

export function getUserById(db: Db, id: string): UserRow | undefined {
  if (!id || id === OWNER_USER_ID) return undefined;
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function findUserByUsername(db: Db, usernameRaw: string): UserRow | undefined {
  const clean = usernameRaw.trim();
  if (!clean) return undefined;
  return db
    .prepare("SELECT * FROM users WHERE lower(username) = lower(?)")
    .get(clean) as UserRow | undefined;
}

/** Match an active user whose recovery_email or email-shaped username matches `email`. */
export function findUserForPasswordReset(db: Db, emailRaw: string): UserRow | undefined {
  const email = normalizeAddress(emailRaw);
  if (!email) return undefined;
  return db
    .prepare(
      `SELECT * FROM users
       WHERE status = 'active'
         AND (lower(recovery_email) = lower(?) OR lower(username) = lower(?))
       ORDER BY CASE WHEN lower(recovery_email) = lower(?) THEN 0 ELSE 1 END ASC
       LIMIT 1`,
    )
    .get(email, email, email) as UserRow | undefined;
}

export function touchUserLogin(db: Db, id: string, now: number): void {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, id);
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  displayName?: string | null;
  recoveryEmail?: string | null;
  role?: UserRole;
  quotaSendPerDay?: number;
  notes?: string | null;
  reservedUsername?: string;
  initialMailbox?: {
    localpart: string;
    domain: string;
    displayName?: string | null;
    notes?: string | null;
    canSend?: boolean;
  } | null;
}

export function createUser(db: Db, input: CreateUserInput, now: number, todayStartMs = utcDayStart(now)): PublicUser {
  const username = cleanUsername(input.username, input.reservedUsername);
  const displayName = cleanOptionalText(input.displayName, 40, "display name");
  const recoveryEmail = cleanRecoveryEmail(input.recoveryEmail);
  const role: UserRole = input.role === "admin" ? "admin" : "member";
  const quota = cleanQuota(input.quotaSendPerDay ?? DEFAULT_DAILY_SEND_QUOTA);
  const notes = cleanOptionalText(input.notes, 500, "notes");

  const id = ulid();
  const tx = db.transaction(() => {
    const existing = findUserByUsername(db, username);
    if (existing) throw new UserError("username already exists", "conflict");
    db.prepare(
      `INSERT INTO users (
        id, username, display_name, recovery_email, role, password_hash, status,
        quota_send_per_day, notes, last_login_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`,
    ).run(id, username, displayName, recoveryEmail, role, input.passwordHash, quota, notes, now, now);

    if (input.initialMailbox) {
      allocateMailboxInternal(
        db,
        {
          userId: id,
          localpart: input.initialMailbox.localpart,
          domain: input.initialMailbox.domain,
          displayName: input.initialMailbox.displayName ?? displayName,
          notes: input.initialMailbox.notes ?? null,
          canSend: input.initialMailbox.canSend ?? true,
        },
        now,
      );
    }
  });

  try {
    tx();
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (isUniqueConstraint(err)) throw new UserError("username or mailbox already exists", "conflict");
    throw err;
  }

  const created = presentSingleUser(db, id, todayStartMs);
  if (!created) throw new Error("created user missing");
  return created;
}

export interface UpdateUserPatch {
  displayName?: string | null;
  recoveryEmail?: string | null;
  role?: UserRole;
  status?: UserStatus;
  quotaSendPerDay?: number;
  notes?: string | null;
}

export function updateUser(
  db: Db,
  id: string,
  patch: UpdateUserPatch,
  now: number,
  todayStartMs = utcDayStart(now),
): PublicUser {
  const current = getUserById(db, id);
  if (!current) throw new UserError("user not found", "not_found");

  const displayName =
    patch.displayName === undefined ? current.display_name : cleanOptionalText(patch.displayName, 40, "display name");
  const recoveryEmail =
    patch.recoveryEmail === undefined ? current.recovery_email : cleanRecoveryEmail(patch.recoveryEmail);
  const role: UserRole =
    patch.role === undefined ? current.role : patch.role === "admin" ? "admin" : "member";
  const status: UserStatus =
    patch.status === undefined ? current.status : patch.status === "disabled" ? "disabled" : "active";
  const quota =
    patch.quotaSendPerDay === undefined ? current.quota_send_per_day : cleanQuota(patch.quotaSendPerDay);
  const notes = patch.notes === undefined ? current.notes : cleanOptionalText(patch.notes, 500, "notes");

  db.prepare(
    `UPDATE users
     SET display_name = ?, recovery_email = ?, role = ?, status = ?,
         quota_send_per_day = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
  ).run(displayName, recoveryEmail, role, status, quota, notes, now, id);

  const updated = presentSingleUser(db, id, todayStartMs);
  if (!updated) throw new UserError("user not found", "not_found");
  return updated;
}

export function updateUserPassword(db: Db, id: string, passwordHash: string, now: number): boolean {
  const res = db
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(passwordHash, now, id);
  return res.changes === 1;
}

export function deleteUser(db: Db, id: string): boolean {
  if (!id || id === OWNER_USER_ID) return false;
  return db.transaction(() => {
    db.prepare("DELETE FROM user_message_state WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_mailboxes WHERE user_id = ?").run(id);
    const res = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return res.changes === 1;
  })();
}

export interface AllocateMailboxInput {
  userId: string;
  localpart: string;
  domain: string;
  displayName?: string | null;
  notes?: string | null;
  canSend?: boolean;
}

export function allocateMailbox(db: Db, input: AllocateMailboxInput, now: number): PublicMailbox {
  const user = getUserById(db, input.userId);
  if (!user) throw new UserError("user not found", "not_found");
  try {
    const row = allocateMailboxInternal(db, input, now);
    const signedDomains = dkimDomainSet(db);
    return toPublicMailbox(row, signedDomains.has(row.domain));
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (isUniqueConstraint(err)) throw new UserError("mailbox already allocated", "conflict");
    throw err;
  }
}

function allocateMailboxInternal(db: Db, input: AllocateMailboxInput, now: number): UserMailboxRow {
  const localpart = cleanLocalpart(input.localpart);
  const domain = cleanDomain(input.domain);
  const displayName = cleanOptionalText(input.displayName, 40, "display name");
  const notes = cleanOptionalText(input.notes, 500, "notes");
  const canSend = input.canSend === false ? 0 : 1;
  const existing = db
    .prepare("SELECT id, user_id FROM user_mailboxes WHERE localpart = ? AND domain = ?")
    .get(localpart, domain) as { id: string; user_id: string } | undefined;
  if (existing) throw new UserError("mailbox already allocated", "conflict");

  const id = ulid();
  db.prepare(
    `INSERT INTO user_mailboxes (id, user_id, localpart, domain, display_name, notes, can_send, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.userId, localpart, domain, displayName, notes, canSend, now);

  return {
    id,
    user_id: input.userId,
    localpart,
    domain,
    display_name: displayName,
    notes,
    can_send: canSend,
    created_at: now,
  };
}

export function updateUserMailbox(
  db: Db,
  userId: string,
  mailboxId: string,
  patch: { displayName?: string | null; notes?: string | null; canSend?: boolean },
): PublicMailbox {
  const row = db
    .prepare("SELECT * FROM user_mailboxes WHERE id = ? AND user_id = ?")
    .get(mailboxId, userId) as UserMailboxRow | undefined;
  if (!row) throw new UserError("mailbox not found", "not_found");

  const displayName =
    patch.displayName === undefined ? row.display_name : cleanOptionalText(patch.displayName, 40, "display name");
  const notes = patch.notes === undefined ? row.notes : cleanOptionalText(patch.notes, 500, "notes");
  const canSend = patch.canSend === undefined ? row.can_send : patch.canSend ? 1 : 0;

  db.prepare(
    "UPDATE user_mailboxes SET display_name = ?, notes = ?, can_send = ? WHERE id = ? AND user_id = ?",
  ).run(displayName, notes, canSend, mailboxId, userId);

  const signedDomains = dkimDomainSet(db);
  return toPublicMailbox(
    { ...row, display_name: displayName, notes, can_send: canSend },
    signedDomains.has(row.domain),
  );
}

export function revokeMailbox(db: Db, userId: string, mailboxId: string): boolean {
  const res = db.prepare("DELETE FROM user_mailboxes WHERE id = ? AND user_id = ?").run(mailboxId, userId);
  return res.changes === 1;
}

export function listUserMailboxes(db: Db, userId: string): PublicMailbox[] {
  const signedDomains = dkimDomainSet(db);
  const rows = db
    .prepare("SELECT * FROM user_mailboxes WHERE user_id = ? ORDER BY domain ASC, localpart ASC")
    .all(userId) as UserMailboxRow[];
  return rows.map((row) => toPublicMailbox(row, signedDomains.has(row.domain)));
}

export function listUsersWithDetails(db: Db, todayStartMs = utcDayStart(Date.now())): PublicUser[] {
  const users = db.prepare("SELECT * FROM users ORDER BY created_at ASC").all() as UserRow[];
  if (users.length === 0) return [];
  const signedDomains = dkimDomainSet(db);
  const allBoxes = db
    .prepare("SELECT * FROM user_mailboxes ORDER BY domain ASC, localpart ASC")
    .all() as UserMailboxRow[];
  const boxMap = new Map<string, PublicMailbox[]>();
  for (const box of allBoxes) {
    const list = boxMap.get(box.user_id) ?? [];
    list.push(toPublicMailbox(box, signedDomains.has(box.domain)));
    boxMap.set(box.user_id, list);
  }
  return users.map((user) => ({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    recoveryEmail: user.recovery_email,
    role: user.role,
    status: user.status,
    quotaSendPerDay: user.quota_send_per_day,
    notes: user.notes,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    mailboxes: boxMap.get(user.id) ?? [],
    stats: computeUserMailStats(db, user.id, todayStartMs),
  }));
}

function presentSingleUser(db: Db, userId: string, todayStartMs: number): PublicUser | undefined {
  const user = getUserById(db, userId);
  if (!user) return undefined;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    recoveryEmail: user.recovery_email,
    role: user.role,
    status: user.status,
    quotaSendPerDay: user.quota_send_per_day,
    notes: user.notes,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    mailboxes: listUserMailboxes(db, user.id),
    stats: computeUserMailStats(db, user.id, todayStartMs),
  };
}

function computeUserMailStats(db: Db, userId: string, todayStartMs: number): UserMailStats {
  const resolved = sqlResolvedOwner("je.value");
  const msgRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE
           WHEN ums.trashed_at IS NULL
            AND ums.read_at IS NULL
            AND (
              COALESCE(ums.manual_label, json_extract(m.ai_result, '$.label')) IS NULL
              OR COALESCE(ums.manual_label, json_extract(m.ai_result, '$.label')) = 'legit'
            )
           THEN 1 ELSE 0 END), 0) AS unread
       FROM messages m
       LEFT JOIN user_message_state ums ON ums.user_id = :uid AND ums.message_id = m.id
       WHERE ums.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM json_each(m.envelope_to) je
           WHERE ${resolved} = :uid
         )`,
    )
    .get({ uid: userId }) as { total: number; unread: number } | undefined;

  const sentRow = db
    .prepare(
      `SELECT
         COUNT(*) AS totalSent,
         COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS sentToday
       FROM outbox
       WHERE user_id = ?`,
    )
    .get(todayStartMs, userId) as { totalSent: number; sentToday: number } | undefined;

  return {
    totalMessages: msgRow?.total ?? 0,
    unreadMessages: msgRow?.unread ?? 0,
    sentToday: sentRow?.sentToday ?? 0,
    totalSent: sentRow?.totalSent ?? 0,
  };
}

/** Resolve an address to the winning `user_mailboxes` row, or undefined if unallocated. */
export function findWinningAllocation(db: Db, rawAddress: string): UserMailboxRow | undefined {
  const parts = splitNormalized(rawAddress);
  if (!parts) return undefined;
  return db
    .prepare(
      `SELECT * FROM user_mailboxes
       WHERE domain = ? AND localpart IN ('*', ?, ?)
       ORDER BY CASE
         WHEN localpart = ? THEN 1
         WHEN localpart = '*' THEN 3
         ELSE 2
       END ASC
       LIMIT 1`,
    )
    .get(parts.domain, parts.localpart, parts.baseLocalpart, parts.localpart) as UserMailboxRow | undefined;
}

/** Resolve an address to its owner userId, or `OWNER_USER_ID` ('owner') when unallocated. */
export function resolveAddressOwner(db: Db, rawAddress: string): string {
  const winner = findWinningAllocation(db, rawAddress);
  return winner ? winner.user_id : OWNER_USER_ID;
}

/**
 * Check whether a non-admin member may send `From` a given address.
 * Because we resolve by specificity first, a wildcard `*@domain` owner cannot
 * spoof a more specific `alice@domain` allocated to another user.
 */
export function canMemberSendFrom(db: Db, userId: string, fromAddress: string): boolean {
  const normalized = normalizeAddress(fromAddress);
  if (!normalized) return false;
  const winner = findWinningAllocation(db, normalized);
  if (!winner) return false;
  return winner.user_id === userId && winner.can_send === 1;
}

/** Resolve the From display name for a sending user + address. */
export function findSenderDisplayNameForUser(db: Db, userId: string, fromAddress: string): string | undefined {
  if (userId === OWNER_USER_ID) return undefined;
  const winner = findWinningAllocation(db, fromAddress);
  if (winner && winner.user_id === userId && winner.display_name) {
    return winner.display_name;
  }
  const user = getUserById(db, userId);
  return user?.display_name ?? undefined;
}

/** Look up operator/member notes on an allocated mailbox for AI classification telemetry. */
export function findAllocatedMailboxNote(
  db: Db,
  domain: string,
  localpart: string,
): { created_at: number; notes: string | null } | undefined {
  const row = findWinningAllocation(db, `${localpart.toLowerCase()}@${domain.toLowerCase()}`);
  if (!row || !row.notes) return undefined;
  return { created_at: row.created_at, notes: row.notes };
}

function toPublicMailbox(row: UserMailboxRow, dkimSigned: boolean): PublicMailbox {
  return {
    id: row.id,
    userId: row.user_id,
    localpart: row.localpart,
    domain: row.domain,
    address: `${row.localpart}@${row.domain}`,
    displayName: row.display_name,
    notes: row.notes,
    canSend: row.can_send === 1,
    dkimSigned,
    createdAt: row.created_at,
  };
}

function dkimDomainSet(db: Db): Set<string> {
  const rows = db.prepare("SELECT DISTINCT domain FROM dkim_keys").all() as Array<{ domain: string }>;
  return new Set(rows.map((r) => r.domain));
}

function splitNormalized(raw: string): { localpart: string; baseLocalpart: string; domain: string } | null {
  const normalized = normalizeAddress(raw.trim().replace(/^<|>$/, ""));
  if (!normalized) return null;
  const at = normalized.lastIndexOf("@");
  const localpart = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const plus = localpart.indexOf("+");
  const baseLocalpart = plus > 1 ? localpart.slice(0, plus) : localpart;
  return { localpart, baseLocalpart, domain };
}

function cleanUsername(raw: string, reserved?: string): string {
  const text = raw.trim();
  if (!USERNAME_RE.test(text) || CONTROL_RE.test(text)) {
    throw new UserError("invalid username");
  }
  const lower = text.toLowerCase();
  if (lower === OWNER_USER_ID || (reserved && lower === reserved.trim().toLowerCase())) {
    throw new UserError("username is reserved", "conflict");
  }
  return text;
}

function cleanLocalpart(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (text === "*") return "*";
  if (
    !LOCALPART_RE.test(text) ||
    text.startsWith(".") ||
    text.endsWith(".") ||
    text.includes("..")
  ) {
    throw new UserError("invalid mailbox localpart");
  }
  return text;
}

function cleanDomain(raw: string): string {
  try {
    const parsed = parseAcceptDomains(raw);
    const first = parsed[0];
    if (!first || parsed.length !== 1) throw new UserError("invalid mailbox domain");
    return first;
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (err instanceof ConfigError) throw new UserError("invalid mailbox domain");
    throw new UserError("invalid mailbox domain");
  }
}

function cleanRecoveryEmail(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = normalizeAddress(trimmed);
  if (!normalized) throw new UserError("invalid recovery email");
  return normalized;
}

function cleanQuota(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DAILY_SEND_QUOTA) {
    throw new UserError(`daily send quota must be between 0 and ${MAX_DAILY_SEND_QUOTA}`);
  }
  return value;
}

function cleanOptionalText(raw: string | null | undefined, max: number, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length > max || CONTROL_RE.test(cleaned)) {
    throw new UserError(`invalid ${label}`);
  }
  return cleaned;
}

function isUniqueConstraint(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = String(err.code);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
