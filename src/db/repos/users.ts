import { ulid } from "ulid";
import { ConfigError, parseAcceptDomains } from "../../config.js";
import type { Db } from "../index.js";
import type { ResetSeal, SenderName } from "./settings.js";

export type UserRole = "owner" | "admin" | "member";
export type DbUserRole = "admin" | "member";
export type AllocationKind = "exact" | "prefix" | "domain";

export class UserError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_user_input") {
    super(message);
    this.name = "UserError";
    this.code = code;
  }
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  role: DbUserRole;
  daily_send_limit: number;
  notes: string | null;
  disabled_at: number | null;
  last_login_at: number | null;
  reset_seal: string | null;
  created_at: number;
  updated_at: number;
}

export interface AllocationRow {
  id: string;
  user_id: string;
  kind: AllocationKind;
  localpart: string;
  domain: string;
  can_send: number;
  notes: string | null;
  created_at: number;
}

export interface AllocationPublic {
  id: string;
  userId: string;
  kind: AllocationKind;
  localpart: string;
  domain: string;
  pattern: string;
  canSend: boolean;
  notes: string | null;
  createdAt: number;
}

export interface UserPublic {
  id: string;
  username: string;
  displayName: string | null;
  role: DbUserRole;
  dailySendLimit: number;
  sentLast24h: number;
  notes: string | null;
  disabled: boolean;
  disabledAt: number | null;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
  allocations: AllocationPublic[];
}

export interface SessionPrincipal {
  kind: "owner" | "user";
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  dailySendLimit: number;
  allocations: AllocationPublic[];
}

export interface PersonalMailboxNote {
  domain: string;
  localpart: string;
  displayName: string | null;
  notes: string | null;
  updatedAt: number;
}

export interface UserPreferences {
  panelTitle: string | null;
  blockedSenders: string[];
  senderNames: SenderName[];
  mailboxes: PersonalMailboxNote[];
}

