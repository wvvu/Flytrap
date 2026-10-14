import type { SessionStore } from "@fastify/session";
import type { Session } from "fastify";
import type { Db } from "../db/index.js";

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

  return {
    set(sessionId, session, callback) {
      try {
        const now = Date.now();
        write.run(sessionId, JSON.stringify(session), expiresAt(session, now, defaultTtlMs));
        sweep.run(now);
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
