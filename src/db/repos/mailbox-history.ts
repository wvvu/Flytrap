import { ulid } from "ulid";
import type { Db } from "../index.js";

export interface MailboxHistoryRow {
  domain: string;
  localpart: string;
  first_seen: number | null;
  last_seen: number | null;
  source: string | null;
  notes: string | null;
  display_name: string | null;
}

export function findMailboxHistory(db: Db, domain: string, localpart: string): MailboxHistoryRow | undefined {
  return db
    .prepare(
      `SELECT domain, localpart, first_seen, last_seen, source, notes, display_name
       FROM mailbox_history
       WHERE lower(domain) = lower(?) AND lower(localpart) = lower(?)`,
    )
    .get(domain, localpart) as MailboxHistoryRow | undefined;
}

export function listMailboxHistory(
  db: Db,
  filter: { domain?: string; localpart?: string },
): MailboxHistoryRow[] {
  return db
    .prepare(
      `SELECT domain, localpart, first_seen, last_seen, source, notes, display_name
       FROM mailbox_history
       WHERE (:domain IS NULL OR lower(domain) = lower(:domain))
         AND (:localpart IS NULL OR lower(localpart) = lower(:localpart))
       ORDER BY domain, localpart
       LIMIT 500`,
    )
    .all({ domain: filter.domain ?? null, localpart: filter.localpart ?? null }) as MailboxHistoryRow[];
}

export function upsertMailboxHistory(
  db: Db,
  row: {
    domain: string;
    localpart: string;
    firstSeen: number | null;
    lastSeen: number | null;
    source: string | null;
    notes: string | null;
    /** Omit to leave the current name. Empty string clears it. */
    displayName?: string | null;
  },
): void {
  const domain = row.domain.trim().toLowerCase();
  const localpart = row.localpart.trim().toLowerCase();
  const touchName = row.displayName === undefined ? 0 : 1;
  const displayName = row.displayName === undefined ? null : blank(row.displayName);
  db.prepare(
    `INSERT INTO mailbox_history (id, domain, localpart, first_seen, last_seen, source, notes, display_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain, localpart) DO UPDATE SET
       first_seen = COALESCE(excluded.first_seen, mailbox_history.first_seen),
       last_seen = COALESCE(excluded.last_seen, mailbox_history.last_seen),
       source = COALESCE(excluded.source, mailbox_history.source),
       notes = COALESCE(excluded.notes, mailbox_history.notes),
       display_name = CASE WHEN ? = 1 THEN ? ELSE mailbox_history.display_name END`,
  ).run(ulid(), domain, localpart, row.firstSeen, row.lastSeen, row.source, row.notes, displayName, touchName, displayName);
}

function blank(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
