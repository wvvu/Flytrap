import type { SessionStore } from "@fastify/session";
import type { Session } from "fastify";
import type { Db } from "../db/index.js";
import { OWNER_USER_ID } from "../db/repos/users.js";

const DEFAULT_SESSION_TTL_MS = 15 * 24 * 60 * 60 * 1000;

/** Persist panel sessions in SQLite so a container restart keeps the login. */
export function sqliteSessionStore(db: Db, defaultTtlMs = DEFAULT_SESSION_TTL_MS): SessionStore {
  const read = db.prepare("SELECT data, expires_at FROM sessions WHERE sid = ?");
  const write = db.prepare(
    `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
  );
  const remove = db.prepare("DELETE FROM sessions WHERE sid = ?");
  const sweep = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
  let sweptAt = 0;

  return {
    set(sessionId, session, callback) {
      try {
        const now = Date.now();
        write.run(sessionId, JSON.stringify(session), expiresAt(session, now, defaultTtlMs));
        if (now - sweptAt >= 60_000) {
          sweptAt = now;
          sweep.run(now);
        }
        callback();
      } catch (err) {
        callback(err);
      }
    },
    get(sessionId, callback) {
      try {
        const row = read.get(sessionId) as { data: string; expires_at: number } | undefined;
        if (!row || row.expires_at <= Date.now()) {
          if (row) remove.run(sessionId);
          callback(null, null);
          return;
        }
        callback(null, JSON.parse(row.data) as Session);
      } catch (err) {
        callback(err);
      }
    },
    destroy(sessionId, callback) {
      try {
        remove.run(sessionId);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  };
}

export function clearSessions(db: Db): void {
  db.prepare("DELETE FROM sessions").run();
}

/** Immediately drop all active sessions belonging to one user without logging out others. */
export function clearUserSessions(db: Db, userId: string, username?: string): number {
  if (userId === OWNER_USER_ID && username) {
    const res = db
      .prepare(
        `DELETE FROM sessions
         WHERE json_extract(data, '$.userId') = ?
            OR (json_extract(data, '$.userId') IS NULL AND json_extract(data, '$.user') = ?)`,
      )
      .run(OWNER_USER_ID, username);
    return res.changes;
  }
  if (username) {
    const res = db
      .prepare(
        `DELETE FROM sessions
         WHERE json_extract(data, '$.userId') = ?
            OR lower(COALESCE(json_extract(data, '$.user'), '')) = lower(?)`,
      )
      .run(userId, username);
    return res.changes;
  }
  const res = db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(userId);
  return res.changes;
}

function expiresAt(session: Session, now: number, defaultTtlMs = DEFAULT_SESSION_TTL_MS): number {
  const cookie = session.cookie;
  const expires = cookie?.expires;
  if (expires instanceof Date && Number.isFinite(expires.getTime())) return expires.getTime();
  if (typeof expires === "string" || typeof expires === "number") {
    const ms = new Date(expires).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  const maxAge = cookie?.originalMaxAge ?? cookie?.maxAge;
  if (typeof maxAge === "number" && maxAge > 0) return now + maxAge;
  return now + defaultTtlMs;
}
