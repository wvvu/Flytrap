import { ulid } from "ulid";
import type { Db } from "../index.js";
import { ConfigError, parseAcceptDomains } from "../../config.js";
import { credentialsMatch, hashPassword, passwordMatches } from "../../api/password.js";
import { LABELS, type Label } from "../../ai/types.js";
import { normalizeAddress } from "../../mail/address.js";
import { findMailboxHistory } from "./mailbox-history.js";
import {
  DEFAULT_LABEL_NAMES,
  DEFAULT_PANEL_TITLE,
  MAX_BLOCKED_SENDERS,
  MAX_DOMAIN_NAME,
  MAX_LABEL_NAME,
  MAX_PANEL_TITLE,
  MAX_SENDER_NAME,
  MAX_SENDER_NAMES,
  readPasswordHash,
  type SenderName,
} from "./settings.js";

export type UserRole = "admin" | "member";

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  recovery_email: string | null;
  role: UserRole;
  catch_all: number;
  disabled_at: number | null;
  settings_json: string;
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
  can_send: number;
  note: string | null;
  created_at: number;
}

export interface UserMailboxPublic {
  id: string;
  userId: string;
  localpart: string;
  domain: string;
  address: string;
  displayName: string | null;
  canSend: boolean;
  note: string | null;
  createdAt: number;
}

export interface UserPersonalSettings {
  panelTitle: string;
  labelNames: Record<Label, string>;
  domainNames: Record<string, string>;
  senderNames: SenderName[];
  blockedSenders: string[];
  signature: string;
  notifyLabels: Label[];
  notifyMinConfidence: number;
  notifyWebhookUrl: string;
  notifyWebhookBearer: string;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string | null;
  recoveryEmail: string | null;
  role: UserRole;
  catchAll: boolean;
  disabled: boolean;
  disabledAt: number | null;
  lastLoginAt: number | null;
  createdAt: number;
  mailboxes: UserMailboxPublic[];
  messageCount: number;
  unreadCount: number;
  sentCount: number;
}

export class UserError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "UserError";
    this.statusCode = statusCode;
  }
}

const USERNAME_RE = /^[a-zA-Z0-9._@+-]{2,128}$/;
const LOCALPART_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

/**
 * Ensure the configured API_USERNAME exists as an admin account and backfill
 * any unrouted messages from pre-multiuser upgrades into catch-all admins.
 */
export function syncBootstrapAdmin(db: Db, input: { username: string; now?: number }): UserRow {
  const now = input.now ?? Date.now();
  const cleanUser = input.username.trim();
  return db.transaction(() => {
    let admin = findUserByUsername(db, cleanUser);
    const hasCatchAll = Boolean(
      db.prepare("SELECT 1 FROM users WHERE catch_all = 1 AND disabled_at IS NULL LIMIT 1").get(),
    );
    if (!admin) {
      const id = ulid();
      const recovery = normalizeAddress(cleanUser);
      db.prepare(
        `INSERT INTO users (
          id, username, display_name, password_hash, recovery_email, role, catch_all,
          disabled_at, settings_json, created_at, updated_at
        ) VALUES (?, ?, NULL, 'env', ?, 'admin', ?, NULL, '{}', ?, ?)`,
      ).run(id, cleanUser, recovery, hasCatchAll ? 0 : 1, now, now);
      admin = findUserById(db, id)!;
    } else if (admin.role !== "admin") {
      db.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?").run(now, admin.id);
      admin = findUserById(db, admin.id)!;
    }

    if (!hasCatchAll && admin.disabled_at === null && admin.catch_all === 0) {
      db.prepare("UPDATE users SET catch_all = 1, updated_at = ? WHERE id = ?").run(now, admin.id);
      admin = findUserById(db, admin.id)!;
    }

    db.prepare(
      `INSERT OR IGNORE INTO user_messages (user_id, message_id, recipient_addr, received_at, read_at, trashed_at)
       SELECT u.id, m.id, NULL, m.received_at, m.read_at, m.trashed_at
       FROM messages m
       CROSS JOIN users u
       WHERE u.catch_all = 1
         AND NOT EXISTS (SELECT 1 FROM user_messages um WHERE um.message_id = m.id)`,
    ).run();

    return admin;
  })();
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db
    .prepare("SELECT * FROM users WHERE lower(username) = lower(?)")
    .get(username.trim()) as UserRow | undefined;
}

