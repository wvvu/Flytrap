import type { Db } from "../index.js";
import { canViewerAccessMessage, getMessage, type ViewerContext } from "./messages.js";

export interface StoredAttachment {
  filename: string | null;
  sha256: string;
  mime: string | null;
  size_bytes: number;
}

export function listMessageAttachments(db: Db, messageId: string): StoredAttachment[] {
  return db
    .prepare(
      `SELECT ma.filename, ma.sha256, a.mime, a.size_bytes
       FROM message_attachments ma
       JOIN attachments a ON a.sha256 = ma.sha256
       WHERE ma.message_id = ?
       ORDER BY ma.filename`,
    )
    .all(messageId) as StoredAttachment[];
}

export function findAttachment(db: Db, sha256: string): { path: string; mime: string | null; size_bytes: number } | undefined {
  return db
    .prepare("SELECT path, mime, size_bytes FROM attachments WHERE sha256 = ?")
    .get(sha256) as { path: string; mime: string | null; size_bytes: number } | undefined;
}

/** Verify that a viewer can read at least one message referencing `sha256`. */
export function canViewerReadAttachment(db: Db, sha256: string, viewer?: ViewerContext): boolean {
  if (!viewer || viewer.role === "admin") return true;
  const links = db
    .prepare("SELECT message_id FROM message_attachments WHERE sha256 = ?")
    .all(sha256) as Array<{ message_id: string }>;
  for (const link of links) {
    const msg = getMessage(db, link.message_id);
    if (msg && canViewerAccessMessage(db, msg, viewer)) return true;
  }
  return false;
}

export function upsertAttachment(
  db: Db,
  row: { sha256: string; path: string; mime: string | null; sizeBytes: number; now: number },
): void {
  db.prepare(
    `INSERT INTO attachments (sha256, path, mime, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sha256) DO NOTHING`,
  ).run(row.sha256, row.path, row.mime, row.sizeBytes, row.now);
}

export function linkAttachment(
  db: Db,
  row: { messageId: string; sha256: string; filename: string; contentId: string | null },
): void {
  db.prepare(
    `INSERT INTO message_attachments (message_id, sha256, filename, content_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, sha256, filename) DO NOTHING`,
  ).run(row.messageId, row.sha256, row.filename, row.contentId);
}
