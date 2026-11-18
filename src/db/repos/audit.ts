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

export function listAuditLogs(
  db: Db,
  options: { limit?: number; actor?: string; action?: string } = {},
): AuditRow[] {
  const limit = Math.min(Math.max(options.limit ?? 80, 1), 300);
  const where: string[] = [];
  const params: Record<string, string | number> = { limit };
  if (options.actor) {
    where.push("lower(actor) = lower(:actor)");
    params.actor = options.actor;
  }
  if (options.action) {
    where.push("action = :action");
    params.action = options.action;
  }
  return db
    .prepare(
      `SELECT id, at, actor, action, target, detail
       FROM audit_log
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY at DESC, id DESC
       LIMIT :limit`,
    )
    .all(params) as AuditRow[];
}