const USERNAME_RE = /^[a-z0-9._+-]{2,64}(?:@[a-z0-9.-]+\.[a-z0-9-]{2,})?$/;
const LOCAL_EXACT_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~-]{1,64}$/;
const LOCAL_PREFIX_RE = /^[a-z0-9.!#$%&'*/=?^_`{|}~+-]{1,48}$/;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(.+)$/;

export function normalizeUsername(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (!clean || clean.length < 2 || clean.length > 128 || CONTROL_RE.test(clean) || /\s/.test(clean)) {
    throw new UserError("invalid username", "invalid_username");
  }
  if (!USERNAME_RE.test(clean)) {
    throw new UserError("invalid username format", "invalid_username");
  }
  return clean;
}

function cleanOptionalText(raw: string | null | undefined, max: number, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new UserError(`${label} is too long`);
  if (CONTROL_RE.test(trimmed)) throw new UserError(`${label} has control characters`);
  return trimmed;
}

function normalizeDomain(raw: string): string {
  try {
    const parsed = parseAcceptDomains(raw);
    const domain = parsed[0];
    if (!domain || parsed.length !== 1) throw new UserError("invalid domain", "invalid_domain");
    return domain;
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (err instanceof ConfigError) throw new UserError("invalid domain", "invalid_domain");
    throw new UserError("invalid domain", "invalid_domain");
  }
}

export function parseAllocationSpec(input: {
  pattern?: string;
  kind?: AllocationKind;
  localpart?: string;
  domain?: string;
}): { kind: AllocationKind; localpart: string; domain: string } {
  if (input.pattern !== undefined && input.pattern.trim().length > 0) {
    const raw = input.pattern.trim().toLowerCase();
    const at = raw.lastIndexOf("@");
    if (at <= 0 || at === raw.length - 1) {
      throw new UserError("invalid mailbox pattern", "invalid_allocation");
    }
    const localRaw = raw.slice(0, at).trim();
    const domain = normalizeDomain(raw.slice(at + 1));
    if (localRaw === "*") {
      return { kind: "domain", localpart: "*", domain };
    }
    if (localRaw.endsWith("*") && localRaw.length > 1 && !localRaw.slice(0, -1).includes("*")) {
      const prefix = localRaw.slice(0, -1);
      if (!LOCAL_PREFIX_RE.test(prefix) || prefix.startsWith(".") || prefix.includes("..")) {
        throw new UserError("invalid prefix pattern", "invalid_allocation");
      }
      return { kind: "prefix", localpart: prefix, domain };
    }
    if (localRaw.includes("*") || localRaw.includes("+")) {
      throw new UserError("exact mailbox must not contain * or +", "invalid_allocation");
    }
    if (!LOCAL_EXACT_RE.test(localRaw) || localRaw.startsWith(".") || localRaw.endsWith(".") || localRaw.includes("..")) {
      throw new UserError("invalid mailbox localpart", "invalid_allocation");
    }
    return { kind: "exact", localpart: localRaw, domain };
  }

  const kind = input.kind ?? "exact";
  const domain = normalizeDomain(input.domain ?? "");
  if (kind === "domain") {
    return { kind: "domain", localpart: "*", domain };
  }
  const localRaw = (input.localpart ?? "").trim().toLowerCase().replace(/\*$/, "");
  if (kind === "prefix") {
    if (!LOCAL_PREFIX_RE.test(localRaw) || localRaw.startsWith(".") || localRaw.includes("..")) {
      throw new UserError("invalid prefix pattern", "invalid_allocation");
    }
    return { kind: "prefix", localpart: localRaw, domain };
  }
  if (localRaw.includes("*") || localRaw.includes("+")) {
    throw new UserError("exact mailbox must not contain * or +", "invalid_allocation");
  }
  if (!LOCAL_EXACT_RE.test(localRaw) || localRaw.startsWith(".") || localRaw.endsWith(".") || localRaw.includes("..")) {
    throw new UserError("invalid mailbox localpart", "invalid_allocation");
  }
  return { kind: "exact", localpart: localRaw, domain };
}

export function formatAllocationPattern(kind: AllocationKind, localpart: string, domain: string): string {
  if (kind === "domain") return `*@${domain}`;
  if (kind === "prefix") return `${localpart}*@${domain}`;
  return `${localpart}@${domain}`;
}

export function presentAllocation(row: AllocationRow): AllocationPublic {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    localpart: row.localpart,
    domain: row.domain,
    pattern: formatAllocationPattern(row.kind, row.localpart, row.domain),
    canSend: row.can_send === 1,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  const clean = username.trim().toLowerCase();
  if (!clean) return undefined;
  return db.prepare("SELECT * FROM users WHERE lower(username) = ?").get(clean) as UserRow | undefined;
}

export function findUserForResetEmail(db: Db, email: string): UserRow | undefined {
  const clean = email.trim().toLowerCase();
  if (!clean.includes("@")) return undefined;
  const direct = findUserByUsername(db, clean);
  if (direct && direct.disabled_at === null) return direct;
  const at = clean.lastIndexOf("@");
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  const byBox = db
    .prepare(
      `SELECT u.*
       FROM user_mailboxes um
       JOIN users u ON u.id = um.user_id
       WHERE um.kind = 'exact' AND um.localpart = ? AND um.domain = ? AND u.disabled_at IS NULL
       LIMIT 1`,
    )
    .get(local, domain) as UserRow | undefined;
  return byBox;
}

export function listUserAllocations(db: Db, userId: string): AllocationPublic[] {
  const rows = db
    .prepare(
      `SELECT * FROM user_mailboxes
       WHERE user_id = ?
       ORDER BY domain ASC, kind ASC, localpart ASC`,
    )
    .all(userId) as AllocationRow[];
  return rows.map(presentAllocation);
}

export function countUserSentSince(db: Db, userId: string, sinceMs: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM outbox WHERE user_id = ? AND created_at >= ?")
    .get(userId, sinceMs) as { c: number } | undefined;
  return row?.c ?? 0;
}

export function listUsersWithDetails(db: Db, now: number): UserPublic[] {
  const users = db.prepare("SELECT * FROM users ORDER BY role ASC, created_at ASC").all() as UserRow[];
  if (users.length === 0) return [];
  const allocations = db
    .prepare("SELECT * FROM user_mailboxes ORDER BY domain ASC, kind ASC, localpart ASC")
    .all() as AllocationRow[];
  const byUser = new Map<string, AllocationPublic[]>();
  for (const alloc of allocations) {
    const list = byUser.get(alloc.user_id) ?? [];
    list.push(presentAllocation(alloc));
    byUser.set(alloc.user_id, list);
  }
  const since24h = now - 86_400_000;
  const sentCounts = db
    .prepare(
      `SELECT user_id, COUNT(*) AS c
       FROM outbox
       WHERE user_id IS NOT NULL AND created_at >= ?
       GROUP BY user_id`,
    )
    .all(since24h) as Array<{ user_id: string; c: number }>;
  const sentMap = new Map(sentCounts.map((r) => [r.user_id, r.c]));

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    dailySendLimit: u.daily_send_limit,
    sentLast24h: sentMap.get(u.id) ?? 0,
    notes: u.notes,
    disabled: u.disabled_at !== null,
    disabledAt: u.disabled_at,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    allocations: byUser.get(u.id) ?? [],
  }));
}

