import type { Db } from "../index.js";

export type MessageStatus =
  | "received"
  | "authed"
  | "parsed"
  | "classified"
  | "notified"
  | "error";

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
  read_at?: number | null;
  starred_at?: number | null;
  recipient_addr?: string | null;
  label_override?: string | null;
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

export function getMessageForUser(db: Db, id: string, userId?: string): StoredMessage | undefined {
  if (!userId) return getMessage(db, id);
  return db
    .prepare(
      `SELECT m.id, m.sha256, m.raw_path, m.size_bytes, m.received_at, m.envelope_from, m.envelope_to, m.domains,
              m.message_id, m.in_reply_to, m.ref_ids, m.thread_key, m.subject, m.from_addr, m.to_addrs,
              m.smtp_meta, m.auth_result, m.parsed, m.ai_result, m.status, m.error,
              um.trashed_at AS trashed_at, um.read_at AS read_at, um.starred_at AS starred_at,
              um.recipient_addr AS recipient_addr, um.label_override AS label_override
       FROM messages m
       JOIN user_messages um ON um.message_id = m.id AND um.user_id = ?
       WHERE m.id = ?`,
    )
    .get(userId, id) as StoredMessage | undefined;
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

export function markMessageRead(db: Db, id: string, now: number, userId?: string): void {
  if (!userId) {
    db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL").run(now, id);
    db.prepare("UPDATE user_messages SET read_at = ? WHERE message_id = ? AND read_at IS NULL").run(now, id);
    return;
  }
  db.transaction(() => {
    db.prepare(
      "UPDATE user_messages SET read_at = ? WHERE user_id = ? AND message_id = ? AND read_at IS NULL",
    ).run(now, userId, id);
    if (holderCount(db, id) <= 1) {
      db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL").run(now, id);
    }
  })();
}

export function markMessageUnread(db: Db, id: string, userId?: string): void {
  if (!userId) {
    db.prepare("UPDATE messages SET read_at = NULL WHERE id = ?").run(id);
    db.prepare("UPDATE user_messages SET read_at = NULL WHERE message_id = ?").run(id);
    return;
  }
  db.transaction(() => {
    db.prepare("UPDATE user_messages SET read_at = NULL WHERE user_id = ? AND message_id = ?").run(userId, id);
    if (holderCount(db, id) <= 1) {
      db.prepare("UPDATE messages SET read_at = NULL WHERE id = ?").run(id);
    }
  })();
}

export function setMessageStar(db: Db, id: string, starred: boolean, now: number, userId?: string): void {
  const val = starred ? now : null;
  if (!userId) {
    db.prepare("UPDATE user_messages SET starred_at = ? WHERE message_id = ?").run(val, id);
    return;
  }
  db.prepare("UPDATE user_messages SET starred_at = ? WHERE user_id = ? AND message_id = ?").run(val, userId, id);
}

export function markAllMessagesRead(
  db: Db,
  options: { userId?: string; view?: "inbox" | "promo" | "spam" | "all"; to?: string; now: number },
): number {
  const { userId, view = "inbox", to, now } = options;
  if (!userId) {
    const where = ["trashed_at IS NULL", "read_at IS NULL"];
    const params: Record<string, string | number> = { now };
    if (view === "inbox") {
      where.push("(json_extract(ai_result, '$.label') IS NULL OR json_extract(ai_result, '$.label') = 'legit')");
    } else if (view === "promo") {
      where.push("json_extract(ai_result, '$.label') = 'unsolicited-admin'");
    } else if (view === "spam") {
      where.push("(json_extract(ai_result, '$.label') IS NOT NULL AND json_extract(ai_result, '$.label') != 'legit')");
    }
    if (to) {
      where.push("EXISTS (SELECT 1 FROM json_each(envelope_to) WHERE lower(json_each.value) = lower(:toAddr))");
      params.toAddr = to;
    }
    const res = db
      .prepare(`UPDATE messages SET read_at = :now WHERE ${where.join(" AND ")}`)
      .run(params);
    return res.changes;
  }

  const labelExpr = "COALESCE(um.label_override, json_extract(m.ai_result, '$.label'))";
  const where = ["um.user_id = :userId", "um.trashed_at IS NULL", "um.read_at IS NULL"];
  const params: Record<string, string | number> = { userId, now };
  if (view === "inbox") {
    where.push(`(${labelExpr} IS NULL OR ${labelExpr} = 'legit')`);
  } else if (view === "promo") {
    where.push(`${labelExpr} = 'unsolicited-admin'`);
  } else if (view === "spam") {
    where.push(`(${labelExpr} IS NOT NULL AND ${labelExpr} != 'legit')`);
  }
  if (to) {
    where.push(
      `(lower(IFNULL(um.recipient_addr, '')) = lower(:toAddr)
        OR EXISTS (SELECT 1 FROM json_each(m.envelope_to) WHERE lower(json_each.value) = lower(:toAddr)))`,
    );
    params.toAddr = to;
  }

  const res = db
    .prepare(
      `UPDATE user_messages
       SET read_at = :now
       WHERE user_id = :userId
         AND message_id IN (
           SELECT um.message_id
           FROM user_messages um
           JOIN messages m ON m.id = um.message_id
           WHERE ${where.join(" AND ")}
         )`,
    )
    .run(params);
  return res.changes;
}

export function saveAiResult(db: Db, id: string, aiResult: string, now: number): void {
  db.prepare(
    `UPDATE messages
     SET ai_result = ?, status = 'classified', error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(aiResult, now, id);
}

export function overrideMessageLabel(
  db: Db,
  input: {
    id: string;
    label: string;
    actor: string;
    now: number;
    userId?: string;
    isAdmin?: boolean;
  },
): { prevLabel: string; originalLabel: string | null; originalConfidence: number | null } {
  const message = getMessage(db, input.id);
  if (!message) throw new Error("message not found");

  let existingAi: Record<string, unknown> = {};
  if (message.ai_result) {
    try {
      const parsed = JSON.parse(message.ai_result) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existingAi = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      existingAi = {};
    }
  }

  const origLabel =
    typeof existingAi.originalLabel === "string"
      ? existingAi.originalLabel
      : typeof existingAi.label === "string"
        ? existingAi.label
        : null;
  const origConf =
    typeof existingAi.originalConfidence === "number"
      ? existingAi.originalConfidence
      : typeof existingAi.confidence === "number"
        ? existingAi.confidence
        : null;
  const prevLabel = typeof existingAi.label === "string" ? existingAi.label : "none";

  const shared = input.userId ? holderCount(db, input.id) > 1 : false;

  db.transaction(() => {
    if (input.userId) {
      db.prepare(
        "UPDATE user_messages SET label_override = ? WHERE user_id = ? AND message_id = ?",
      ).run(input.label, input.userId, input.id);
    }
    if (!shared || input.isAdmin || !input.userId) {
      const ai: Record<string, unknown> = { ...existingAi };
      if (origLabel !== null) ai.originalLabel = origLabel;
      if (origConf !== null || ai.originalLabel !== undefined) ai.originalConfidence = origConf;
      ai.schema = 1;
      if (typeof ai.prompt_id !== "string" || !ai.prompt_id) ai.prompt_id = "manual";
      if (typeof ai.model !== "string" || !ai.model) ai.model = "manual";
      if (typeof ai.provider !== "string" || !ai.provider) ai.provider = "manual";
      if (typeof ai.at !== "string" || !ai.at) ai.at = new Date(input.now).toISOString();
      if (typeof ai.confidence !== "number") ai.confidence = 1;
      if (typeof ai.summary !== "string" || !ai.summary) ai.summary = "已手动修改分类";
      if (!Array.isArray(ai.tags)) ai.tags = [];
      if (!Array.isArray(ai.signals)) ai.signals = [];
      ai.label = input.label;
      ai.manualOverride = true;
      ai.overrideActor = input.actor;
      ai.overrideAt = input.now;
      db.prepare("UPDATE messages SET ai_result = ?, status = 'classified', updated_at = ? WHERE id = ?").run(
        JSON.stringify(ai),
        input.now,
        input.id,
      );
    }
  })();

  return { prevLabel, originalLabel: origLabel, originalConfidence: origConf };
}

export interface MessageListQuery {
  userId?: string;
  label?: string;
  status?: string;
  trashed?: boolean | "all";
  starred?: boolean;
  unread?: boolean;
  to?: string;
  q?: string;
  from?: string;
  domain?: string;
  since?: number;
  until?: number;
  limit: number;
  cursorAt?: number;
  cursorId?: string;
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
  parsed: string | null;
  trashed_at: number | null;
  read_at: number | null;
  starred_at?: number | null;
  recipient_addr?: string | null;
  label_override?: string | null;
}

export function listMessages(db: Db, query: MessageListQuery): MessageListRow[] {
  if (query.userId) {
    return listMessagesForUser(db, query.userId, query);
  }
  const where: string[] = [];
  const params: Record<string, string | number> = { limit: query.limit };
  if (query.trashed === true) {
    where.push("m.trashed_at IS NOT NULL");
  } else if (query.trashed === "all") {
    // no filter on trashed_at
  } else {
    where.push("m.trashed_at IS NULL");
  }
  if (query.unread === true) {
    where.push("m.read_at IS NULL");
  }
  if (query.starred === true) {
    where.push("EXISTS (SELECT 1 FROM user_messages um_s WHERE um_s.message_id = m.id AND um_s.starred_at IS NOT NULL)");
  }
  if (query.status) {
    where.push("m.status = :status");
    params.status = query.status;
  }
  if (query.label === "legit") {
    where.push("(json_extract(m.ai_result, '$.label') = 'legit' OR json_extract(m.ai_result, '$.label') IS NULL)");
  } else if (query.label === "not-legit") {
    where.push("(json_extract(m.ai_result, '$.label') IS NOT NULL AND json_extract(m.ai_result, '$.label') != 'legit')");
  } else if (query.label) {
    where.push("json_extract(m.ai_result, '$.label') = :label");
    params.label = query.label;
  }
  if (query.from) {
    where.push("lower(m.from_addr) = lower(:fromAddr)");
    params.fromAddr = query.from;
  }
  if (query.to) {
    where.push("EXISTS (SELECT 1 FROM json_each(m.envelope_to) WHERE lower(json_each.value) = lower(:toAddr))");
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
  const sql = `SELECT m.id, m.sha256, m.received_at, m.size_bytes, m.envelope_from, m.envelope_to, m.message_id,
                      m.subject, m.from_addr, m.domains, m.status, m.ai_result, m.parsed, m.trashed_at, m.read_at
               FROM messages m
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY m.received_at DESC, m.id DESC
               LIMIT :limit`;
  return db.prepare(sql).all(params) as MessageListRow[];
}

function listMessagesForUser(db: Db, userId: string, query: MessageListQuery): MessageListRow[] {
  const where: string[] = ["um.user_id = :userId"];
  const params: Record<string, string | number> = { userId, limit: query.limit };
  const labelExpr = "COALESCE(um.label_override, json_extract(m.ai_result, '$.label'))";

  if (query.trashed === true) {
    where.push("um.trashed_at IS NOT NULL");
  } else if (query.trashed === "all") {
    // no filter on trashed_at
  } else {
    where.push("um.trashed_at IS NULL");
  }
  if (query.starred === true) {
    where.push("um.starred_at IS NOT NULL");
  }
  if (query.unread === true) {
    where.push("um.read_at IS NULL");
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
      `(lower(IFNULL(um.recipient_addr, '')) = lower(:toAddr)
        OR EXISTS (SELECT 1 FROM json_each(m.envelope_to) WHERE lower(json_each.value) = lower(:toAddr)))`,
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
      IFNULL(m.message_id, '') LIKE :q ESCAPE '\\' OR
      IFNULL(um.recipient_addr, '') LIKE :q ESCAPE '\\'
    )`);
    params.q = likeContains(query.q);
  }
  if (query.since !== undefined) {
    where.push("um.received_at >= :since");
    params.since = query.since;
  }
  if (query.until !== undefined) {
    where.push("um.received_at <= :until");
    params.until = query.until;
  }
  if (query.cursorAt !== undefined && query.cursorId) {
    where.push("(um.received_at < :cursorAt OR (um.received_at = :cursorAt AND um.message_id < :cursorId))");
    params.cursorAt = query.cursorAt;
    params.cursorId = query.cursorId;
  }

  const sql = `SELECT m.id, m.sha256, m.received_at, m.size_bytes, m.envelope_from, m.envelope_to, m.message_id,
                      m.subject, m.from_addr, m.domains, m.status, m.ai_result, m.parsed,
                      um.trashed_at AS trashed_at, um.read_at AS read_at, um.starred_at AS starred_at,
                      um.recipient_addr AS recipient_addr, um.label_override AS label_override
               FROM user_messages um
               JOIN messages m ON m.id = um.message_id
               WHERE ${where.join(" AND ")}
               ORDER BY um.received_at DESC, um.message_id DESC
               LIMIT :limit`;
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

export function trashMessage(db: Db, id: string, now: number, userId?: string): void {
  if (!userId) {
    db.prepare("UPDATE messages SET trashed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    db.prepare("UPDATE user_messages SET trashed_at = ? WHERE message_id = ?").run(now, id);
    return;
  }
  db.transaction(() => {
    db.prepare("UPDATE user_messages SET trashed_at = ? WHERE user_id = ? AND message_id = ?").run(now, userId, id);
    if (untrashedHolderCount(db, id) === 0) {
      db.prepare("UPDATE messages SET trashed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    }
  })();
}

export function restoreMessage(db: Db, id: string, now: number, userId?: string): void {
  if (!userId) {
    db.prepare("UPDATE messages SET trashed_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
    db.prepare("UPDATE user_messages SET trashed_at = NULL WHERE message_id = ?").run(id);
    return;
  }
  db.transaction(() => {
    db.prepare("UPDATE user_messages SET trashed_at = NULL WHERE user_id = ? AND message_id = ?").run(userId, id);
    db.prepare("UPDATE messages SET trashed_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
  })();
}

export interface PurgedFiles {
  count: number;
  paths: string[];
}

export function deleteMessage(db: Db, id: string, purgedAt: number, userId?: string): PurgedFiles | null {
  if (!userId) {
    return purgePhysicalMessage(db, id, purgedAt);
  }
  return db.transaction(() => {
    const removed = db
      .prepare("DELETE FROM user_messages WHERE user_id = ? AND message_id = ?")
      .run(userId, id);
    if (removed.changes === 0) return null;
    if (holderCount(db, id) > 0) {
      return { count: 1, paths: [] };
    }
    return purgePhysicalMessage(db, id, purgedAt);
  })();
}

function purgePhysicalMessage(db: Db, id: string, purgedAt: number): PurgedFiles | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT sha256, raw_path FROM messages WHERE id = ?").get(id) as
      | { sha256: string; raw_path: string }
      | undefined;
    if (!row) return null;
    const paths = [row.raw_path, ...orphanAttachmentPaths(db, "message", id)];
    rememberPurged(db, [row.sha256], purgedAt);
    db.prepare("DELETE FROM user_messages WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM message_attachments WHERE message_id = ?").run(id);
    deleteUnlinkedAttachments(db);
    db.prepare("DELETE FROM deliveries WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM jobs WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    return { count: 1, paths };
  })();
}

export function emptyTrash(db: Db, purgedAt: number, userId?: string): PurgedFiles {
  if (!userId) {
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
        `DELETE FROM user_messages
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

  return db.transaction(() => {
    const targetRows = db
      .prepare("SELECT message_id FROM user_messages WHERE user_id = ? AND trashed_at IS NOT NULL")
      .all(userId) as Array<{ message_id: string }>;
    if (targetRows.length === 0) return { count: 0, paths: [] };

    db.prepare("DELETE FROM user_messages WHERE user_id = ? AND trashed_at IS NOT NULL").run(userId);
    const paths: string[] = [];
    for (const item of targetRows) {
      if (holderCount(db, item.message_id) === 0) {
        const purged = purgePhysicalMessage(db, item.message_id, purgedAt);
        if (purged) paths.push(...purged.paths);
      }
    }
    return { count: targetRows.length, paths };
  })();
}

export function batchMutateMessages(
  db: Db,
  input: {
    ids: readonly string[];
    action: "read" | "unread" | "star" | "unstar" | "trash" | "restore" | "delete" | "label";
    label?: string;
    actor: string;
    now: number;
    userId?: string;
    isAdmin?: boolean;
  },
): PurgedFiles {
  return db.transaction(() => {
    let count = 0;
    const paths: string[] = [];
    for (const id of input.ids) {
      const visible = input.userId ? getMessageForUser(db, id, input.userId) : getMessage(db, id);
      if (!visible) continue;
      count += 1;
      switch (input.action) {
        case "read":
          markMessageRead(db, id, input.now, input.userId);
          break;
        case "unread":
          markMessageUnread(db, id, input.userId);
          break;
        case "star":
          setMessageStar(db, id, true, input.now, input.userId);
          break;
        case "unstar":
          setMessageStar(db, id, false, input.now, input.userId);
          break;
        case "trash":
          trashMessage(db, id, input.now, input.userId);
          break;
        case "restore":
          restoreMessage(db, id, input.now, input.userId);
          break;
        case "delete": {
          const purged = deleteMessage(db, id, input.now, input.userId);
          if (purged) paths.push(...purged.paths);
          break;
        }
        case "label":
          if (input.label) {
            overrideMessageLabel(db, {
              id,
              label: input.label,
              actor: input.actor,
              now: input.now,
              userId: input.userId,
              isAdmin: input.isAdmin,
            });
          }
          break;
      }
    }
    return { count, paths };
  })();
}

export function userHasAttachmentAccess(db: Db, userId: string, sha256: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok
       FROM message_attachments ma
       JOIN user_messages um ON um.message_id = ma.message_id
       WHERE ma.sha256 = ? AND um.user_id = ?
       LIMIT 1`,
    )
    .get(sha256, userId);
  return Boolean(row);
}

function holderCount(db: Db, messageId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM user_messages WHERE message_id = ?")
    .get(messageId) as { c: number };
  return row.c;
}

function untrashedHolderCount(db: Db, messageId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM user_messages WHERE message_id = ? AND trashed_at IS NULL")
    .get(messageId) as { c: number };
  return row.c;
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

export function countTrash(db: Db, userId?: string): number {
  if (!userId) {
    const row = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE trashed_at IS NOT NULL").get() as { c: number };
    return row ? row.c : 0;
  }
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM user_messages WHERE user_id = ? AND trashed_at IS NOT NULL")
    .get(userId) as { c: number };
  return row ? row.c : 0;
}

export function countUnread(db: Db, userId?: string): { inbox: number; spam: number } {
  if (!userId) {
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

  const labelExpr = "COALESCE(um.label_override, json_extract(m.ai_result, '$.label'))";
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN ${labelExpr} IS NULL OR ${labelExpr} = 'legit' THEN 1 ELSE 0 END) AS inbox,
         SUM(CASE WHEN ${labelExpr} IS NOT NULL AND ${labelExpr} != 'legit' THEN 1 ELSE 0 END) AS spam
       FROM user_messages um
       JOIN messages m ON m.id = um.message_id
       WHERE um.user_id = ? AND um.trashed_at IS NULL AND um.read_at IS NULL`,
    )
    .get(userId) as { inbox: number | null; spam: number | null } | undefined;
  return { inbox: row?.inbox ?? 0, spam: row?.spam ?? 0 };
}
