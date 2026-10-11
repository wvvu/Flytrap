import type { Db } from "../index.js";

export type OutboxStatus = "queued" | "sent" | "error";

export interface OutboxRow {
  id: string;
  sha256: string;
  raw_path: string;
  size_bytes: number;
  from_addr: string;
  to_addrs: string;
  subject: string;
  domain_known: number;
  dkim_selector: string | null;
  status: OutboxStatus;
  accepted: string;
  smtp_response: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewOutbox {
  id: string;
  sha256: string;
  rawPath: string;
  sizeBytes: number;
  from: string;
  to: readonly string[];
  subject: string;
  domainKnown: boolean;
  dkimSelector: string | null;
  now: number;
}

export function insertOutbox(db: Db, input: NewOutbox): void {
  db.prepare(
    `INSERT INTO outbox (
      id, sha256, raw_path, size_bytes, from_addr, to_addrs, subject, domain_known,
      dkim_selector, status, accepted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '[]', ?, ?)`,
  ).run(
    input.id,
    input.sha256,
    input.rawPath,
    input.sizeBytes,
    input.from,
    JSON.stringify(input.to),
    input.subject,
    input.domainKnown ? 1 : 0,
    input.dkimSelector,
    input.now,
    input.now,
  );
}

export function getOutbox(db: Db, id: string): OutboxRow | undefined {
  return db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | undefined;
}

export function listOutbox(db: Db, limit: number): OutboxRow[] {
  return db
    .prepare("SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?")
    .all(limit) as OutboxRow[];
}

export function listOutboxByIds(db: Db, ids: readonly string[]): OutboxRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM outbox WHERE id IN (${placeholders})`).all(...ids) as OutboxRow[];
}

export function acceptedAddresses(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

export function recordAccepted(db: Db, id: string, addresses: readonly string[], response: string, now: number): void {
  const row = db.prepare("SELECT accepted, smtp_response FROM outbox WHERE id = ?").get(id) as
    | { accepted: string; smtp_response: string | null }
    | undefined;
  if (!row) return;
  const current = acceptedAddresses(row.accepted);
  for (const address of addresses) {
    if (!current.includes(address)) current.push(address);
  }
  const note = [row.smtp_response, response].filter(Boolean).join("; ").slice(0, 500);
  db.prepare(
    `UPDATE outbox SET accepted = ?, smtp_response = ?, updated_at = ? WHERE id = ? AND status != 'sent'`,
  ).run(JSON.stringify(current), note, now, id);
}

export function markOutboxSent(db: Db, id: string, response: string, now: number): void {
  db.prepare(
    `UPDATE outbox
     SET status = 'sent', smtp_response = ?, error = NULL, updated_at = ?
     WHERE id = ? AND status != 'sent'`,
  ).run(response.slice(0, 500), now, id);
}

export function markOutboxRetry(db: Db, id: string, error: string, now: number): void {
  db.prepare(
    `UPDATE outbox SET status = 'queued', error = ?, updated_at = ? WHERE id = ? AND status != 'sent'`,
  ).run(error.slice(0, 500), now, id);
}

export function markOutboxDead(db: Db, id: string, error: string, now: number): void {
  db.prepare(
    `UPDATE outbox SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status != 'sent'`,
  ).run(error.slice(0, 500), now, id);
}