export function getUserDetail(db: Db, id: string, now: number): UserPublic | null {
  const user = findUserById(db, id);
  if (!user) return null;
  const allocations = listUserAllocations(db, id);
  const sentLast24h = countUserSentSince(db, id, now - 86_400_000);
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    dailySendLimit: user.daily_send_limit,
    sentLast24h,
    notes: user.notes,
    disabled: user.disabled_at !== null,
    disabledAt: user.disabled_at,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    allocations,
  };
}

export function createUser(
  db: Db,
  input: {
    ownerUsername: string;
    username: string;
    displayName?: string | null;
    passwordHash: string;
    role: DbUserRole;
    dailySendLimit?: number;
    notes?: string | null;
    allocations?: ReadonlyArray<{
      pattern?: string;
      kind?: AllocationKind;
      localpart?: string;
      domain?: string;
      canSend?: boolean;
      notes?: string | null;
    }>;
    now: number;
  },
): UserPublic {
  const username = normalizeUsername(input.username);
  if (username === input.ownerUsername.trim().toLowerCase()) {
    throw new UserError("username is reserved by root owner", "username_taken");
  }
  if (findUserByUsername(db, username)) {
    throw new UserError("username already exists", "username_taken");
  }
  const displayName = cleanOptionalText(input.displayName, 40, "display name");
  const notes = cleanOptionalText(input.notes, 300, "notes");
  const dailySendLimit = normalizeSendLimit(input.dailySendLimit ?? (input.role === "admin" ? 500 : 50));
  const id = ulid();

  const parsedAllocations = (input.allocations ?? []).map((item) => ({
    ...parseAllocationSpec(item),
    canSend: item.canSend !== false,
    notes: cleanOptionalText(item.notes, 200, "allocation notes"),
  }));

  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (
        id, username, display_name, password_hash, role, daily_send_limit, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, username, displayName, input.passwordHash, input.role, dailySendLimit, notes, input.now, input.now);

    for (const alloc of parsedAllocations) {
      insertAllocationInternal(db, {
        userId: id,
        kind: alloc.kind,
        localpart: alloc.localpart,
        domain: alloc.domain,
        canSend: alloc.canSend,
        notes: alloc.notes,
        now: input.now,
      });
    }
  })();

  return getUserDetail(db, id, input.now)!;
}

