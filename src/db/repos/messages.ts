import type { Db } from "../index.js";
import { OWNER_USER_ID, resolveAddressOwner, sqlResolvedOwner } from "./users.js";

export type MessageStatus =
  | "received"
  | "authed"
  | "parsed"
  | "classified"
  | "notified"
  | "error";

export interface ViewerContext {
  userId: string;
  role: "admin" | "member";
  /** For admins: 'mine' (default: unallocated + own), 'all' (global), or 'user:<id>'. */
  scope?: string;
}

export interface NewMessage {
  id: string;
  sha256: string;
  rawPath: string;
  sizeBytes: number;
  receivedAt: number;
  envelopeFrom: string | null;
  envelopeTo: string[];
  domains: string[];
  smtpMeta: unknown;
  messageId?: string | null;
  now: number;
}

export interface NewDelivery {
  id: string;
  messageId: string;
  receivedAt: number;
  smtpMeta: unknown;
}

export interface MessageRow {
  id: string;
  sha256: string;
  raw_path: string;
  size_bytes: number;
  received_at: number;
  status: string;
  ai_result: string | null;
}

export function insertMessage(db: Db, row: NewMessage): void {
  db.prepare(
    `INSERT INTO messages (
      id, sha256, raw_path, size_bytes, received_at, envelope_from, envelope_to,
      domains, smtp_meta, message_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
  ).run(
    row.id,
    row.sha256,
    row.rawPath,
    row.sizeBytes,
    row.receivedAt,
    row.envelopeFrom,
    JSON.stringify(row.envelopeTo),
    JSON.stringify(row.domains),
    JSON.stringify(row.smtpMeta),
    row.messageId ?? null,
    row.now,
    row.now,
  );
}

export function findMessageBySha(db: Db, sha256: string): MessageRow | undefined {
  return db
    .prepare(
      `SELECT id, sha256, raw_path, size_bytes, received_at, status, ai_result
       FROM messages WHERE sha256 = ?`,
    )
    .get(sha256) as MessageRow | undefined;
}

export function findMessageByMessageId(db: Db, messageId: string): MessageRow | undefined {
  return db
    .prepare(
      `SELECT id, sha256, raw_path, size_bytes, received_at, status, ai_result
       FROM messages WHERE message_id = ? LIMIT 1`,
    )
    .get(messageId) as MessageRow | undefined;
}

export function insertDelivery(db: Db, row: NewDelivery): void {
  db.prepare(
    `INSERT INTO deliveries (id, message_id, received_at, smtp_meta) VALUES (?, ?, ?, ?)`,
  ).run(row.id, row.messageId, row.receivedAt, JSON.stringify(row.smtpMeta));
}

export function markMessageError(db: Db, id: string, error: string, now: number): void {
  db.prepare(
    `UPDATE messages SET status = 'error', error = ?, updated_at = ? WHERE id = ?`,
  ).run(error.slice(0, 500), now, id);
}

export interface StoredMessage {
  id: string;
  sha256: string;
  raw_path: string;
  size_bytes: number;
  received_at: number;
  envelope_from: string | null;
  envelope_to: string;
  domains: string;
  message_id: string | null;
  in_reply_to: string | null;
  ref_ids: string | null;
  thread_key: string | null;
  subject: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  smtp_meta: string;
  auth_result: string | null;
  parsed: string | null;
  ai_result: string | null;
  status: string;
  error: string | null;
  trashed_at: number | null;
  read_at?: number | null;
  /** Session user's star. Absent on a raw messages row. */
  starred_at?: number | null;
}

export function getMessage(db: Db, id: string): StoredMessage | undefined {
  return db
    .prepare(
      `SELECT id, sha256, raw_path, size_bytes, received_at, envelope_from, envelope_to, domains,
              message_id, in_reply_to, ref_ids, thread_key, subject, from_addr, to_addrs, smtp_meta, auth_result, parsed, ai_result,
              status, error, trashed_at, read_at
       FROM messages WHERE id = ?`,
    )
    .get(id) as StoredMessage | undefined;
}

interface EffectiveTarget {
  /** 'all' | 'owner' | specific user.id */
  visibility: "all" | "owner" | string;
  /** 'owner' uses messages columns (plus soft-delete check); any other id uses user_message_state */
  stateUserId: string;
  /** Whether envelope_to should be filtered to only addresses belonging to stateUserId */
  redactOtherRecipients: boolean;
}

function resolveViewerTarget(viewer?: ViewerContext): EffectiveTarget {
  if (!viewer) {
    return { visibility: "all", stateUserId: OWNER_USER_ID, redactOtherRecipients: false };
  }
  if (viewer.role === "member") {
    return { visibility: viewer.userId, stateUserId: viewer.userId, redactOtherRecipients: true };
  }
  const scope = viewer.scope ?? "mine";
  if (scope === "all") {
    return { visibility: "all", stateUserId: OWNER_USER_ID, redactOtherRecipients: false };
  }
  if (scope.startsWith("user:")) {
    const targetId = scope.slice("user:".length).trim();
    if (targetId && targetId !== OWNER_USER_ID) {
      return { visibility: targetId, stateUserId: targetId, redactOtherRecipients: false };
    }
  }
  if (viewer.userId !== OWNER_USER_ID) {
    return { visibility: viewer.userId, stateUserId: viewer.userId, redactOtherRecipients: true };
  }
  return { visibility: OWNER_USER_ID, stateUserId: OWNER_USER_ID, redactOtherRecipients: false };
}

export function canViewerAccessMessage(db: Db, message: StoredMessage, viewer?: ViewerContext): boolean {
  const target = resolveViewerTarget(viewer);
  if (target.visibility === "all") return true;

  const ums = db
    .prepare("SELECT deleted_at FROM user_message_state WHERE user_id = ? AND message_id = ?")
    .get(target.stateUserId, message.id) as { deleted_at: number | null } | undefined;
  if (ums?.deleted_at != null) return false;

  if (target.visibility === OWNER_USER_ID && message.trashed_at != null) return true;

  const recipients = parseEnvelopeArray(message.envelope_to);
  if (recipients.length === 0) {
    return target.visibility === OWNER_USER_ID;
  }
  for (const rcpt of recipients) {
    const owner = resolveAddressOwner(db, rcpt);
    if (owner === target.visibility) return true;
  }
  return false;
}

export function getMessageForViewer(db: Db, id: string, viewer?: ViewerContext): StoredMessage | undefined {
  const message = getMessage(db, id);
  if (!message) return undefined;
  if (!viewer) return message;
  if (!canViewerAccessMessage(db, message, viewer)) return undefined;

  const target = resolveViewerTarget(viewer);
  const starredAt = readUserStarredAt(db, viewer.userId, id);
  if (target.stateUserId === OWNER_USER_ID && !target.redactOtherRecipients) {
    return { ...message, starred_at: starredAt };
  }

  const ums = db
    .prepare(
      "SELECT read_at, trashed_at, manual_label FROM user_message_state WHERE user_id = ? AND message_id = ?",
    )
    .get(target.stateUserId, id) as
    | { read_at: number | null; trashed_at: number | null; manual_label: string | null }
    | undefined;

  const overlaidAi = ums?.manual_label
    ? applyManualLabelJson(message.ai_result, ums.manual_label)
    : message.ai_result;

  const filteredEnvelope = target.redactOtherRecipients
    ? JSON.stringify(
        parseEnvelopeArray(message.envelope_to).filter((addr) => resolveAddressOwner(db, addr) === target.stateUserId),
      )
    : message.envelope_to;

  const filteredMeta = target.redactOtherRecipients
    ? redactSmtpMeta(message.smtp_meta, target.stateUserId, db)
    : message.smtp_meta;

  return {
    ...message,
    envelope_to: filteredEnvelope,
    smtp_meta: filteredMeta,
    ai_result: overlaidAi,
    trashed_at: target.stateUserId === OWNER_USER_ID ? message.trashed_at : (ums?.trashed_at ?? null),
    read_at: target.stateUserId === OWNER_USER_ID ? message.read_at : (ums?.read_at ?? null),
    starred_at: starredAt,
  };
}

function redactSmtpMeta(raw: string, userId: string, db: Db): string {
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    if (!meta || typeof meta !== "object") return raw;
    const rcpts = Array.isArray(meta.rcptTo)
      ? meta.rcptTo.filter((r): r is string => typeof r === "string" && resolveAddressOwner(db, r) === userId)
      : [];
    return JSON.stringify({ ...meta, rcptTo: rcpts });
  } catch {
    return raw;
  }
}

export function saveAuthResult(db: Db, id: string, authResult: string, now: number): void {
  db.prepare(
    `UPDATE messages
     SET auth_result = ?, status = 'authed', error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(authResult, now, id);
}

export function saveParsedMessage(
  db: Db,
  row: {
    id: string;
    subject: string | null;
    fromAddr: string | null;
    toAddrs: string[] | null;
    messageId: string | null;
    inReplyTo?: string | null;
    refIds?: string | null;
    threadKey?: string | null;
    parsed: string;
    now: number;
  },
): void {
  db.prepare(
    `UPDATE messages
     SET subject = ?, from_addr = ?, to_addrs = ?, message_id = ?,
         in_reply_to = ?, ref_ids = ?, thread_key = ?, parsed = ?,
         status = 'parsed', error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    row.subject,
    row.fromAddr,
    row.toAddrs ? JSON.stringify(row.toAddrs) : null,
    row.messageId,
    row.inReplyTo ?? null,
    row.refIds ?? null,
    row.threadKey ?? null,
    row.parsed,
    row.now,
    row.id,
  );
}

export function markMessageRead(db: Db, id: string, now: number): void {
  db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL").run(now, id);
}

export function markMessageReadForViewer(db: Db, id: string, viewer: ViewerContext | undefined, now: number): void {
  const target = resolveViewerTarget(viewer);
  if (target.stateUserId === OWNER_USER_ID) {
    markMessageRead(db, id, now);
    return;
  }
  db.prepare(
    `INSERT INTO user_message_state (user_id, message_id, read_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET
       read_at = COALESCE(user_message_state.read_at, excluded.read_at),
       updated_at = excluded.updated_at`,
  ).run(target.stateUserId, id, now, now);
}

export function markMessageUnreadForViewer(db: Db, id: string, viewer: ViewerContext | undefined, now: number): void {
  const target = resolveViewerTarget(viewer);
  if (target.stateUserId === OWNER_USER_ID) {
    db.prepare("UPDATE messages SET read_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
    return;
  }
  db.prepare(
    `INSERT INTO user_message_state (user_id, message_id, read_at, updated_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET
       read_at = NULL,
       updated_at = excluded.updated_at`,
  ).run(target.stateUserId, id, now);
}

export function markAllReadForViewer(
  db: Db,
  viewer: ViewerContext | undefined,
  filter: { label?: string; domain?: string },
  now: number,
): number {
  const rows = listMessages(db, {
    label: filter.label ?? "legit",
    domain: filter.domain,
    trashed: false,
    limit: 5_000,
    viewer,
  });
  const unreadIds = rows.filter((r) => r.read_at == null).map((r) => r.id);
  if (unreadIds.length === 0) return 0;

  const target = resolveViewerTarget(viewer);
  return db.transaction(() => {
    if (target.stateUserId === OWNER_USER_ID) {
      const stmt = db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL");
      let count = 0;
      for (const id of unreadIds) {
        count += stmt.run(now, id).changes;
      }
      return count;
    }
    const stmt = db.prepare(
      `INSERT INTO user_message_state (user_id, message_id, read_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET
         read_at = COALESCE(user_message_state.read_at, excluded.read_at),
         updated_at = excluded.updated_at`,
    );
    for (const id of unreadIds) {
      stmt.run(target.stateUserId, id, now, now);
    }
    return unreadIds.length;
  })();
}

export function setManualLabelForViewer(
  db: Db,
  id: string,
  label: string,
  actor: string,
  viewer: ViewerContext | undefined,
  now: number,
): { originalLabel: string | null; originalConfidence: number | null; prevLabel: string } {
  const message = getMessage(db, id);
  if (!message) throw new Error("message missing");
  const existingAi = safeParseObject(message.ai_result);
  const originalLabel =
    typeof existingAi.originalLabel === "string"
      ? existingAi.originalLabel
      : typeof existingAi.label === "string"
        ? existingAi.label
        : null;
  const originalConfidence =
    typeof existingAi.originalConfidence === "number"
      ? existingAi.originalConfidence
      : typeof existingAi.confidence === "number"
        ? existingAi.confidence
        : null;

  const target = resolveViewerTarget(viewer);
  if (target.stateUserId === OWNER_USER_ID) {
    const prevLabel = typeof existingAi.label === "string" ? existingAi.label : "none";
    const ai: Record<string, unknown> = { ...existingAi };
    if (typeof ai.originalLabel !== "string" && typeof ai.label === "string") {
      ai.originalLabel = ai.label;
      ai.originalConfidence = typeof ai.confidence === "number" ? ai.confidence : null;
    }
    ai.schema = 1;
    if (typeof ai.prompt_id !== "string" || !ai.prompt_id) ai.prompt_id = "manual";
    if (typeof ai.model !== "string" || !ai.model) ai.model = "manual";
    if (typeof ai.provider !== "string" || !ai.provider) ai.provider = "manual";
    if (typeof ai.at !== "string" || !ai.at) ai.at = new Date(now).toISOString();
    if (typeof ai.confidence !== "number") ai.confidence = 1;
    if (typeof ai.summary !== "string" || !ai.summary) ai.summary = "已手动修改分类";
    if (!Array.isArray(ai.tags)) ai.tags = [];
    if (!Array.isArray(ai.signals)) ai.signals = [];
    ai.label = label;
    ai.manualOverride = true;
    ai.overrideActor = actor;
    ai.overrideAt = now;

    db.prepare("UPDATE messages SET ai_result = ?, status = 'classified', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(ai), now, id);
    return {
      originalLabel: (ai.originalLabel as string | null) ?? null,
      originalConfidence: (ai.originalConfidence as number | null) ?? null,
      prevLabel,
    };
  }

  const prevRow = db
    .prepare("SELECT manual_label FROM user_message_state WHERE user_id = ? AND message_id = ?")
    .get(target.stateUserId, id) as { manual_label: string | null } | undefined;
  const prevLabel =
    prevRow?.manual_label ?? (typeof existingAi.label === "string" ? existingAi.label : "none");

  db.prepare(
    `INSERT INTO user_message_state (user_id, message_id, manual_label, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET
       manual_label = excluded.manual_label,
       updated_at = excluded.updated_at`,
  ).run(target.stateUserId, id, label, now);

  return { originalLabel, originalConfidence, prevLabel };
}

export function setUserMessageTrashed(db: Db, userId: string, messageId: string, trashedAt: number | null, now: number): void {
  db.prepare(
    `INSERT INTO user_message_state (user_id, message_id, trashed_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET
       trashed_at = excluded.trashed_at,
       updated_at = excluded.updated_at`,
  ).run(userId, messageId, trashedAt, now);
}

function readUserStarredAt(db: Db, userId: string, messageId: string): number | null {
  const row = db
    .prepare("SELECT starred_at FROM user_message_state WHERE user_id = ? AND message_id = ?")
    .get(userId, messageId) as { starred_at: number | null } | undefined;
  return row?.starred_at ?? null;
}

/** Draw 1 member branch. Owner and collaborative admins write their own state row too. */
export function setMessageStarredForViewer(
  db: Db,
  id: string,
  starred: boolean,
  viewer: ViewerContext | undefined,
  now: number,
): void {
  const userId = viewer?.userId ?? OWNER_USER_ID;
  const stamp = starred ? now : null;
  db.prepare(
    `INSERT INTO user_message_state (user_id, message_id, starred_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET starred_at = excluded.starred_at, updated_at = excluded.updated_at`,
  ).run(userId, id, stamp, now);
}

export function saveAiResult(db: Db, id: string, aiResult: string, now: number): void {
  db.prepare(
    `UPDATE messages
     SET ai_result = ?, status = 'classified', error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(aiResult, now, id);
}

export interface MessageListQuery {
  label?: string;
  status?: string;
  trashed?: boolean | "all";
  q?: string;
  from?: string;
  domain?: string;
  starred?: boolean;
  since?: number;
  until?: number;
  limit: number;
  cursorAt?: number;
  cursorId?: string;
  viewer?: ViewerContext;
}

export interface MessageListRow {
  id: string;
  sha256: string;
  received_at: number;
  size_bytes: number;
  envelope_from: string | null;
  envelope_to: string;
  message_id: string | null;
  subject: string | null;
  from_addr: string | null;
  domains: string;
  status: string;
  ai_result: string | null;
  trashed_at: number | null;
  read_at: number | null;
  starred_at: number | null;
}

export function listMessages(db: Db, query: MessageListQuery): MessageListRow[] {
  const target = resolveViewerTarget(query.viewer);
  const useUserOverlay = target.stateUserId !== OWNER_USER_ID;
  const resolvedOwner = sqlResolvedOwner("je.value");

  const where: string[] = [];
  const params: Record<string, string | number> = { limit: query.limit };

  if (useUserOverlay) {
    params.stateUid = target.stateUserId;
    where.push("ums.deleted_at IS NULL");
  } else if (query.viewer) {
    params.stateUid = OWNER_USER_ID;
    where.push("ums.deleted_at IS NULL");
  }

  if (target.visibility === OWNER_USER_ID && query.trashed !== true) {
    where.push(
      `(json_array_length(m.envelope_to) = 0 OR EXISTS (
        SELECT 1 FROM json_each(m.envelope_to) je
        WHERE ${resolvedOwner} IS NULL
      ))`,
    );
  } else if (target.visibility !== "all" && target.visibility !== OWNER_USER_ID) {
    params.visUid = target.visibility;
    where.push(
      `EXISTS (
        SELECT 1 FROM json_each(m.envelope_to) je
        WHERE ${resolvedOwner} = :visUid
      )`,
    );
  }

  const trashedExpr = useUserOverlay ? "ums.trashed_at" : "m.trashed_at";
  const labelExpr = useUserOverlay
    ? "COALESCE(ums.manual_label, json_extract(m.ai_result, '$.label'))"
    : "json_extract(m.ai_result, '$.label')";

  if (query.trashed === true) {
    where.push(`${trashedExpr} IS NOT NULL`);
  } else if (query.trashed === "all") {
    // no filter on trashed_at
  } else {
    where.push(`${trashedExpr} IS NULL`);
  }
  if (query.status) {
    where.push("m.status = :status");
    params.status = query.status;
  }
  if (query.label === "legit") {
    where.push(`(${labelExpr} = 'legit' OR ${labelExpr} IS NULL)`);
  } else if (query.label === "not-legit") {
    where.push(`(${labelExpr} IS NOT NULL AND ${labelExpr} != 'legit')`);
  } else if (query.label) {
    where.push(`${labelExpr} = :label`);
    params.label = query.label;
  }
  if (query.from) {
    where.push("lower(m.from_addr) = lower(:fromAddr)");
    params.fromAddr = query.from;
  }
  if (query.domain) {
    where.push("EXISTS (SELECT 1 FROM json_each(m.domains) jd WHERE lower(jd.value) = lower(:domain))");
    params.domain = query.domain;
  }
  if (query.q) {
    where.push(`(
      IFNULL(m.subject, '') LIKE :q ESCAPE '\\' OR
      IFNULL(m.from_addr, '') LIKE :q ESCAPE '\\' OR
      IFNULL(m.message_id, '') LIKE :q ESCAPE '\\'
    )`);
    params.q = likeContains(query.q);
  }
  if (query.since !== undefined) {
    where.push("m.received_at >= :since");
    params.since = query.since;
  }
  if (query.until !== undefined) {
    where.push("m.received_at <= :until");
    params.until = query.until;
  }
  if (query.cursorAt !== undefined && query.cursorId) {
    where.push("(m.received_at < :cursorAt OR (m.received_at = :cursorAt AND m.id < :cursorId))");
    params.cursorAt = query.cursorAt;
    params.cursorId = query.cursorId;
  }

  const starUserId = query.viewer?.userId ?? OWNER_USER_ID;
  const overlayJoin = useUserOverlay || Boolean(query.viewer);
  const starOnUms = overlayJoin && target.stateUserId === starUserId;
  let starJoin = "";
  let starredExpr = "NULL";
  if (starOnUms) {
    starredExpr = "ums.starred_at";
  } else if (query.viewer) {
    params.starUid = starUserId;
    starJoin =
      "LEFT JOIN user_message_state ums_star ON ums_star.user_id = :starUid AND ums_star.message_id = m.id";
    starredExpr = "ums_star.starred_at";
  }
  if (query.starred === true) {
    where.push(`${starredExpr} IS NOT NULL`);
  }

  const joinClause = overlayJoin
    ? "LEFT JOIN user_message_state ums ON ums.user_id = :stateUid AND ums.message_id = m.id"
    : "";

  const selectTrashed = useUserOverlay ? "ums.trashed_at AS trashed_at" : "m.trashed_at AS trashed_at";
  const selectRead = useUserOverlay ? "ums.read_at AS read_at" : "m.read_at AS read_at";
  const selectManual = useUserOverlay ? "ums.manual_label AS manual_label" : "NULL AS manual_label";

  const sql = `SELECT m.id, m.sha256, m.received_at, m.size_bytes, m.envelope_from, m.envelope_to, m.message_id,
                      m.subject, m.from_addr, m.domains, m.status, m.ai_result,
                      ${selectTrashed}, ${selectRead}, ${selectManual}, ${starredExpr} AS starred_at
               FROM messages m
               ${joinClause}
               ${starJoin}
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY m.received_at DESC, m.id DESC
               LIMIT :limit`;

  const rawRows = db.prepare(sql).all(params) as Array<MessageListRow & { manual_label: string | null }>;
  return rawRows.map((row) => {
    const aiResult = row.manual_label ? applyManualLabelJson(row.ai_result, row.manual_label) : row.ai_result;
    const envelopeTo = target.redactOtherRecipients
      ? JSON.stringify(
          parseEnvelopeArray(row.envelope_to).filter((addr) => resolveAddressOwner(db, addr) === target.stateUserId),
        )
      : row.envelope_to;
    return {
      id: row.id,
      sha256: row.sha256,
      received_at: row.received_at,
      size_bytes: row.size_bytes,
      envelope_from: row.envelope_from,
      envelope_to: envelopeTo,
      message_id: row.message_id,
      subject: row.subject,
      from_addr: row.from_addr,
      domains: row.domains,
      status: row.status,
      ai_result: aiResult,
      trashed_at: row.trashed_at,
      read_at: row.read_at,
      starred_at: row.starred_at ?? null,
    };
  });
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function markMessageNotified(db: Db, id: string, now: number): void {
  db.prepare(
    `UPDATE messages SET status = 'notified', error = NULL, updated_at = ? WHERE id = ?`,
  ).run(now, id);
}

export function trashMessage(db: Db, id: string, now: number): void {
  db.prepare("UPDATE messages SET trashed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
}

export function trashMessageForViewer(db: Db, id: string, viewer: ViewerContext | undefined, now: number): void {
  const target = resolveViewerTarget(viewer);
  if (target.stateUserId === OWNER_USER_ID) {
    trashMessage(db, id, now);
    return;
  }
  setUserMessageTrashed(db, target.stateUserId, id, now, now);
}

export function restoreMessage(db: Db, id: string, now: number): void {
  db.prepare("UPDATE messages SET trashed_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
}

export function restoreMessageForViewer(db: Db, id: string, viewer: ViewerContext | undefined, now: number): void {
  const target = resolveViewerTarget(viewer);
  if (target.stateUserId === OWNER_USER_ID) {
    restoreMessage(db, id, now);
    return;
  }
  setUserMessageTrashed(db, target.stateUserId, id, null, now);
}

export interface PurgedFiles {
  count: number;
  paths: string[];
}

export function deleteMessage(db: Db, id: string, purgedAt: number): PurgedFiles | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT sha256, raw_path FROM messages WHERE id = ?").get(id) as
      | { sha256: string; raw_path: string }
      | undefined;
    if (!row) return null;
    const paths = [row.raw_path, ...orphanAttachmentPaths(db, "message", id)];
    rememberPurged(db, [row.sha256], purgedAt);
    db.prepare("DELETE FROM user_message_state WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM message_attachments WHERE message_id = ?").run(id);
    deleteUnlinkedAttachments(db);
    db.prepare("DELETE FROM deliveries WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM jobs WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    return { count: 1, paths };
  })();
}

function markMessageDeletedForUser(db: Db, userId: string, messageId: string, deletedAt: number): void {
  db.prepare(
    `INSERT INTO user_message_state (user_id, message_id, deleted_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET
       deleted_at = excluded.deleted_at,
       updated_at = excluded.updated_at`,
  ).run(userId, messageId, deletedAt, deletedAt);
}

/**
 * Reference-counted multi-user delete:
 * - When `viewer` is omitted or has global scope 'all', physically purges immediately.
 * - Otherwise checks all active owners of `m.envelope_to`. If no other user still holds an
 *   non-deleted copy, physically purges raw EML & orphan attachments; if another user still
 *   holds a copy, marks `deleted_at` for this viewer only.
 */
export function deleteMessageForViewer(
  db: Db,
  id: string,
  viewer: ViewerContext | undefined,
  purgedAt: number,
): PurgedFiles | null {
  const message = getMessage(db, id);
  if (!message) return null;
  if (!viewer) return deleteMessage(db, id, purgedAt);
  if (!canViewerAccessMessage(db, message, viewer)) return null;

  const target = resolveViewerTarget(viewer);
  if (target.visibility === "all") {
    return deleteMessage(db, id, purgedAt);
  }

  const activeOwners = remainingActiveOwners(db, message);
  const othersHoldCopy = [...activeOwners].some((uid) => uid !== target.stateUserId);
  if (!othersHoldCopy) {
    return deleteMessage(db, id, purgedAt);
  }

  markMessageDeletedForUser(db, target.stateUserId, id, purgedAt);
  if (target.stateUserId === OWNER_USER_ID) {
    db.prepare("UPDATE messages SET trashed_at = NULL, updated_at = ? WHERE id = ?").run(purgedAt, id);
  }
  return { count: 1, paths: [] };
}

export function emptyTrash(db: Db, purgedAt: number): PurgedFiles {
  return db.transaction(() => {
    const rows = db
      .prepare("SELECT sha256, raw_path FROM messages WHERE trashed_at IS NOT NULL")
      .all() as Array<{ sha256: string; raw_path: string }>;
    if (rows.length === 0) return { count: 0, paths: [] };
    const paths = [...rows.map((row) => row.raw_path), ...orphanAttachmentPaths(db, "trash")];
    rememberPurged(
      db,
      rows.map((row) => row.sha256),
      purgedAt,
    );
    db.prepare(
      `DELETE FROM user_message_state
       WHERE message_id IN (SELECT id FROM messages WHERE trashed_at IS NOT NULL)`,
    ).run();
    db.prepare(
      `DELETE FROM message_attachments
       WHERE message_id IN (SELECT id FROM messages WHERE trashed_at IS NOT NULL)`,
    ).run();
    deleteUnlinkedAttachments(db);
    db.prepare(
      `DELETE FROM deliveries
       WHERE message_id IN (SELECT id FROM messages WHERE trashed_at IS NOT NULL)`,
    ).run();
    db.prepare(
      `DELETE FROM jobs
       WHERE message_id IN (SELECT id FROM messages WHERE trashed_at IS NOT NULL)`,
    ).run();
    const result = db.prepare("DELETE FROM messages WHERE trashed_at IS NOT NULL").run();
    return { count: result.changes, paths };
  })();
}

function emptyGlobalTrash(db: Db, purgedAt: number): PurgedFiles {
  const ids = db.prepare("SELECT id FROM messages WHERE trashed_at IS NOT NULL").all() as Array<{ id: string }>;
  if (ids.length === 0) return { count: 0, paths: [] };
  let count = 0;
  const paths: string[] = [];
  db.transaction(() => {
    for (const { id } of ids) {
      const message = getMessage(db, id);
      if (!message) continue;
      const holders = [...remainingActiveOwners(db, message)].filter((uid) => uid !== OWNER_USER_ID);
      if (holders.length > 0) {
        markMessageDeletedForUser(db, OWNER_USER_ID, id, purgedAt);
        db.prepare("UPDATE messages SET trashed_at = NULL, updated_at = ? WHERE id = ?").run(purgedAt, id);
        count += 1;
        continue;
      }
      const removed = deleteMessage(db, id, purgedAt);
      if (!removed) continue;
      count += removed.count;
      paths.push(...removed.paths);
    }
  })();
  return { count, paths: [...new Set(paths)] };
}

export function emptyTrashForViewer(
  db: Db,
  viewer: ViewerContext | undefined,
  purgedAt: number,
): PurgedFiles {
  if (!viewer) return emptyTrash(db, purgedAt);
  const target = resolveViewerTarget(viewer);
  if (target.visibility === "all") return emptyGlobalTrash(db, purgedAt);

  const trashedRows = listMessages(db, { trashed: true, limit: 5_000, viewer });
  if (trashedRows.length === 0) return { count: 0, paths: [] };

  let totalCount = 0;
  const allPaths: string[] = [];
  db.transaction(() => {
    for (const item of trashedRows) {
      const res = deleteMessageForViewer(db, item.id, viewer, purgedAt);
      if (res) {
        totalCount += res.count;
        allPaths.push(...res.paths);
      }
    }
  })();
  return { count: totalCount, paths: [...new Set(allPaths)] };
}

function remainingActiveOwners(db: Db, message: StoredMessage): Set<string> {
  const recipients = parseEnvelopeArray(message.envelope_to);
  const owners = new Set<string>();
  if (recipients.length === 0) {
    owners.add(OWNER_USER_ID);
  } else {
    for (const rcpt of recipients) {
      owners.add(resolveAddressOwner(db, rcpt));
    }
  }
  const deletedRows = db
    .prepare("SELECT user_id FROM user_message_state WHERE message_id = ? AND deleted_at IS NOT NULL")
    .all(message.id) as Array<{ user_id: string }>;
  for (const row of deletedRows) {
    owners.delete(row.user_id);
  }
  return owners;
}

function rememberPurged(db: Db, hashes: string[], purgedAt: number): void {
  const insert = db.prepare(
    `INSERT INTO purged_messages (sha256, purged_at) VALUES (?, ?)
     ON CONFLICT(sha256) DO UPDATE SET purged_at = excluded.purged_at`,
  );
  for (const hash of hashes) insert.run(hash, purgedAt);
}

function orphanAttachmentPaths(db: Db, scope: "message" | "trash", messageId?: string): string[] {
  const rows =
    scope === "message"
      ? (db
          .prepare(
            `SELECT a.path AS path
             FROM attachments a
             WHERE a.sha256 IN (SELECT sha256 FROM message_attachments WHERE message_id = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM message_attachments other
                 WHERE other.sha256 = a.sha256 AND other.message_id != ?
               )`,
          )
          .all(messageId, messageId) as Array<{ path: string }>)
      : (db
          .prepare(
            `SELECT a.path AS path
             FROM attachments a
             WHERE EXISTS (
               SELECT 1 FROM message_attachments ma
               JOIN messages m ON m.id = ma.message_id
               WHERE ma.sha256 = a.sha256 AND m.trashed_at IS NOT NULL
             )
               AND NOT EXISTS (
                 SELECT 1 FROM message_attachments ma
                 JOIN messages m ON m.id = ma.message_id
                 WHERE ma.sha256 = a.sha256 AND m.trashed_at IS NULL
               )`,
          )
          .all() as Array<{ path: string }>);
  return rows.map((row) => row.path);
}

function deleteUnlinkedAttachments(db: Db): void {
  db.prepare(
    `DELETE FROM attachments
     WHERE NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.sha256 = attachments.sha256)`,
  ).run();
}

export function countTrash(db: Db, viewer?: ViewerContext): number {
  if (!viewer) {
    const row = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE trashed_at IS NOT NULL").get() as { c: number };
    return row ? row.c : 0;
  }
  return listMessages(db, { trashed: true, limit: 10_000, viewer }).length;
}

export function countUnread(db: Db): { inbox: number; spam: number } {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE
           WHEN json_extract(ai_result, '$.label') IS NULL OR json_extract(ai_result, '$.label') = 'legit'
           THEN 1 ELSE 0 END) AS inbox,
         SUM(CASE
           WHEN json_extract(ai_result, '$.label') IS NOT NULL AND json_extract(ai_result, '$.label') != 'legit'
           THEN 1 ELSE 0 END) AS spam
       FROM messages
       WHERE trashed_at IS NULL AND read_at IS NULL`,
    )
    .get() as { inbox: number | null; spam: number | null } | undefined;
  return { inbox: row?.inbox ?? 0, spam: row?.spam ?? 0 };
}

export function countUnreadForViewer(
  db: Db,
  viewer?: ViewerContext,
): { inbox: number; spam: number; promo: number } {
  if (!viewer) {
    const base = countUnread(db);
    const promoRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages
         WHERE trashed_at IS NULL AND read_at IS NULL
           AND json_extract(ai_result, '$.label') = 'unsolicited-admin'`,
      )
      .get() as { c: number } | undefined;
    return { ...base, promo: promoRow?.c ?? 0 };
  }

  const target = resolveViewerTarget(viewer);
  const useUserOverlay = target.stateUserId !== OWNER_USER_ID;
  const resolvedOwner = sqlResolvedOwner("je.value");
  const where: string[] = ["ums.deleted_at IS NULL"];
  const params: Record<string, string> = { stateUid: target.stateUserId };

  if (target.visibility === OWNER_USER_ID) {
    where.push(
      `(json_array_length(m.envelope_to) = 0 OR EXISTS (
        SELECT 1 FROM json_each(m.envelope_to) je
        WHERE ${resolvedOwner} IS NULL
      ))`,
    );
  } else if (target.visibility !== "all") {
    params.visUid = target.visibility;
    where.push(
      `EXISTS (
        SELECT 1 FROM json_each(m.envelope_to) je
        WHERE ${resolvedOwner} = :visUid
      )`,
    );
  }

  const trashedExpr = useUserOverlay ? "ums.trashed_at" : "m.trashed_at";
  const readExpr = useUserOverlay ? "ums.read_at" : "m.read_at";
  const labelExpr = useUserOverlay
    ? "COALESCE(ums.manual_label, json_extract(m.ai_result, '$.label'))"
    : "json_extract(m.ai_result, '$.label')";

  where.push(`${trashedExpr} IS NULL`);
  where.push(`${readExpr} IS NULL`);

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ${labelExpr} IS NULL OR ${labelExpr} = 'legit' THEN 1 ELSE 0 END), 0) AS inbox,
         COALESCE(SUM(CASE WHEN ${labelExpr} IS NOT NULL AND ${labelExpr} != 'legit' THEN 1 ELSE 0 END), 0) AS spam,
         COALESCE(SUM(CASE WHEN ${labelExpr} = 'unsolicited-admin' THEN 1 ELSE 0 END), 0) AS promo
       FROM messages m
       LEFT JOIN user_message_state ums ON ums.user_id = :stateUid AND ums.message_id = m.id
       WHERE ${where.join(" AND ")}`,
    )
    .get(params) as { inbox: number; spam: number; promo: number } | undefined;

  return {
    inbox: row?.inbox ?? 0,
    spam: row?.spam ?? 0,
    promo: row?.promo ?? 0,
  };
}

function parseEnvelopeArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

function safeParseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function applyManualLabelJson(rawAi: string | null, manualLabel: string): string {
  const base = safeParseObject(rawAi);
  const originalLabel =
    typeof base.originalLabel === "string"
      ? base.originalLabel
      : typeof base.label === "string"
        ? base.label
        : null;
  const originalConfidence =
    typeof base.originalConfidence === "number"
      ? base.originalConfidence
      : typeof base.confidence === "number"
        ? base.confidence
        : null;
  return JSON.stringify({
    ...base,
    schema: 1,
    prompt_id: typeof base.prompt_id === "string" ? base.prompt_id : "manual",
    model: typeof base.model === "string" ? base.model : "manual",
    provider: typeof base.provider === "string" ? base.provider : "manual",
    at: typeof base.at === "string" ? base.at : new Date(0).toISOString(),
    confidence: typeof base.confidence === "number" ? base.confidence : 1,
    summary: typeof base.summary === "string" ? base.summary : "已手动修改分类",
    tags: Array.isArray(base.tags) ? base.tags : [],
    signals: Array.isArray(base.signals) ? base.signals : [],
    label: manualLabel,
    manualOverride: true,
    originalLabel,
    originalConfidence,
  });
}
