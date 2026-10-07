import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipCodec } from "../src/compress.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { countUnread, listMessages } from "../src/db/repos/messages.js";
import { acceptMessage } from "../src/ingest/accept.js";
import { migrationsDir } from "../src/paths.js";
import { buildSmtpMeta } from "../src/smtp/session-meta.js";

test("a second delivery of the same bytes keeps every recipient", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-accept-"));
  const db = openDatabase(path.join(dir, "mail.db"));
  migrate(db, migrationsDir());
  try {
    const bytes = Buffer.from("Subject: hi\r\n\r\nhello\r\n");
    const first = await acceptMessage(
      { db, dataDir: dir, codec: gzipCodec() },
      { bytes, receivedAtMs: 1_000, meta: meta(["a@example.com"], 1_000) },
    );
    const second = await acceptMessage(
      { db, dataDir: dir, codec: gzipCodec() },
      { bytes, receivedAtMs: 2_000, meta: meta(["b@example.com"], 2_000) },
    );
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);
    const row = db.prepare("SELECT envelope_to, received_at FROM messages WHERE id = ?").get(first.id) as {
      envelope_to: string;
      received_at: number;
    };
    assert.deepEqual(JSON.parse(row.envelope_to), ["a@example.com", "b@example.com"]);
    assert.equal(row.received_at, 2_000);
    const deliveries = db.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE message_id = ?").get(first.id) as { c: number };
    assert.equal(deliveries.c, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the default legit column still shows mail that has not been classified", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-list-"));
  const db = openDatabase(path.join(dir, "mail.db"));
  migrate(db, migrationsDir());
  try {
    insert("fresh", null);
    insert("ok", JSON.stringify({ label: "legit" }));
    insert("ad", JSON.stringify({ label: "spam" }));
    const shown = listMessages(db, { label: "legit", limit: 20 }).map((row) => row.id).sort();
    assert.deepEqual(shown, ["fresh", "ok"]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function insert(id: string, ai: string | null) {
    db.prepare(
      `INSERT INTO messages (
        id, sha256, raw_path, size_bytes, received_at, envelope_to, domains, smtp_meta, ai_result, status, created_at, updated_at
      ) VALUES (?, ?, 'raw/a', 1, ?, '[]', '[]', '{}', ?, 'received', 1, 1)`,
    ).run(id, id.padEnd(64, "a"), id === "ad" ? 1 : 3, ai);
  }
});

test("not-legit is every classified letter outside the inbox, and unread counts follow the rooms", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-spam-"));
  const db = openDatabase(path.join(dir, "mail.db"));
  migrate(db, migrationsDir());
  try {
    insertRoom(db, "fresh", null, null, null);
    insertRoom(db, "ok", JSON.stringify({ label: "legit" }), null, null);
    insertRoom(db, "ad", JSON.stringify({ label: "spam" }), null, null);
    insertRoom(db, "fish", JSON.stringify({ label: "phish" }), 5, null);
    insertRoom(db, "gone", JSON.stringify({ label: "spam" }), null, 9);
    const spam = listMessages(db, { label: "not-legit", limit: 20 }).map((row) => row.id).sort();
    assert.deepEqual(spam, ["ad", "fish"]);
    assert.deepEqual(countUnread(db), { inbox: 2, spam: 1 });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function insertRoom(db: ReturnType<typeof openDatabase>, id: string, ai: string | null, readAt: number | null, trashedAt: number | null) {
  db.prepare(
    `INSERT INTO messages (
      id, sha256, raw_path, size_bytes, received_at, envelope_to, domains, smtp_meta, ai_result, status, created_at, updated_at, read_at, trashed_at
    ) VALUES (?, ?, 'raw/a', 1, 3, '[]', '[]', '{}', ?, 'received', 1, 1, ?, ?)`,
  ).run(id, id.padEnd(64, "a"), ai, readAt, trashedAt);
}

function meta(rcptTo: string[], receivedAtMs: number) {
  return buildSmtpMeta({
    remoteIp: "203.0.113.10",
    reverseDns: "mail.example.net",
    helo: "mail.example.net",
    mailFrom: "sender@example.net",
    rcptTo,
    secure: false,
    receivedAtMs,
    localIp: "192.0.2.10",
    localPort: 25,
  });
}