export function findUserForPasswordReset(db: Db, emailRaw: string): UserRow | undefined {
  const email = normalizeAddress(emailRaw);
  if (!email) return undefined;
  const direct = db
    .prepare(
      `SELECT * FROM users
       WHERE disabled_at IS NULL
         AND (lower(username) = lower(?) OR lower(recovery_email) = lower(?))
       ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`,
    )
    .get(email, email) as UserRow | undefined;
  if (direct) return direct;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return db
    .prepare(
      `SELECT u.* FROM user_mailboxes um
       JOIN users u ON u.id = um.user_id
       WHERE u.disabled_at IS NULL AND um.domain = ? AND um.localpart = ?
       ORDER BY u.created_at ASC
       LIMIT 1`,
    )
    .get(domain, local) as UserRow | undefined;
}

export function verifyUserLogin(
  db: Db,
  username: string,
  password: string,
  bootstrapUsername: string,
  bootstrapPassword: string,
  now = Date.now(),
): UserRow | null {
  const candidate = findUserByUsername(db, username);
  if (!candidate || candidate.disabled_at !== null) {
    credentialsMatch(username, password, bootstrapUsername, bootstrapPassword || "placeholder-secret");
    return null;
  }
  let ok = false;
  if (candidate.password_hash === "env") {
    const legacyHash = readPasswordHash(db);
    if (legacyHash) ok = passwordMatches(password, legacyHash);
    else ok = credentialsMatch(candidate.username, password, candidate.username, bootstrapPassword);
  } else {
    ok = passwordMatches(password, candidate.password_hash);
  }
  if (!ok) return null;
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, candidate.id);
  return findUserById(db, candidate.id) ?? candidate;
}

export function updateUserPassword(db: Db, userId: string, nextPassword: string, now = Date.now()): void {
  if (nextPassword.length < 8 || nextPassword.length > 200 || nextPassword === "admin") {
    throw new UserError("invalid password", 400);
  }
  const hashed = hashPassword(nextPassword);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hashed, now, userId);
}

export function listUsersWithStats(db: Db): UserSummary[] {
  const users = db
    .prepare("SELECT * FROM users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC")
    .all() as UserRow[];
  const allMailboxes = db
    .prepare("SELECT * FROM user_mailboxes ORDER BY domain ASC, localpart ASC")
    .all() as UserMailboxRow[];
  const msgStats = db
    .prepare(
      `SELECT um.user_id,
              COUNT(*) AS total,
              COALESCE(SUM(CASE
                WHEN um.read_at IS NULL
                 AND (COALESCE(um.label_override, json_extract(m.ai_result, '$.label')) IS NULL
                      OR COALESCE(um.label_override, json_extract(m.ai_result, '$.label')) = 'legit')
                THEN 1 ELSE 0 END), 0) AS unread
       FROM user_messages um
       JOIN messages m ON m.id = um.message_id
       WHERE um.trashed_at IS NULL
       GROUP BY um.user_id`,
    )
    .all() as Array<{ user_id: string; total: number; unread: number }>;
  const sentStats = db
    .prepare("SELECT user_id, COUNT(*) AS sent FROM outbox WHERE user_id IS NOT NULL GROUP BY user_id")
    .all() as Array<{ user_id: string; sent: number }>;

  const mbMap = new Map<string, UserMailboxPublic[]>();
  for (const mb of allMailboxes) {
    const list = mbMap.get(mb.user_id) ?? [];
    list.push(presentMailbox(mb));
    mbMap.set(mb.user_id, list);
  }
  const msgMap = new Map(msgStats.map((row) => [row.user_id, row] as const));
  const sentMap = new Map(sentStats.map((row) => [row.user_id, row.sent] as const));

  return users.map((u) => {
    const counts = msgMap.get(u.id);
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      recoveryEmail: u.recovery_email,
      role: u.role,
      catchAll: u.catch_all === 1,
      disabled: u.disabled_at !== null,
      disabledAt: u.disabled_at,
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at,
      mailboxes: mbMap.get(u.id) ?? [],
      messageCount: counts?.total ?? 0,
      unreadCount: counts?.unread ?? 0,
      sentCount: sentMap.get(u.id) ?? 0,
    };
  });
}

