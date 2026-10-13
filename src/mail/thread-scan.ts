import type { Codec } from "../compress.js";
import type { Db } from "../db/index.js";
import { readRaw } from "../ingest/read-raw.js";
import type { AppLog } from "../log.js";
import { normalizeMessageId, readThreadHeaders, threadKeyOf } from "./thread.js";

const FLAG = "thread_scan";

/** Read reply headers once. A crash before the flag leaves the rest for the next boot. */
export async function backfillThreadHeaders(db: Db, dataDir: string, codec: Codec, log: AppLog): Promise<void> {
  const flag = db.prepare("SELECT value FROM settings WHERE key = ?").get(FLAG) as { value: string } | undefined;
  if (flag?.value === "1") return;
  const messages = unreadRows(db, "messages");
  const sent = unreadRows(db, "outbox");
  let missed = 0;
  for (const row of messages) {
    if (!(await stamp(db, dataDir, codec, row, "messages"))) missed += 1;
  }
  for (const row of sent) {
    if (!(await stamp(db, dataDir, codec, row, "outbox"))) missed += 1;
  }
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
  ).run(FLAG, Date.now());
  log.info({ messages: messages.length, sent: sent.length, missed }, "thread headers scanned");
}

interface ScanRow {
  id: string;
  raw_path: string;
  sha256: string;
  message_id: string | null;
}

function unreadRows(db: Db, table: "messages" | "outbox"): ScanRow[] {
  const extra = table === "outbox" ? "AND message_id IS NULL" : "";
  return db
    .prepare(
      `SELECT id, raw_path, sha256, message_id FROM ${table}
       WHERE in_reply_to IS NULL AND ref_ids IS NULL AND thread_key IS NULL ${extra}`,
    )
    .all() as ScanRow[];
}

async function stamp(
  db: Db,
  dataDir: string,
  codec: Codec,
  row: ScanRow,
  table: "messages" | "outbox",
): Promise<boolean> {
  try {
    const raw = await readRaw(dataDir, row.raw_path, codec, row.sha256);
    const headers = readThreadHeaders(raw);
    const messageId = headers.messageId ?? normalizeMessageId(row.message_id);
    const refIds = headers.refs.length > 0 ? JSON.stringify(headers.refs) : null;
    db.prepare(
      `UPDATE ${table}
       SET message_id = COALESCE(?, message_id), in_reply_to = ?, ref_ids = ?, thread_key = ?
       WHERE id = ?`,
    ).run(messageId, headers.inReplyTo, refIds, threadKeyOf(messageId, headers.inReplyTo, headers.refs), row.id);
    return true;
  } catch {
    return false;
  }
}
