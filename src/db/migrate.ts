import fs from "node:fs";
import path from "node:path";
import type { Db } from "./index.js";

export function migrate(db: Db, dir: string, now: () => number = Date.now): string[] {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const knownVersion = files.reduce((max, name) => Math.max(max, migrationNumber(name)), 0);
  const currentVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  if (currentVersion > knownVersion) {
    throw new Error(`database user_version ${currentVersion} is newer than supported version ${knownVersion}`);
  }
  const applied = new Set(readApplied(db));
  for (const id of applied) {
    if (migrationNumber(id) > knownVersion) {
      throw new Error(`database migration ${id} is newer than supported version ${knownVersion}`);
    }
  }
  const fresh: string[] = [];
  const insert = () =>
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");

  for (const name of files) {
    const id = name.replace(/\.sql$/, "");
    if (applied.has(id)) continue;
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    const statements = splitSql(sql);
    const pragmas = statements.filter((stmt) => /^PRAGMA\b/i.test(stmt));
    const rest = statements.filter((stmt) => !/^PRAGMA\b/i.test(stmt));
    for (const pragma of pragmas) {
      db.pragma(pragma.replace(/^PRAGMA\s+/i, ""));
    }
    const ver = Math.max(currentVersion, migrationNumber(id));
    const apply = db.transaction(() => {
      for (const stmt of rest) db.exec(stmt);
      insert().run(id, now());
      db.pragma(`user_version = ${ver}`);
    });
    apply();
    fresh.push(id);
  }
  if (currentVersion < knownVersion) {
    db.pragma(`user_version = ${knownVersion}`);
  }
  return fresh;
}

function migrationNumber(name: string): number {
  const match = /^(\d+)/.exec(name);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

function readApplied(db: Db): string[] {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!exists) return [];
  const rows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function splitSql(sql: string): string[] {
  const stripped = sql
    .split(/\r?\n/)
    .map((line) => {
      const mark = line.indexOf("--");
      return mark === -1 ? line : line.slice(0, mark);
    })
    .join("\n");
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  for (const ch of stripped) {
    if (ch === "'") inSingle = !inSingle;
    if (ch === ";" && !inSingle) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}