export interface CreateUserInput {
  username: string;
  password: string;
  displayName?: string | null;
  recoveryEmail?: string | null;
  role?: UserRole;
  catchAll?: boolean;
  mailboxes?: ReadonlyArray<{
    localpart: string;
    domain: string;
    displayName?: string | null;
    canSend?: boolean;
    note?: string | null;
  }>;
  syncHistory?: boolean;
  now?: number;
}

export function createUser(db: Db, input: CreateUserInput): UserSummary {
  const now = input.now ?? Date.now();
  const username = cleanUsername(input.username);
  if (findUserByUsername(db, username)) {
    throw new UserError("username already exists", 409);
  }
  if (input.password.length < 8 || input.password.length > 200 || input.password === "admin") {
    throw new UserError("password must be at least 8 characters", 400);
  }
  const displayName = cleanOptionalText(input.displayName, 40);
  const recoveryEmail = cleanRecoveryEmail(input.recoveryEmail ?? (normalizeAddress(username) ?? null));
  const role: UserRole = input.role === "admin" ? "admin" : "member";
  const catchAll = role === "admin" && input.catchAll === true ? 1 : 0;
  const id = ulid();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (
        id, username, display_name, password_hash, recovery_email, role, catch_all,
        disabled_at, settings_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?)`,
    ).run(id, username, displayName, hashPassword(input.password), recoveryEmail, role, catchAll, now, now);

    for (const mb of input.mailboxes ?? []) {
      addUserMailboxInternal(db, id, mb, Boolean(input.syncHistory), now);
    }
    if (catchAll === 1 && input.syncHistory) {
      db.prepare(
        `INSERT OR IGNORE INTO user_messages (user_id, message_id, recipient_addr, received_at, read_at, trashed_at)
         SELECT ?, m.id, NULL, m.received_at, m.read_at, m.trashed_at FROM messages m`,
      ).run(id);
    }
  })();

  const created = listUsersWithStats(db).find((u) => u.id === id);
  if (!created) throw new UserError("failed to load created user", 500);
  return created;
}

export interface UpdateUserInput {
  displayName?: string | null;
  recoveryEmail?: string | null;
  role?: UserRole;
  catchAll?: boolean;
  disabled?: boolean;
  password?: string;
  now?: number;
}

export function updateUser(db: Db, userId: string, input: UpdateUserInput): { user: UserSummary; revokeSessions: boolean } {
  const now = input.now ?? Date.now();
  const current = findUserById(db, userId);
  if (!current) throw new UserError("user not found", 404);

  const nextRole: UserRole = input.role ?? current.role;
  const nextDisabledAt =
    input.disabled === undefined ? current.disabled_at : input.disabled ? (current.disabled_at ?? now) : null;
  const nextCatchAll =
    nextRole !== "admin"
      ? 0
      : input.catchAll === undefined
        ? current.catch_all
        : input.catchAll
          ? 1
          : 0;

  if (current.role === "admin" && (nextRole !== "admin" || nextDisabledAt !== null)) {
    const otherAdmins = db
      .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != ?")
      .get(userId) as { c: number };
    if (otherAdmins.c === 0) {
      throw new UserError("cannot disable or demote the last active admin", 400);
    }
  }

  const nextDisplayName =
    input.displayName === undefined ? current.display_name : cleanOptionalText(input.displayName, 40);
  const nextRecovery =
    input.recoveryEmail === undefined ? current.recovery_email : cleanRecoveryEmail(input.recoveryEmail);

  let nextPasswordHash = current.password_hash;
  let passwordChanged = false;
  if (input.password !== undefined && input.password !== "") {
    if (input.password.length < 8 || input.password.length > 200 || input.password === "admin") {
      throw new UserError("invalid password", 400);
    }
    nextPasswordHash = hashPassword(input.password);
    passwordChanged = true;
  }

  db.prepare(
    `UPDATE users
     SET display_name = ?, recovery_email = ?, role = ?, catch_all = ?,
         disabled_at = ?, password_hash = ?, updated_at = ?
     WHERE id = ?`,
  ).run(nextDisplayName, nextRecovery, nextRole, nextCatchAll, nextDisabledAt, nextPasswordHash, now, userId);

  const updated = listUsersWithStats(db).find((u) => u.id === userId);
  if (!updated) throw new UserError("user not found", 404);
  const revokeSessions = passwordChanged || (current.disabled_at === null && nextDisabledAt !== null);
  return { user: updated, revokeSessions };
}

export function deleteUser(db: Db, userId: string, actorUserId: string): void {
  if (userId === actorUserId) {
    throw new UserError("cannot delete the currently signed-in account", 400);
  }
  const target = findUserById(db, userId);
  if (!target) throw new UserError("user not found", 404);
  if (target.role === "admin") {
    const otherAdmins = db
      .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != ?")
      .get(userId) as { c: number };
    if (otherAdmins.c === 0) {
      throw new UserError("cannot delete the last active admin", 400);
    }
  }
  db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  })();
}

export function listUserMailboxes(db: Db, userId: string): UserMailboxPublic[] {
  const rows = db
    .prepare("SELECT * FROM user_mailboxes WHERE user_id = ? ORDER BY domain ASC, localpart ASC")
    .all(userId) as UserMailboxRow[];
  return rows.map(presentMailbox);
}

export function addUserMailbox(
  db: Db,
  userId: string,
  input: {
    localpart: string;
    domain: string;
    displayName?: string | null;
    canSend?: boolean;
    note?: string | null;
    syncHistory?: boolean;
  },
  now = Date.now(),
): UserMailboxPublic {
  if (!findUserById(db, userId)) throw new UserError("user not found", 404);
  return db.transaction(() => addUserMailboxInternal(db, userId, input, Boolean(input.syncHistory), now))();
}

function addUserMailboxInternal(
  db: Db,
  userId: string,
  input: {
    localpart: string;
    domain: string;
    displayName?: string | null;
    canSend?: boolean;
    note?: string | null;
  },
  syncHistory: boolean,
  now: number,
): UserMailboxPublic {
  const localpart = cleanMailboxLocalpart(input.localpart);
  const domain = cleanMailboxDomain(input.domain);
  const displayName = cleanOptionalText(input.displayName, 40);
  const note = cleanOptionalText(input.note, 200);
  const canSend = input.canSend === false ? 0 : 1;
  const existing = db
    .prepare("SELECT id FROM user_mailboxes WHERE user_id = ? AND localpart = ? AND domain = ?")
    .get(userId, localpart, domain) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE user_mailboxes SET display_name = ?, can_send = ?, note = ? WHERE id = ?",
    ).run(displayName, canSend, note, existing.id);
    if (syncHistory) syncHistoricalMailForMailbox(db, userId, localpart, domain);
    const updated = db.prepare("SELECT * FROM user_mailboxes WHERE id = ?").get(existing.id) as UserMailboxRow;
    return presentMailbox(updated);
  }
  const id = ulid();
  db.prepare(
    `INSERT INTO user_mailboxes (id, user_id, localpart, domain, display_name, can_send, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, localpart, domain, displayName, canSend, note, now);
  if (syncHistory) syncHistoricalMailForMailbox(db, userId, localpart, domain);
  const created = db.prepare("SELECT * FROM user_mailboxes WHERE id = ?").get(id) as UserMailboxRow;
  return presentMailbox(created);
}