export function updateUser(
  db: Db,
  id: string,
  input: {
    displayName?: string | null;
    role?: DbUserRole;
    dailySendLimit?: number;
    notes?: string | null;
    disabled?: boolean;
    now: number;
  },
): UserPublic {
  const existing = findUserById(db, id);
  if (!existing) throw new UserError("user not found", "not_found");

  const displayName = input.displayName === undefined ? existing.display_name : cleanOptionalText(input.displayName, 40, "display name");
  const notes = input.notes === undefined ? existing.notes : cleanOptionalText(input.notes, 300, "notes");
  const role = input.role ?? existing.role;
  const dailySendLimit = input.dailySendLimit === undefined ? existing.daily_send_limit : normalizeSendLimit(input.dailySendLimit);
  const disabledAt =
    input.disabled === undefined
      ? existing.disabled_at
      : input.disabled
        ? existing.disabled_at ?? input.now
        : null;

  db.transaction(() => {
    db.prepare(
      `UPDATE users
       SET display_name = ?, role = ?, daily_send_limit = ?, notes = ?, disabled_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(displayName, role, dailySendLimit, notes, disabledAt, input.now, id);

    if (input.disabled === true) {
      revokeUserSessions(db, id);
    }
  })();

  return getUserDetail(db, id, input.now)!;
}

export function updateUserPassword(db: Db, id: string, passwordHash: string, now: number, revokeSessions = true): void {
  const res = db
    .prepare("UPDATE users SET password_hash = ?, reset_seal = NULL, updated_at = ? WHERE id = ?")
    .run(passwordHash, now, id);
  if (res.changes === 0) throw new UserError("user not found", "not_found");
  if (revokeSessions) revokeUserSessions(db, id);
}

export function recordUserLogin(db: Db, id: string, now: number): void {
  db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
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

export function saveUserResetSeal(db: Db, id: string, seal: ResetSeal | null, now: number): void {
  db.prepare("UPDATE users SET reset_seal = ?, updated_at = ? WHERE id = ?").run(
    seal ? JSON.stringify(seal) : null,
    now,
    id,
  );
}

export function deleteUser(db: Db, id: string): boolean {
  return db.transaction(() => {
    const existing = findUserById(db, id);
    if (!existing) return false;
    revokeUserSessions(db, id);
    db.prepare("DELETE FROM user_mailboxes WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_message_state WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_preferences WHERE user_id = ?").run(id);
    const res = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return res.changes === 1;
  })();
}

export function revokeUserSessions(db: Db, userId: string): number {
  const res = db
    .prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?")
    .run(userId);
  return res.changes;
}

export function addUserAllocation(
  db: Db,
  input: {
    userId: string;
    pattern?: string;
    kind?: AllocationKind;
    localpart?: string;
    domain?: string;
    canSend?: boolean;
    notes?: string | null;
    now: number;
  },
): AllocationPublic {
  const user = findUserById(db, input.userId);
  if (!user) throw new UserError("user not found", "not_found");
  const spec = parseAllocationSpec(input);
  const notes = cleanOptionalText(input.notes, 200, "allocation notes");
  const row = insertAllocationInternal(db, {
    userId: input.userId,
    kind: spec.kind,
    localpart: spec.localpart,
    domain: spec.domain,
    canSend: input.canSend !== false,
    notes,
    now: input.now,
  });
  db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(input.now, input.userId);
  return presentAllocation(row);
}

function insertAllocationInternal(
  db: Db,
  input: {
    userId: string;
    kind: AllocationKind;
    localpart: string;
    domain: string;
    canSend: boolean;
    notes: string | null;
    now: number;
  },
): AllocationRow {
  const conflict = db
    .prepare("SELECT user_id FROM user_mailboxes WHERE kind = ? AND localpart = ? AND domain = ?")
    .get(input.kind, input.localpart, input.domain) as { user_id: string } | undefined;
  if (conflict) {
    if (conflict.user_id === input.userId) {
      db.prepare(
        "UPDATE user_mailboxes SET can_send = ?, notes = ? WHERE user_id = ? AND kind = ? AND localpart = ? AND domain = ?",
      ).run(input.canSend ? 1 : 0, input.notes, input.userId, input.kind, input.localpart, input.domain);
      return db
        .prepare("SELECT * FROM user_mailboxes WHERE user_id = ? AND kind = ? AND localpart = ? AND domain = ?")
        .get(input.userId, input.kind, input.localpart, input.domain) as AllocationRow;
    }
    throw new UserError("mailbox allocation already belongs to another account", "allocation_conflict");
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO user_mailboxes (id, user_id, kind, localpart, domain, can_send, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.userId, input.kind, input.localpart, input.domain, input.canSend ? 1 : 0, input.notes, input.now);

  return {
    id,
    user_id: input.userId,
    kind: input.kind,
    localpart: input.localpart,
    domain: input.domain,
    can_send: input.canSend ? 1 : 0,
    notes: input.notes,
    created_at: input.now,
  };
}

export function removeUserAllocation(db: Db, userId: string, allocationId: string, now: number): boolean {
  const res = db
    .prepare("DELETE FROM user_mailboxes WHERE id = ? AND user_id = ?")
    .run(allocationId, userId);
  if (res.changes > 0) {
    db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(now, userId);
    return true;
  }
  return false;
}

function normalizeSendLimit(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new UserError("dailySendLimit must be an integer between 0 and 10000", "invalid_limit");
  }
  return value;
}

/**
 * Check whether an email address matches a single mailbox allocation rule.
 * Exact rules (`alice@example.com`) also match RFC 5233 subaddressing (`alice+tag@example.com`).
 */
export function addressMatchesAllocation(
  rawAddress: string,
  alloc: Pick<AllocationPublic, "kind" | "localpart" | "domain">,
): boolean {
  const clean = extractCleanAddress(rawAddress);
  if (!clean) return false;
  const at = clean.lastIndexOf("@");
  if (at <= 0) return false;
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  if (domain !== alloc.domain) return false;
  if (alloc.kind === "domain") return true;
  if (alloc.kind === "prefix") return local.startsWith(alloc.localpart);
  const plus = local.indexOf("+");
  const base = plus > 0 ? local.slice(0, plus) : local;
  return local === alloc.localpart || base === alloc.localpart;
}

export function canSendFromAddress(rawAddress: string, allocations: readonly AllocationPublic[]): boolean {
  return allocations.some((alloc) => alloc.canSend && addressMatchesAllocation(rawAddress, alloc));
}

export function messageMatchesAllocations(
  message: { envelope_to: string; to_addrs?: string | null },
  allocations: readonly AllocationPublic[],
): boolean {
  if (allocations.length === 0) return false;
  const envelope = parseAddressJson(message.envelope_to);
  const targets = envelope.length > 0 ? envelope : parseAddressJson(message.to_addrs ?? null);
  return targets.some((addr) => allocations.some((alloc) => addressMatchesAllocation(addr, alloc)));
}

/**
 * Build a SQLite WHERE predicate on `messages` alias `m` restricting rows to
 * messages addressed to at least one of the member's allocations.
 */
export function buildMemberRecipientSql(
  tableAlias: string,
  allocations: readonly AllocationPublic[],
  params: Record<string, string | number>,
  prefix = "alloc",
): string {
  if (allocations.length === 0) return "1 = 0";
  const branches: string[] = [];
  allocations.forEach((alloc, idx) => {
    const domKey = `${prefix}_dom_${idx}`;
    params[domKey] = `@${alloc.domain}`;
    if (alloc.kind === "domain") {
      branches.push(
        `(substr(lower(trim(je.value)), -length(:${domKey})) = :${domKey}
          AND instr(lower(trim(je.value)), '@') = length(lower(trim(je.value))) - length(:${domKey}) + 1)`,
      );
    } else if (alloc.kind === "prefix") {
      const preKey = `${prefix}_pre_${idx}`;
      params[preKey] = alloc.localpart;
      branches.push(
        `(substr(lower(trim(je.value)), -length(:${domKey})) = :${domKey}
          AND instr(lower(trim(je.value)), '@') = length(lower(trim(je.value))) - length(:${domKey}) + 1
          AND substr(lower(trim(je.value)), 1, length(:${preKey})) = :${preKey})`,
      );
    } else {
      const exactKey = `${prefix}_exact_${idx}`;
      const plusKey = `${prefix}_plus_${idx}`;
      params[exactKey] = `${alloc.localpart}@${alloc.domain}`;
      params[plusKey] = `${alloc.localpart}+`;
      branches.push(
        `(lower(trim(je.value)) = :${exactKey}
          OR (substr(lower(trim(je.value)), -length(:${domKey})) = :${domKey}
              AND instr(lower(trim(je.value)), '@') = length(lower(trim(je.value))) - length(:${domKey}) + 1
              AND substr(lower(trim(je.value)), 1, length(:${plusKey})) = :${plusKey}))`,
      );
    }
  });

  const targetJson = `CASE WHEN ${tableAlias}.envelope_to IS NOT NULL AND ${tableAlias}.envelope_to != '[]' THEN ${tableAlias}.envelope_to ELSE COALESCE(${tableAlias}.to_addrs, '[]') END`;
  return `EXISTS (SELECT 1 FROM json_each(${targetJson}) AS je WHERE ${branches.join(" OR ")})`;
}

export function allowedMemberDomains(allocations: readonly AllocationPublic[]): string[] {
  return [...new Set(allocations.map((a) => a.domain))].sort();
}

export function suggestedFromAddresses(allocations: readonly AllocationPublic[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const alloc of allocations) {
    if (!alloc.canSend) continue;
    let candidate = "";
    if (alloc.kind === "exact") candidate = `${alloc.localpart}@${alloc.domain}`;
    else if (alloc.kind === "prefix") candidate = `${alloc.localpart}mail@${alloc.domain}`;
    else candidate = `hello@${alloc.domain}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

// --- Per-User Preferences (Member Isolation) ---

export function readUserPreferences(db: Db, userId: string): UserPreferences {
  const row = db
    .prepare("SELECT panel_title, blocked, senders, mailboxes FROM user_preferences WHERE user_id = ?")
    .get(userId) as
    | { panel_title: string | null; blocked: string; senders: string; mailboxes: string }
    | undefined;
  if (!row) {
    return { panelTitle: null, blockedSenders: [], senderNames: [], mailboxes: [] };
  }
  return {
    panelTitle: row.panel_title,
    blockedSenders: parseBlocked(row.blocked),
    senderNames: parseSenders(row.senders),
    mailboxes: parsePersonalMailboxes(row.mailboxes),
  };
}

export function saveUserBlockedSenders(db: Db, userId: string, addresses: readonly string[], now: number): string[] {
  if (addresses.length > 500) throw new UserError("at most 500 blocked senders");
  const out: string[] = [];
  for (const raw of addresses) {
    const normalized = normalizeEmailStrict(raw);
    if (!out.includes(normalized)) out.push(normalized);
  }
  out.sort((a, b) => a.localeCompare(b));
  upsertUserPreferences(db, userId, { blocked: JSON.stringify(out), now });
  return out;
}

export function saveUserNamePreferences(
  db: Db,
  userId: string,
  input: { panelTitle: string; senderNames: readonly SenderName[] },
  now: number,
): { panelTitle: string; senderNames: SenderName[] } {
  const panelTitle = cleanOptionalText(input.panelTitle, 40, "panel title");
  if (!panelTitle) throw new UserError("panel title is required");
  if (input.senderNames.length > 200) throw new UserError("at most 200 sender names");
  const map = new Map<string, string>();
  for (const item of input.senderNames) {
    const addr = normalizeEmailStrict(item.address);
    const name = cleanOptionalText(item.name, 40, "sender name");
    if (!name) throw new UserError("sender name is required");
    map.set(addr, name);
  }
  const senderNames = [...map]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([address, name]) => ({ address, name }));
  upsertUserPreferences(db, userId, {
    panelTitle,
    senders: JSON.stringify(senderNames),
    now,
  });
  return { panelTitle, senderNames };
}

export function upsertUserMailboxNote(
  db: Db,
  userId: string,
  input: {
    domain: string;
    localpart: string;
    displayName?: string | null;
    notes?: string | null;
  },
  now: number,
): PersonalMailboxNote[] {
  const domain = normalizeDomain(input.domain);
  const localpart = input.localpart.trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(localpart)) {
    throw new UserError("invalid localpart");
  }
  const prefs = readUserPreferences(db, userId);
  const list = prefs.mailboxes.filter((m) => !(m.domain === domain && m.localpart === localpart));
  const existing = prefs.mailboxes.find((m) => m.domain === domain && m.localpart === localpart);
  const displayName =
    input.displayName === undefined ? existing?.displayName ?? null : cleanOptionalText(input.displayName, 40, "display name");
  const notes = input.notes === undefined ? existing?.notes ?? null : cleanOptionalText(input.notes, 500, "notes");
  list.push({ domain, localpart, displayName, notes, updatedAt: now });
  list.sort((a, b) => a.domain.localeCompare(b.domain) || a.localpart.localeCompare(b.localpart));
  upsertUserPreferences(db, userId, { mailboxes: JSON.stringify(list.slice(0, 500)), now });
  return list;
}

function upsertUserPreferences(
  db: Db,
  userId: string,
  patch: { panelTitle?: string | null; blocked?: string; senders?: string; mailboxes?: string; now: number },
): void {
  const current = db
    .prepare("SELECT panel_title, blocked, senders, mailboxes FROM user_preferences WHERE user_id = ?")
    .get(userId) as
    | { panel_title: string | null; blocked: string; senders: string; mailboxes: string }
    | undefined;

  const panelTitle = patch.panelTitle !== undefined ? patch.panelTitle : current?.panel_title ?? null;
  const blocked = patch.blocked ?? current?.blocked ?? "[]";
  const senders = patch.senders ?? current?.senders ?? "[]";
  const mailboxes = patch.mailboxes ?? current?.mailboxes ?? "[]";

  db.prepare(
    `INSERT INTO user_preferences (user_id, panel_title, blocked, senders, mailboxes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       panel_title = excluded.panel_title,
       blocked = excluded.blocked,
       senders = excluded.senders,
       mailboxes = excluded.mailboxes,
       updated_at = excluded.updated_at`,
  ).run(userId, panelTitle, blocked, senders, mailboxes, patch.now);
}

/**
 * Pre-trash an inbound message for any active member who blocked the sender.
 */
export function applyMemberBlocklistsOnIngest(
  db: Db,
  message: { id: string; envelope_to: string; to_addrs?: string | null },
  senderCandidates: ReadonlyArray<string | null | undefined>,
  now: number,
): void {
  const senders = senderCandidates
    .map((s) => (s ? extractCleanAddress(s) : ""))
    .filter((s) => s.length > 0);
  if (senders.length === 0) return;

  const prefRows = db
    .prepare(
      `SELECT up.user_id, up.blocked
       FROM user_preferences up
       JOIN users u ON u.id = up.user_id
       WHERE u.role = 'member' AND u.disabled_at IS NULL AND up.blocked != '[]'`,
    )
    .all() as Array<{ user_id: string; blocked: string }>;

  for (const row of prefRows) {
    const blocked = parseBlocked(row.blocked);
    if (!senders.some((s) => blocked.includes(s))) continue;
    const allocs = listUserAllocations(db, row.user_id);
    if (!messageMatchesAllocations(message, allocs)) continue;
    db.prepare(
      `INSERT INTO user_message_state (user_id, message_id, trashed_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET
         trashed_at = COALESCE(user_message_state.trashed_at, excluded.trashed_at),
         updated_at = excluded.updated_at`,
    ).run(row.user_id, message.id, now, now);
  }
}

function normalizeEmailStrict(raw: string): string {
  const text = raw.trim().toLowerCase();
  const match = ADDRESS_RE.exec(text);
  if (!match) throw new UserError(`invalid address (${raw})`);
  const domain = normalizeDomain(match[1] ?? "");
  const at = text.lastIndexOf("@");
  return `${text.slice(0, at)}@${domain}`;
}

function extractCleanAddress(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const angled = trimmed.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] ?? "" : trimmed).trim().replace(/^<|>$/g, "");
  return candidate.includes("@") ? candidate : "";
}

function parseAddressJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

function parseBlocked(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.includes("@"));
  } catch {
    return [];
  }
}

function parseSenders(raw: string): SenderName[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SenderName[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const addr = (item as { address?: unknown }).address;
      const name = (item as { name?: unknown }).name;
      if (typeof addr === "string" && typeof name === "string" && addr && name) {
        out.push({ address: addr, name });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function parsePersonalMailboxes(raw: string): PersonalMailboxNote[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PersonalMailboxNote[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.domain !== "string" || typeof rec.localpart !== "string") continue;
      out.push({
        domain: rec.domain,
        localpart: rec.localpart,
        displayName: typeof rec.displayName === "string" ? rec.displayName : null,
        notes: typeof rec.notes === "string" ? rec.notes : null,
        updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}
