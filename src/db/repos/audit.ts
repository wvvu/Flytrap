import type { Db } from "../index.js";

export interface AuditRow {
  id: string;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

export function writeAudit(
  db: Db,
  row: { id: string; at: number; actor: string; action: string; target?: string | null; detail?: unknown },
): void {
  db.prepare(
    `INSERT INTO audit_log (id, at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.at,
    row.actor.slice(0, 128),
    row.action,
    row.target ?? null,
    row.detail === undefined ? null : JSON.stringify(row.detail).slice(0, 1000),
  );
}

export function listRecentAudit(db: Db, limit = 100): AuditRow[] {
  const safeLimit = Math.min(Math.max(limit, 1), 300);
  return db
    .prepare("SELECT id, at, actor, action, target, detail FROM audit_log ORDER BY at DESC, id DESC LIMIT ?")
    .all(safeLimit) as AuditRow[];
}