export function updateUserMailbox(
  db: Db,
  userId: string,
  mailboxId: string,
  input: { displayName?: string | null; canSend?: boolean; note?: string | null; syncHistory?: boolean },
): UserMailboxPublic {
  const row = db
    .prepare("SELECT * FROM user_mailboxes WHERE id = ? AND user_id = ?")
    .get(mailboxId, userId) as UserMailboxRow | undefined;
  if (!row) throw new UserError("mailbox not found", 404);
  const displayName = input.displayName === undefined ? row.display_name : cleanOptionalText(input.displayName, 40);
  const canSend = input.canSend === undefined ? row.can_send : input.canSend ? 1 : 0;
  const note = input.note === undefined ? row.note : cleanOptionalText(input.note, 200);
  db.prepare("UPDATE user_mailboxes SET display_name = ?, can_send = ?, note = ? WHERE id = ?").run(
    displayName,
    canSend,
    note,
    mailboxId,
  );
  if (input.syncHistory) syncHistoricalMailForMailbox(db, userId, row.localpart, row.domain);
  const updated = db.prepare("SELECT * FROM user_mailboxes WHERE id = ?").get(mailboxId) as UserMailboxRow;
  return presentMailbox(updated);
}

export function removeUserMailbox(db: Db, userId: string, mailboxId: string): boolean {
  const res = db.prepare("DELETE FROM user_mailboxes WHERE id = ? AND user_id = ?").run(mailboxId, userId);
  return res.changes === 1;
}

