import type { Db } from "../index.js";
import { threadKeyOf } from "../../mail/thread.js";
import type { MemberScope } from "./messages.js";
import { getMemberMessageState } from "./messages.js";
import { messageMatchesAllocations } from "./users.js";

export interface ThreadLetter {
  kind: "in" | "sent";
  id: string;
  at: number;
  from: string | null;
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  refs: string[];
  threadKey: string | null;
}

const MAX_HOPS = 6;
const MAX_LETTERS = 30;
const MAX_IDS = 40;

/** Letters that answer each other, inbound and sent together, respecting member isolation when scoped. */
export function listThread(db: Db, anchorId: string, memberScope?: MemberScope): ThreadLetter[] | null {
  const anchor = messageLetter(db, anchorId, memberScope);
  if (!anchor) return null;
  const rows = new Map<string, ThreadLetter>();
  rows.set(keyOf(anchor), anchor);
  let ids = seedIds(anchor);
  for (let hop = 0; hop < MAX_HOPS && ids.length > 0 && rows.size < MAX_LETTERS; hop++) {
    let grew = false;
    for (const row of findByIds(db, ids, memberScope)) {
      if (rows.has(keyOf(row))) continue;
      rows.set(keyOf(row), row);
      grew = true;
      if (rows.size >= MAX_LETTERS) break;
    }
    if (!grew) break;
    const next = new Set(ids);
    for (const row of rows.values()) {
      for (const id of seedIds(row)) {
        if (next.size >= MAX_IDS) break;
        next.add(id);
      }
    }
    if (next.size === ids.length) break;
    ids = [...next];
  }
  return [...rows.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

function keyOf(row: ThreadLetter): string {
  return `${row.kind}:${row.id}`;
}

function seedIds(row: ThreadLetter): string[] {
  const ids = [row.messageId, row.inReplyTo, row.threadKey, ...row.refs];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function findByIds(db: Db, ids: readonly string[], memberScope?: MemberScope): ThreadLetter[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  const params = [...ids, ...ids, ...ids, ...ids];
  const inbound = db
    .prepare(
      `SELECT id, message_id, in_reply_to, ref_ids, thread_key, subject, from_addr, envelope_to, to_addrs, received_at AS at
       FROM messages
       WHERE message_id IN (${ph}) OR in_reply_to IN (${ph}) OR thread_key IN (${ph})
          OR id IN (
            SELECT m.id FROM messages m, json_each(m.ref_ids) j
            WHERE m.ref_ids IS NOT NULL AND j.value IN (${ph})
          )`,
    )
    .all(...params) as InRow[];

  const filteredInbound = memberScope
    ? inbound.filter((row) => {
        if (!messageMatchesAllocations(row, memberScope.allocations)) return false;
        const state = getMemberMessageState(db, memberScope.userId, row.id);
        return state?.purged_at == null;
      })
    : inbound;

  const sent = memberScope
    ? (db
        .prepare(
          `SELECT id, message_id, in_reply_to, ref_ids, thread_key, subject, from_addr, created_at AS at
           FROM outbox
           WHERE user_id = ?
             AND (message_id IN (${ph}) OR in_reply_to IN (${ph}) OR thread_key IN (${ph})
               OR id IN (
                 SELECT o.id FROM outbox o, json_each(o.ref_ids) j
                 WHERE o.ref_ids IS NOT NULL AND j.value IN (${ph})
               ))`,
        )
        .all(memberScope.userId, ...params) as SentRow[])
    : (db
        .prepare(
          `SELECT id, message_id, in_reply_to, ref_ids, thread_key, subject, from_addr, created_at AS at
           FROM outbox
           WHERE message_id IN (${ph}) OR in_reply_to IN (${ph}) OR thread_key IN (${ph})
              OR id IN (
                SELECT o.id FROM outbox o, json_each(o.ref_ids) j
                WHERE o.ref_ids IS NOT NULL AND j.value IN (${ph})
              )`,
        )
        .all(...params) as SentRow[]);

  return [...filteredInbound.map((row) => toLetter(row, "in")), ...sent.map((row) => toLetter(row, "sent"))];
}

interface SentRow {
  id: string;
  message_id: string | null;
  in_reply_to: string | null;
  ref_ids: string | null;
  thread_key: string | null;
  subject: string | null;
  from_addr: string | null;
  at: number;
}

interface InRow extends SentRow {
  envelope_to: string;
  to_addrs: string | null;
}

function toLetter(row: SentRow, kind: "in" | "sent"): ThreadLetter {
  const refs = parseRefs(row.ref_ids);
  return {
    kind,
    id: row.id,
    at: row.at,
    from: row.from_addr,
    subject: row.subject,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    refs,
    threadKey: row.thread_key ?? threadKeyOf(row.message_id, row.in_reply_to, refs),
  };
}

function messageLetter(db: Db, id: string, memberScope?: MemberScope): ThreadLetter | null {
  const row = db
    .prepare(
      `SELECT id, message_id, in_reply_to, ref_ids, thread_key, subject, from_addr, envelope_to, to_addrs, received_at AS at
       FROM messages WHERE id = ?`,
    )
    .get(id) as InRow | undefined;
  if (!row) return null;
  if (memberScope) {
    if (!messageMatchesAllocations(row, memberScope.allocations)) return null;
    const state = getMemberMessageState(db, memberScope.userId, row.id);
    if (state?.purged_at != null) return null;
  }
  return toLetter(row, "in");
}

function parseRefs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 20);
  } catch {
    return [];
  }
}
