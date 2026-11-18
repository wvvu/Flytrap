import type { Db } from "../index.js";
import { memberMessageMatchSql, type UserRole } from "./users.js";

export type MessageStatus =
  | "received"
  | "authed"
  | "parsed"
  | "classified"
  | "notified"
  | "error";

export interface ViewerScope {
  userId: string;
  role: UserRole;
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
      domains, smtp_meta, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
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
  read_at: number | null;
  starred_at: number | null;
  label_override?: string | null;
}

export function getMessage(db: Db, id: string): StoredMessage | undefined {
  return db
    .prepare(
      `SELECT id, sha256, raw_path, size_bytes, received_at, envelope_from, envelope_to, domains,
              message_id, in_reply_to, ref_ids, thread_key, subject, from_addr, to_addrs, smtp_meta, auth_result, parsed, ai_result,
              status, error, trashed_at, read_at, starred_at
       FROM messages WHERE id = ?`,
    )
    .get(id) as StoredMessage | undefined;
}

export function getMessageForViewer(db: Db, id: string, viewer?: ViewerScope): StoredMessage | undefined {
  if (!viewer || viewer.role === "admin") {
    return getMessage(db, id);
  }
  const sql = `
    SELECT m.id, m.sha256, m.raw_path, m.size_bytes, m.received_at, m.envelope_from, m.envelope_to, m.domains,
           m.message_id, m.in_reply_to, m.ref_ids, m.thread_key, m.subject, m.from_addr, m.to_addrs,
           m.smtp_meta, m.auth_result, m.parsed, m.ai_result, m.status, m.error,
           ums.trashed_at AS trashed_at,
           ums.read_at AS read_at,
           ums.starred_at AS starred_at,
           ums.label_override AS label_override
    FROM messages m
    LEFT JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
    WHERE m.id = :id
      AND ums.deleted_at IS NULL
      AND ${memberMessageMatchSql("m", ":viewerUserId")}
  `;
  return db.prepare(sql).get({ id, viewerUserId: viewer.userId }) as StoredMessage | undefined;
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

export function markMessageRead(db: Db, id: string, now: number, viewer?: ViewerScope): void {
  if (viewer && viewer.role === "member") {
    db.prepare(
      `INSERT INTO user_message_state (user_id, message_id, read_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET
         read_at = COALESCE(user_message_state.read_at, excluded.read_at),
         updated_at = excluded.updated_at`,
    ).run(viewer.userId, id, now, now);
    return;
  }
  db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL").run(now, id);
}

export function markMessageUnread(db: Db, id: string, now: number, viewer?: ViewerScope): void {
  if (viewer && viewer.role === "member") {
    db.prepare(
      `INSERT INTO user_message_state (user_id, message_id, read_at, updated_at)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET read_at = NULL, updated_at = excluded.updated_at`,
    ).run(viewer.userId, id, now);
    return;
  }
  db.prepare("UPDATE messages SET read_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
}

export function setMessageStarred(db: Db, id: string, starred: boolean, now: number, viewer?: ViewerScope): void {
  const stamp = starred ? now : null;
  if (viewer && viewer.role === "member") {
    db.prepare(
      `INSERT INTO user_message_state (user_id, message_id, starred_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET starred_at = excluded.starred_at, updated_at = excluded.updated_at`,
    ).run(viewer.userId, id, stamp, now);
    return;
  }
  db.prepare("UPDATE messages SET starred_at = ?, updated_at = ? WHERE id = ?").run(stamp, now, id);
}

export function setMemberLabelOverride(db: Db, userId: string, messageId: string, label: string, now: number): void {
  db.prepare(
    `INSERT INTO user_message_state (user_id, message_id, label_override, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET label_override = excluded.label_override, updated_at = excluded.updated_at`,
  ).run(userId, messageId, label, now);
}

export function markAllMessagesRead(
  db: Db,
  scope: "inbox" | "promo" | "spam" | "all",
  now: number,
  viewer?: ViewerScope,
): number {
  if (viewer && viewer.role === "member") {
    const effLabel = "COALESCE(ums.label_override, json_extract(m.ai_result, '$.label'))";
    let extra = "";
    if (scope === "inbox") extra = `AND (${effLabel} IS NULL OR ${effLabel} = 'legit')`;
    else if (scope === "promo") extra = `AND ${effLabel} = 'unsolicited-admin'`;
    else if (scope === "spam") extra = `AND (${effLabel} IS NOT NULL AND ${effLabel} != 'legit')`;

    const unreadRows = db
      .prepare(
        `SELECT m.id
         FROM messages m
         LEFT JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
         WHERE ums.deleted_at IS NULL
           AND ums.trashed_at IS NULL
           AND ums.read_at IS NULL
           AND ${memberMessageMatchSql("m", ":viewerUserId")}
           ${extra}`,
      )
      .all({ viewerUserId: viewer.userId }) as Array<{ id: string }>;

    if (unreadRows.length === 0) return 0;
    const upsert = db.prepare(
      `INSERT INTO user_message_state (user_id, message_id, read_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET
         read_at = COALESCE(user_message_state.read_at, excluded.read_at),
         updated_at = excluded.updated_at`,
    );
    db.transaction(() => {
      for (const row of unreadRows) upsert.run(viewer.userId, row.id, now, now);
    })();
    return unreadRows.length;
  }

  let extra = "";
  if (scope === "inbox") {
    extra = "AND (json_extract(ai_result, '$.label') IS NULL OR json_extract(ai_result, '$.label') = 'legit')";
  } else if (scope === "promo") {
    extra = "AND json_extract(ai_result, '$.label') = 'unsolicited-admin'";
  } else if (scope === "spam") {
    extra = "AND json_extract(ai_result, '$.label') IS NOT NULL AND json_extract(ai_result, '$.label') != 'legit'";
  }
  const res = db
    .prepare(`UPDATE messages SET read_at = ? WHERE trashed_at IS NULL AND read_at IS NULL ${extra}`)
    .run(now);
  return res.changes;
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
  unread?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  q?: string;
  from?: string;
  to?: string;
  domain?: string;
  memberId?: string;
  since?: number;
  until?: number;
  limit: number;
  cursorAt?: number;
  cursorId?: string;
  viewer?: ViewerScope;
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
  attachment_count: number;
  label_override: string | null;
}

export function listMessages(db: Db, query: MessageListQuery): MessageListRow[] {
  const isMember = query.viewer?.role === "member";
  const where: string[] = [];
  const params: Record<string, string | number> = { limit: query.limit };

  const trashedCol = isMember ? "ums.trashed_at" : "m.trashed_at";
  const readCol = isMember ? "ums.read_at" : "m.read_at";
  const starredCol = isMember ? "ums.starred_at" : "m.starred_at";
  const labelExpr = isMember
    ? "COALESCE(ums.label_override, json_extract(m.ai_result, '$.label'))"
    : "json_extract(m.ai_result, '$.label')";

  if (isMember && query.viewer) {
    params.viewerUserId = query.viewer.userId;
    where.push("ums.deleted_at IS NULL");
    where.push(memberMessageMatchSql("m", ":viewerUserId"));
  } else if (query.memberId) {
    params.filterMemberId = query.memberId;
    where.push(memberMessageMatchSql("m", ":filterMemberId"));
  }

  if (query.trashed === true) {
    where.push(`${trashedCol} IS NOT NULL`);
  } else if (query.trashed === "all") {
    // no filter on trashed_at
  } else {
    where.push(`${trashedCol} IS NULL`);
  }

  if (query.unread === true) {
    where.push(`${readCol} IS NULL`);
  } else if (query.unread === false) {
    where.push(`${readCol} IS NOT NULL`);
  }

  if (query.starred === true) {
    where.push(`${starredCol} IS NOT NULL`);
  }

  if (query.hasAttachments === true) {
    where.push("COALESCE(CAST(json_extract(m.parsed, '$.attachmentCount') AS INTEGER), 0) > 0");
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

  if (query.to) {
    where.push(
      `(EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.envelope_to) THEN m.envelope_to ELSE '[]' END) je WHERE lower(je.value) = lower(:toAddr))
        OR (m.to_addrs IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_addrs) THEN m.to_addrs ELSE '[]' END) jt WHERE lower(jt.value) = lower(:toAddr))))`,
    );
    params.toAddr = query.to;
  }

  if (query.domain) {
    where.push("EXISTS (SELECT 1 FROM json_each(m.domains) WHERE lower(json_each.value) = lower(:domain))");
    params.domain = query.domain;
  }

  if (query.q) {
    where.push(`(
      IFNULL(m.subject, '') LIKE :q ESCAPE '\\' OR
      IFNULL(m.from_addr, '') LIKE :q ESCAPE '\\' OR
      IFNULL(m.envelope_to, '') LIKE :q ESCAPE '\\' OR
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

  const joinSql = isMember
    ? "LEFT JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id"
    : "";

  const sql = `
    SELECT m.id, m.sha256, m.received_at, m.size_bytes, m.envelope_from, m.envelope_to, m.message_id,
           m.subject, m.from_addr, m.domains, m.status, m.ai_result,
           ${trashedCol} AS trashed_at,
           ${readCol} AS read_at,
           ${starredCol} AS starred_at,
           COALESCE(CAST(json_extract(m.parsed, '$.attachmentCount') AS INTEGER), 0) AS attachment_count,
           ${isMember ? "ums.label_override" : "NULL"} AS label_override
    FROM messages m
    ${joinSql}
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY m.received_at DESC, m.id DESC
    LIMIT :limit
  `;
  return db.prepare(sql).all(params) as MessageListRow[];
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function markMessageNotified(db: Db, id: string, now: number): void {
  db.prepare(
    `UPDATE messages SET status = 'notified', error = NULL, updated_at = ? WHERE id = ?`,
  ).run(now, id);
}

export function trashMessage(db: Db, id: string, now: number, viewer?: ViewerScope): void {
  if (viewer && viewer.role === "member") {
    db.prepare(
      `INSERT INTO user_message_state (user_id, message_id, trashed_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET trashed_at = excluded.trashed_at, updated_at = excluded.updated_at`,
    ).run(viewer.userId, id, now, now);
    return;
  }
  db.prepare("UPDATE messages SET trashed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
}

export function restoreMessage(db: Db, id: string, now: number, viewer?: ViewerScope): void {
  if (viewer && viewer.role === "member") {
    db.prepare(
      `INSERT INTO user_message_state (user_id, message_id, trashed_at, updated_at)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET trashed_at = NULL, updated_at = excluded.updated_at`,
    ).run(viewer.userId, id, now);
    return;
  }
  db.prepare("UPDATE messages SET trashed_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
}

export function softDeleteMemberMessage(db: Db, userId: string, messageId: string, now: number): void {
  db.prepare(
    `INSERT INTO user_message_state (user_id, message_id, deleted_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`,
  ).run(userId, messageId, now, now);
}

export function emptyMemberTrash(db: Db, userId: string, now: number): number {
  const rows = db
    .prepare(
      `SELECT m.id
       FROM messages m
       JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
       WHERE ums.deleted_at IS NULL
         AND ums.trashed_at IS NOT NULL
         AND ${memberMessageMatchSql("m", ":viewerUserId")}`,
    )
    .all({ viewerUserId: userId }) as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  const mark = db.prepare("UPDATE user_message_state SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND message_id = ?");
  db.transaction(() => {
    for (const row of rows) mark.run(now, now, userId, row.id);
  })();
  return rows.length;
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

export function countTrash(db: Db, viewer?: ViewerScope): number {
  if (viewer && viewer.role === "member") {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM messages m
         JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
         WHERE ums.deleted_at IS NULL
           AND ums.trashed_at IS NOT NULL
           AND ${memberMessageMatchSql("m", ":viewerUserId")}`,
      )
      .get({ viewerUserId: viewer.userId }) as { c: number } | undefined;
    return row ? row.c : 0;
  }
  const row = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE trashed_at IS NOT NULL").get() as { c: number };
  return row ? row.c : 0;
}

export function countRoomBadges(
  db: Db,
  viewer?: ViewerScope,
): { inbox: number; spam: number; promo: number; starred: number; trash: number } {
  if (viewer && viewer.role === "member") {
    const effLabel = "COALESCE(ums.label_override, json_extract(m.ai_result, '$.label'))";
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN ums.trashed_at IS NULL AND ums.read_at IS NULL AND (${effLabel} IS NULL OR ${effLabel} = 'legit') THEN 1 ELSE 0 END) AS inbox,
           SUM(CASE WHEN ums.trashed_at IS NULL AND ums.read_at IS NULL AND (${effLabel} IS NOT NULL AND ${effLabel} != 'legit') THEN 1 ELSE 0 END) AS spam,
           SUM(CASE WHEN ums.trashed_at IS NULL AND ums.read_at IS NULL AND ${effLabel} = 'unsolicited-admin' THEN 1 ELSE 0 END) AS promo,
           SUM(CASE WHEN ums.trashed_at IS NULL AND ums.starred_at IS NOT NULL THEN 1 ELSE 0 END) AS starred,
           SUM(CASE WHEN ums.trashed_at IS NOT NULL THEN 1 ELSE 0 END) AS trash
         FROM messages m
         LEFT JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
         WHERE ums.deleted_at IS NULL
           AND ${memberMessageMatchSql("m", ":viewerUserId")}`,
      )
      .get({ viewerUserId: viewer.userId }) as
      | { inbox: number | null; spam: number | null; promo: number | null; starred: number | null; trash: number | null }
      | undefined;
    return {
      inbox: row?.inbox ?? 0,
      spam: row?.spam ?? 0,
      promo: row?.promo ?? 0,
      starred: row?.starred ?? 0,
      trash: row?.trash ?? 0,
    };
  }

  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN trashed_at IS NULL AND read_at IS NULL AND (json_extract(ai_result, '$.label') IS NULL OR json_extract(ai_result, '$.label') = 'legit') THEN 1 ELSE 0 END) AS inbox,
         SUM(CASE WHEN trashed_at IS NULL AND read_at IS NULL AND (json_extract(ai_result, '$.label') IS NOT NULL AND json_extract(ai_result, '$.label') != 'legit') THEN 1 ELSE 0 END) AS spam,
         SUM(CASE WHEN trashed_at IS NULL AND read_at IS NULL AND json_extract(ai_result, '$.label') = 'unsolicited-admin' THEN 1 ELSE 0 END) AS promo,
         SUM(CASE WHEN trashed_at IS NULL AND starred_at IS NOT NULL THEN 1 ELSE 0 END) AS starred,
         SUM(CASE WHEN trashed_at IS NOT NULL THEN 1 ELSE 0 END) AS trash
       FROM messages`,
    )
    .get() as
    | { inbox: number | null; spam: number | null; promo: number | null; starred: number | null; trash: number | null }
    | undefined;
  return {
    inbox: row?.inbox ?? 0,
    spam: row?.spam ?? 0,
    promo: row?.promo ?? 0,
    starred: row?.starred ?? 0,
    trash: row?.trash ?? 0,
  };
}

export function countUnread(db: Db, viewer?: ViewerScope): { inbox: number; spam: number } {
  const badges = countRoomBadges(db, viewer);
  return { inbox: badges.inbox, spam: badges.spam };
}