export function syncHistoricalMailForMailbox(db: Db, userId: string, localpart: string, domain: string): number {
  if (localpart === "*") {
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO user_messages (user_id, message_id, recipient_addr, received_at, read_at, trashed_at)
         SELECT ?, m.id, lower(trim(je.value)), m.received_at, m.read_at, m.trashed_at
         FROM messages m,
              json_each(CASE WHEN json_valid(m.envelope_to) AND json_type(m.envelope_to) = 'array' THEN m.envelope_to ELSE '[]' END) je
         WHERE instr(trim(je.value), '@') > 1
           AND lower(substr(trim(je.value), instr(trim(je.value), '@') + 1)) = ?`,
      )
      .run(userId, domain);
    return res.changes;
  }
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO user_messages (user_id, message_id, recipient_addr, received_at, read_at, trashed_at)
       SELECT ?, m.id, lower(trim(je.value)), m.received_at, m.read_at, m.trashed_at
       FROM messages m,
            json_each(CASE WHEN json_valid(m.envelope_to) AND json_type(m.envelope_to) = 'array' THEN m.envelope_to ELSE '[]' END) je
       WHERE instr(trim(je.value), '@') > 1
         AND lower(substr(trim(je.value), instr(trim(je.value), '@') + 1)) = ?
         AND (
           lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)) = ?
           OR lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)) LIKE ? || '+%'
         )`,
    )
    .run(userId, domain, localpart, localpart);
  return res.changes;
}

export interface ResolvedOwner {
  userId: string;
  recipientAddr: string | null;
}

export function resolveRecipientOwners(db: Db, rawAddresses: readonly string[]): ResolvedOwner[] {
  const cleaned = rawAddresses
    .map((addr) => extractNormalizedEmail(addr))
    .filter((addr): addr is string => Boolean(addr));

  const owners = new Map<string, string | null>();
  let anyUnmatched = cleaned.length === 0;

  const exactStmt = db.prepare(
    `SELECT user_id FROM user_mailboxes
     WHERE domain = ? AND localpart != '*' AND (localpart = ? OR localpart = ?)`,
  );
  const wildcardStmt = db.prepare(
    `SELECT user_id FROM user_mailboxes WHERE domain = ? AND localpart = '*'`,
  );

  for (const addr of cleaned) {
    const at = addr.lastIndexOf("@");
    const local = addr.slice(0, at);
    const plusIdx = local.indexOf("+");
    const baseLocal = plusIdx > 0 ? local.slice(0, plusIdx) : local;
    const domain = addr.slice(at + 1);

    const exactRows = exactStmt.all(domain, local, baseLocal) as Array<{ user_id: string }>;
    if (exactRows.length > 0) {
      for (const r of exactRows) {
        if (!owners.has(r.user_id)) owners.set(r.user_id, addr);
      }
      continue;
    }

    const domainRows = wildcardStmt.all(domain) as Array<{ user_id: string }>;
    if (domainRows.length > 0) {
      for (const r of domainRows) {
        if (!owners.has(r.user_id)) owners.set(r.user_id, addr);
      }
      continue;
    }

    anyUnmatched = true;
  }

  if (anyUnmatched) {
    const catchAllUsers = db
      .prepare("SELECT id FROM users WHERE catch_all = 1")
      .all() as Array<{ id: string }>;
    const fallbackAddr = cleaned[0] ?? null;
    for (const u of catchAllUsers) {
      if (!owners.has(u.id)) owners.set(u.id, fallbackAddr);
    }
  }

  return [...owners.entries()].map(([userId, recipientAddr]) => ({ userId, recipientAddr }));
}

export function routeMessageRecipients(
  db: Db,
  messageId: string,
  rawAddresses: readonly string[],
  receivedAt: number,
): ResolvedOwner[] {
  const owners = resolveRecipientOwners(db, rawAddresses);
  if (owners.length === 0) return [];
  const stmt = db.prepare(
    `INSERT INTO user_messages (user_id, message_id, recipient_addr, received_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET
       recipient_addr = COALESCE(user_messages.recipient_addr, excluded.recipient_addr)`,
  );
  for (const owner of owners) {
    stmt.run(owner.userId, messageId, owner.recipientAddr, receivedAt);
  }
  return owners;
}

export function listMessageOwnerIds(db: Db, messageId: string): string[] {
  const rows = db
    .prepare("SELECT user_id FROM user_messages WHERE message_id = ?")
    .all(messageId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

export function authorizeSendFrom(
  db: Db,
  user: UserRow,
  rawFrom: string,
): { allowed: true; from: string; fromName?: string } | { allowed: false } {
  const from = normalizeAddress(rawFrom);
  if (!from) return { allowed: false };
  const at = from.lastIndexOf("@");
  const local = from.slice(0, at);
  const plusIdx = local.indexOf("+");
  const baseLocal = plusIdx > 0 ? local.slice(0, plusIdx) : local;
  const domain = from.slice(at + 1);

  const matched = db
    .prepare(
      `SELECT display_name, can_send, localpart FROM user_mailboxes
       WHERE user_id = ? AND domain = ? AND (localpart = ? OR localpart = ? OR localpart = '*')
       ORDER BY CASE WHEN localpart = ? THEN 0 WHEN localpart = ? THEN 1 ELSE 2 END
       LIMIT 1`,
    )
    .get(user.id, domain, local, baseLocal, local, baseLocal) as
    | { display_name: string | null; can_send: number; localpart: string }
    | undefined;

  if (user.role === "admin") {
    const history = findMailboxHistory(db, domain, local);
    const fromName = matched?.display_name || history?.display_name || user.display_name || undefined;
    return { allowed: true, from, fromName };
  }

  if (!matched || matched.can_send !== 1) {
    return { allowed: false };
  }
  const fromName = matched.display_name || user.display_name || undefined;
  return { allowed: true, from, fromName };
}

export function readUserPersonalSettings(
  user: UserRow,
  fallback?: { panelTitle?: string; labelNames?: Record<Label, string> },
): UserPersonalSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(user.settings_json || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }

  const baseLabels = { ...DEFAULT_LABEL_NAMES, ...(fallback?.labelNames ?? {}) };
  if (raw.labelNames && typeof raw.labelNames === "object" && !Array.isArray(raw.labelNames)) {
    const map = raw.labelNames as Record<string, unknown>;
    for (const label of LABELS) {
      const val = map[label];
      if (typeof val === "string" && val.trim().length > 0 && val.trim().length <= MAX_LABEL_NAME) {
        baseLabels[label] = val.trim();
      }
    }
  }

  const domainNames: Record<string, string> = {};
  if (raw.domainNames && typeof raw.domainNames === "object" && !Array.isArray(raw.domainNames)) {
    for (const [k, v] of Object.entries(raw.domainNames as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim().length > 0 && v.trim().length <= MAX_DOMAIN_NAME) {
        domainNames[k.toLowerCase()] = v.trim();
      }
    }
  }

  const senderNames: SenderName[] = [];
  if (Array.isArray(raw.senderNames)) {
    for (const item of raw.senderNames) {
      if (!item || typeof item !== "object") continue;
      const addr = normalizeAddress(String((item as { address?: unknown }).address ?? ""));
      const name = String((item as { name?: unknown }).name ?? "").trim();
      if (addr && name.length > 0 && name.length <= MAX_SENDER_NAME) {
        senderNames.push({ address: addr, name });
      }
    }
  }

  const blockedSenders: string[] = [];
  if (Array.isArray(raw.blockedSenders)) {
    for (const item of raw.blockedSenders) {
      if (typeof item !== "string") continue;
      const addr = normalizeAddress(item);
      if (addr && !blockedSenders.includes(addr)) blockedSenders.push(addr);
    }
  }

  const notifyLabels: Label[] = [];
  if (Array.isArray(raw.notifyLabels)) {
    for (const item of raw.notifyLabels) {
      if (typeof item === "string" && LABELS.includes(item as Label) && !notifyLabels.includes(item as Label)) {
        notifyLabels.push(item as Label);
      }
    }
  } else {
    notifyLabels.push("phish", "malware");
  }

  const conf = typeof raw.notifyMinConfidence === "number" && Number.isFinite(raw.notifyMinConfidence)
    ? Math.min(1, Math.max(0, raw.notifyMinConfidence))
    : 0.6;

  const panelTitle =
    typeof raw.panelTitle === "string" && raw.panelTitle.trim().length > 0 && raw.panelTitle.trim().length <= MAX_PANEL_TITLE
      ? raw.panelTitle.trim()
      : fallback?.panelTitle ?? DEFAULT_PANEL_TITLE;

  const signature = typeof raw.signature === "string" ? raw.signature.slice(0, 1000) : "";
  const notifyWebhookUrl = typeof raw.notifyWebhookUrl === "string" ? raw.notifyWebhookUrl.trim() : "";
  const notifyWebhookBearer = typeof raw.notifyWebhookBearer === "string" ? raw.notifyWebhookBearer.trim() : "";

  return {
    panelTitle,
    labelNames: baseLabels,
    domainNames,
    senderNames: senderNames.slice(0, MAX_SENDER_NAMES),
    blockedSenders: blockedSenders.slice(0, MAX_BLOCKED_SENDERS),
    signature,
    notifyLabels,
    notifyMinConfidence: conf,
    notifyWebhookUrl,
    notifyWebhookBearer,
  };
}

export function saveUserPersonalSettings(
  db: Db,
  userId: string,
  patch: Partial<{
    panelTitle: string;
    labelNames: Record<string, string>;
    domainNames: Record<string, string>;
    senderNames: readonly SenderName[];
    blockedSenders: readonly string[];
    signature: string;
    notifyLabels: readonly string[];
    notifyMinConfidence: number;
    notifyWebhookUrl: string;
    notifyWebhookBearer: string;
  }>,
  now = Date.now(),
): UserPersonalSettings {
  const user = findUserById(db, userId);
  if (!user) throw new UserError("user not found", 404);
  const current = readUserPersonalSettings(user);
  const stored: Record<string, unknown> = {
    panelTitle: current.panelTitle,
    labelNames: current.labelNames,
    domainNames: current.domainNames,
    senderNames: current.senderNames,
    blockedSenders: current.blockedSenders,
    signature: current.signature,
    notifyLabels: current.notifyLabels,
    notifyMinConfidence: current.notifyMinConfidence,
    notifyWebhookUrl: current.notifyWebhookUrl,
    notifyWebhookBearer: current.notifyWebhookBearer,
  };

  if (patch.panelTitle !== undefined) {
    const clean = patch.panelTitle.replace(/\s+/g, " ").trim();
    if (!clean || clean.length > MAX_PANEL_TITLE || CONTROL_RE.test(clean)) {
      throw new UserError("invalid panel title", 400);
    }
    stored.panelTitle = clean;
  }
  if (patch.labelNames !== undefined) {
    const map: Partial<Record<Label, string>> = {};
    for (const [k, v] of Object.entries(patch.labelNames)) {
      if (!LABELS.includes(k as Label)) throw new UserError(`unknown label (${k})`, 400);
      const trimmed = v.replace(/\s+/g, " ").trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_LABEL_NAME || CONTROL_RE.test(trimmed)) throw new UserError("invalid label name", 400);
      map[k as Label] = trimmed;
    }
    stored.labelNames = { ...DEFAULT_LABEL_NAMES, ...map };
  }
  if (patch.domainNames !== undefined) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch.domainNames)) {
      const trimmed = v.replace(/\s+/g, " ").trim();
      if (!trimmed) continue;
      const domain = cleanMailboxDomain(k);
      if (trimmed.length > MAX_DOMAIN_NAME || CONTROL_RE.test(trimmed)) throw new UserError("invalid domain name", 400);
      map[domain] = trimmed;
    }
    stored.domainNames = map;
  }
  if (patch.senderNames !== undefined) {
    if (patch.senderNames.length > MAX_SENDER_NAMES) throw new UserError("too many sender names", 400);
    const dedup = new Map<string, string>();
    for (const item of patch.senderNames) {
      const addr = normalizeAddress(item.address);
      if (!addr) throw new UserError(`invalid sender address (${item.address})`, 400);
      const name = item.name.replace(/\s+/g, " ").trim();
      if (!name || name.length > MAX_SENDER_NAME || CONTROL_RE.test(name)) throw new UserError("invalid sender name", 400);
      dedup.set(addr, name);
    }
    stored.senderNames = [...dedup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([address, name]) => ({ address, name }));
  }
  if (patch.blockedSenders !== undefined) {
    if (patch.blockedSenders.length > MAX_BLOCKED_SENDERS) throw new UserError("too many blocked senders", 400);
    const list: string[] = [];
    for (const raw of patch.blockedSenders) {
      const addr = normalizeAddress(raw);
      if (!addr) throw new UserError(`invalid sender address (${raw})`, 400);
      if (!list.includes(addr)) list.push(addr);
    }
    list.sort((a, b) => a.localeCompare(b));
    stored.blockedSenders = list;
  }
  if (patch.signature !== undefined) {
    stored.signature = patch.signature.replace(/\u0000/g, "").slice(0, 1000);
  }
  if (patch.notifyLabels !== undefined) {
    const labels: Label[] = [];
    for (const l of patch.notifyLabels) {
      if (!LABELS.includes(l as Label)) throw new UserError(`unknown label (${l})`, 400);
      if (!labels.includes(l as Label)) labels.push(l as Label);
    }
    stored.notifyLabels = labels;
  }
  if (patch.notifyMinConfidence !== undefined) {
    if (!Number.isFinite(patch.notifyMinConfidence) || patch.notifyMinConfidence < 0 || patch.notifyMinConfidence > 1) {
      throw new UserError("invalid confidence", 400);
    }
    stored.notifyMinConfidence = patch.notifyMinConfidence;
  }
  if (patch.notifyWebhookUrl !== undefined) {
    const url = patch.notifyWebhookUrl.trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
      } catch {
        throw new UserError("invalid webhook url", 400);
      }
    }
    stored.notifyWebhookUrl = url;
  }
  if (patch.notifyWebhookBearer !== undefined) {
    stored.notifyWebhookBearer = patch.notifyWebhookBearer.trim().slice(0, 512);
  }

  db.prepare("UPDATE users SET settings_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(stored),
    now,
    userId,
  );
  return readUserPersonalSettings(findUserById(db, userId)!);
}

function presentMailbox(row: UserMailboxRow): UserMailboxPublic {
  return {
    id: row.id,
    userId: row.user_id,
    localpart: row.localpart,
    domain: row.domain,
    address: `${row.localpart}@${row.domain}`,
    displayName: row.display_name,
    canSend: row.can_send === 1,
    note: row.note,
    createdAt: row.created_at,
  };
}

function cleanUsername(raw: string): string {
  const trimmed = raw.trim();
  if (!USERNAME_RE.test(trimmed) || CONTROL_RE.test(trimmed)) {
    throw new UserError("invalid username", 400);
  }
  return trimmed;
}

function cleanOptionalText(raw: string | null | undefined, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length > max || CONTROL_RE.test(cleaned)) {
    throw new UserError("invalid text field", 400);
  }
  return cleaned;
}

function cleanRecoveryEmail(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const normalized = normalizeAddress(raw);
  if (!normalized) throw new UserError("invalid recovery email", 400);
  return normalized;
}

function cleanMailboxLocalpart(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "*") return "*";
  if (
    !LOCALPART_RE.test(trimmed) ||
    trimmed.includes("+") ||
    trimmed.startsWith(".") ||
    trimmed.endsWith(".") ||
    trimmed.includes("..")
  ) {
    throw new UserError("invalid mailbox localpart", 400);
  }
  return trimmed;
}

function cleanMailboxDomain(raw: string): string {
  try {
    const parsed = parseAcceptDomains(raw);
    if (parsed.length !== 1 || !parsed[0]) throw new UserError("invalid domain", 400);
    return parsed[0];
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (err instanceof ConfigError) throw new UserError("invalid domain", 400);
    throw new UserError("invalid domain", 400);
  }
}

function extractNormalizedEmail(raw: string): string | null {
  if (!raw) return null;
  const angled = raw.match(/<([^<>]+)>/);
  const candidate = (angled ? angled[1] : raw) ?? "";
  return normalizeAddress(candidate);
}
