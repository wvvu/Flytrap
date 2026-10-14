import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApi } from "../src/api/app.js";
import { gzipCodec } from "../src/compress.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { listDkimPublic, saveDkimKey } from "../src/db/repos/dkim-keys.js";
import { failureSummary, settleFinishedSends } from "../src/db/repos/jobs.js";
import { insertMessage } from "../src/db/repos/messages.js";
import { getOutbox } from "../src/db/repos/outbox.js";
import { listThread } from "../src/db/repos/thread.js";
import { rebuildFromRaw } from "../src/ingest/rebuild.js";
import { readRaw } from "../src/ingest/read-raw.js";
import { storeRaw } from "../src/ingest/store-raw.js";
import { OutboundError } from "../src/mail/address.js";
import { authenticateMessage } from "../src/mail/auth.js";
import { composeText } from "../src/mail/compose.js";
import { normalizeMessageId, readThreadHeaders } from "../src/mail/thread.js";
import { backfillThreadHeaders } from "../src/mail/thread-scan.js";
import { deliverToMx, type MailSender } from "../src/mail/deliver.js";
import { submitOutbox } from "../src/mail/submit.js";
import { migrationsDir } from "../src/paths.js";
import { fakeClassifier } from "../src/ai/classifier.js";
import type { AppLog } from "../src/log.js";
import { processNext, type WorkerOptions } from "../src/worker/loop.js";
import { retryJob } from "../src/db/repos/jobs.js";
import { markOutboxDead } from "../src/db/repos/outbox.js";
import PostalMime from "postal-mime";

const silent: AppLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
};

const password = "test-password-value";
const secret = "0123456789abcdef0123456789abcdef";

test("mx delivery prefers the closer exchange and stops on a null mx", async () => {
  const hosts: string[] = [];
  const accepted: string[] = [];
  await assert.rejects(
    () =>
      deliverToMx(
        {
          from: "a@example.com",
          to: ["b@one.test", "c@two.test"],
          raw: Buffer.from("Subject: x\r\n\r\nx\r\n"),
          ehloName: "mail.example.com",
          onAccepted(addresses) {
            accepted.push(...addresses);
          },
        },
        {
          async resolveMx(domain) {
            if (domain === "one.test") {
              return [
                { exchange: "slow.one.test.", priority: 20 },
                { exchange: "fast.one.test.", priority: 5 },
              ];
            }
            return [{ exchange: ".", priority: 0 }];
          },
          async sendToHost(host) {
            hosts.push(host);
            if (host !== "fast.one.test") throw new Error("no");
            return "250 ok";
          },
        },
      ),
    /does not accept mail/,
  );
  assert.deepEqual(hosts, ["fast.one.test"]);
  assert.deepEqual(accepted, ["b@one.test"]);
});

test("a missing mx falls back to the domain itself", async () => {
  const hosts: string[] = [];
  const result = await deliverToMx(
    {
      from: "a@example.com",
      to: ["b@bare.test"],
      raw: Buffer.from("x"),
      ehloName: "mail.example.com",
    },
    {
      async resolveMx() {
        const err = new Error("no mx") as NodeJS.ErrnoException;
        err.code = "ENODATA";
        throw err;
      },
      async sendToHost(host) {
        hosts.push(host);
        return "250 ok";
      },
    },
  );
  assert.deepEqual(hosts, ["bare.test"]);
  assert.match(result.response, /250 ok/);
});

test("outbound mail is stored, signed when a key exists, and not received as new mail", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-send-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const calls: string[][] = [];
  let clock = 1_000_000;
  const now = () => clock;
  try {
    const open = await submitOutbox(deps(db, dir, now), {
      from: "stranger@other.test",
      to: ["sink@example.net"],
      subject: "probe",
      text: "hello",
    });
    assert.equal(open.domainKnown, false);
    assert.equal(open.dkim, "none");
    clock += 1;

    saveDkimKey(db, "example.com", undefined, clock);
    const signed = await submitOutbox(deps(db, dir, now), {
      from: "a@example.com",
      to: ["keep@good.test", "drop@bad.test"],
      subject: "你好",
      text: "正文",
    });
    assert.equal(signed.domainKnown, true);
    assert.equal(signed.dkim, "signed");
    assert.equal(signed.selector, "flytrap");

    const row = getOutbox(db, signed.id);
    assert.ok(row);
    assert.match(row.raw_path, /^sent\//);
    const raw = await readRaw(dir, row.raw_path, gzipCodec(), row.sha256);
    const text = raw.toString("utf8");
    assert.match(text, /DKIM-Signature:/);
    assert.equal(text.includes("Bcc:"), false);
    assert.match(text, /Subject: =\?UTF-8\?B\?/);

    const published = listDkimPublic(db).find((item) => item.domain === "example.com");
    assert.ok(published);
    assert.equal(JSON.stringify(published).includes("PRIVATE"), false);
    const auth = await authenticateMessage(
      {
        raw,
        ip: "203.0.113.10",
        helo: "mail.example.com",
        sender: "a@example.com",
        mta: "mx.test",
        ptr: "mail.example.com",
      },
      10_000,
      async (name, rrtype) => {
        if (rrtype === "TXT" && name.toLowerCase() === published.dnsName) return [[published.txt]];
        return [];
      },
    );
    assert.equal(auth.dkim, "pass", JSON.stringify(auth));

    const report = await rebuildFromRaw({ db, dataDir: dir, codec: gzipCodec(), now: clock });
    assert.equal(report.inserted, 0);

    const sender = captureSender(calls);
    const options = workerOptions(db, dir, sender, now);
    assert.equal(await processNext(options, "worker-send"), true);
    assert.deepEqual(calls[0], ["sink@example.net"]);
    assert.equal(await processNext(options, "worker-send"), true);
    assert.deepEqual(calls[1], ["keep@good.test", "drop@bad.test"]);
    clock += 20_000;
    assert.equal(await processNext(options, "worker-send"), true);
    assert.deepEqual(calls[2], ["drop@bad.test"]);
    assert.equal(getOutbox(db, signed.id)?.status, "sent");

    const again = db.prepare("SELECT payload FROM jobs WHERE payload LIKE ?").get(`%${signed.id}%`) as { payload: string };
    db.prepare(
      `INSERT INTO jobs (id, type, message_id, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES ('send_again', 'send', NULL, ?, 'queued', 0, 5, ?, ?, ?)`,
    ).run(again.payload, clock, clock, clock);
    assert.equal(await processNext(options, "worker-send"), true);
    assert.equal(calls.length, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the panel can queue a letter for a domain that was not added", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-send-api-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: password,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
  });
  const client = cookieJar();
  try {
    const closed = await app.inject({ method: "GET", url: "/v1/outbox" });
    assert.equal(closed.statusCode, 401);

    await client.login(app);
    const queued = await client.post(app, "/v1/outbox", {
      from: "a@other.test",
      to: ["b@example.net"],
      subject: "try",
      text: "x",
    });
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.json().domainKnown, false);
    assert.equal(queued.json().dkim, "none");
    const opened = await client.get(app, `/v1/outbox/${queued.json().id}`);
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().text, "x\n");
    assert.match(opened.json().headers, /Subject: try/);
    const raw = await client.get(app, `/v1/outbox/${queued.json().id}/raw`);
    assert.equal(raw.statusCode, 200);
    assert.match(raw.body, /Subject: try/);

    const key = await client.post(app, "/v1/dkim", { domain: "example.com" });
    assert.equal(key.statusCode, 200);
    assert.equal(key.json().dnsName, "flytrap._domainkey.example.com");
    assert.match(key.json().txt, /^v=DKIM1; k=rsa; p=/);
    assert.equal(JSON.stringify(key.json()).includes("PRIVATE"), false);

    const listed = await client.get(app, "/v1/dkim");
    assert.equal(JSON.stringify(listed.json()).includes("PRIVATE"), false);
    assert.equal(listed.json().items.length, 1);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("composeText preserves multi-byte UTF-8 subject and base64 encodes long ASCII lines", async () => {
  const subject = "Re: " + "测".repeat(20) + " 🚀 " + "测试".repeat(5);
  const longLine = "a".repeat(1005);
  const raw = composeText({
    from: "a@example.com",
    to: ["b@example.com"],
    cc: [],
    subject,
    text: longLine,
    messageId: "m1@example.com",
    date: new Date(1_000_000),
  });
  const text = raw.toString("utf8");
  assert.match(text, /Content-Transfer-Encoding: base64/);
  const parser = new PostalMime();
  const parsed = await parser.parse(raw);
  assert.equal(parsed.subject, subject);
  assert.equal(parsed.subject?.includes("\uFFFD"), false);
  const folded = composeText({
    from: "a@example.com",
    to: ["one@example.com", "two@example.com", "three@example.com", "four@example.com", "five@example.com"],
    cc: [],
    subject: "s",
    text: "t",
    messageId: "m2@example.com",
    date: new Date(1_000_000),
  });
  assert.match(folded.toString("utf8"), /To: one@example.com,.*\r\n five@example.com/);
});

test("an ed25519 key signs and publishes a 32-byte DNS record", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-send-ed-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const now = () => 2_000_000;
  try {
    const saved = saveDkimKey(db, "example.com", "ed", now(), "ed25519");
    assert.equal(saved.algorithm, "ed25519");
    assert.match(saved.txt, /^v=DKIM1; k=ed25519; p=/);
    assert.equal(Buffer.from(saved.txt.split("p=")[1] ?? "", "base64").length, 32);

    const queued = await submitOutbox(deps(db, dir, now), {
      from: "a@example.com",
      to: ["b@example.net"],
      subject: "ed",
      text: "hello",
    });
    assert.equal(queued.dkim, "signed");
    assert.equal(queued.selector, "ed");
    const row = getOutbox(db, queued.id);
    assert.ok(row);
    const raw = await readRaw(dir, row.raw_path, gzipCodec(), row.sha256);
    assert.match(raw.toString("utf8"), /a=ed25519-sha256/i);
    const auth = await authenticateMessage(
      {
        raw,
        ip: "203.0.113.10",
        helo: "mail.example.com",
        sender: "a@example.com",
        mta: "mx.test",
        ptr: "mail.example.com",
      },
      10_000,
      async (name, rrtype) => {
        if (rrtype === "TXT" && name.toLowerCase() === saved.dnsName) return [[saved.txt]];
        return [];
      },
    );
    assert.equal(auth.dkim, "pass", JSON.stringify(auth));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed send stays off the settings badge and can be retried from the outbox", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-send-badge-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const now = 3_000_000;
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: password,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => now,
  });
  const client = cookieJar();
  try {
    const outboxId = "01M4TEST000000000000000009";
    db.prepare(
      `INSERT INTO outbox (id, sha256, raw_path, size_bytes, from_addr, to_addrs, subject, domain_known, status, error, created_at, updated_at)
       VALUES (?, 'sha', 'sent/test', 10, 'a@example.com', '["b@example.net"]', 'test', 1, 'error', 'network down', ?, ?)`,
    ).run(outboxId, now, now);
    db.prepare(
      `INSERT INTO jobs (id, type, message_id, payload, status, attempts, max_attempts, run_after, last_error, created_at, updated_at)
       VALUES ('send-dead', 'send', NULL, ?, 'dead', 5, 5, ?, 'network down', ?, ?)`,
    ).run(JSON.stringify({ outboxId }), now, now, now);
    db.prepare(
      `INSERT INTO jobs (id, type, message_id, status, attempts, max_attempts, run_after, last_error, created_at, updated_at)
       VALUES ('mail-dead', 'classify', 'msg-1', 'dead', 5, 5, ?, 'boom', ?, ?)`,
    ).run(now, now, now);

    assert.equal(failureSummary(db).dead, 1);
    await client.login(app);
    const summary = await client.get(app, "/v1/jobs/summary");
    assert.equal(summary.json().dead, 1);
    const open = await client.get(app, "/v1/jobs?scope=open");
    const ids = open.json().items.map((item: { id: string }) => item.id);
    assert.equal(ids.includes("send-dead"), false);
    assert.equal(ids.includes("mail-dead"), true);

    const retry = await client.post(app, `/v1/outbox/${outboxId}/retry`, {});
    assert.equal(retry.statusCode, 200);
    assert.equal(getOutbox(db, outboxId)?.status, "queued");
    assert.equal(getOutbox(db, outboxId)?.error, null);
    const sentAgain = await client.post(app, `/v1/outbox/${outboxId}/retry`, {});
    assert.equal(sentAgain.statusCode, 200);

    db.prepare("UPDATE outbox SET status = 'sent', error = NULL WHERE id = ?").run(outboxId);
    db.prepare("UPDATE jobs SET status = 'dead', attempts = 5, last_error = 'network down' WHERE id = 'send-dead'").run();
    assert.equal(settleFinishedSends(db, now + 1), 1);
    const job = db.prepare("SELECT status, last_error FROM jobs WHERE id = 'send-dead'").get() as { status: string; last_error: string | null };
    assert.equal(job.status, "done");
    assert.equal(job.last_error, null);
    const closed = await client.post(app, `/v1/outbox/${outboxId}/retry`, {});
    assert.equal(closed.statusCode, 404);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retryJob clears the outbox error when reopening a dead send job", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-send-retry-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  try {
    const outboxId = "01M4TEST000000000000000001";
    const jobId = "01M4TESTJOB000000000000001";
    db.prepare(
      `INSERT INTO outbox (id, sha256, raw_path, size_bytes, from_addr, to_addrs, subject, domain_known, status, error, created_at, updated_at)
       VALUES (?, 'sha', 'sent/test', 10, 'a@test.com', '["b@test.com"]', 'test', 1, 'error', 'network down', 100, 100)`,
    ).run(outboxId);
    db.prepare(
      `INSERT INTO jobs (id, type, message_id, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES (?, 'send', NULL, ?, 'dead', 5, 5, 100, 100, 100)`,
    ).run(jobId, JSON.stringify({ outboxId }));

    const ok = retryJob(db, jobId, 200);
    assert.equal(ok, true);
    db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(jobId);
    assert.equal(retryJob(db, jobId, 300), false);
    const row = getOutbox(db, outboxId);
    assert.ok(row);
    assert.equal(row.status, "queued");
    assert.equal(row.error, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reply headers stay on the letter and the opened mail lists the chain", async () => {
  const raw = Buffer.from(
    [
      "From: a@example.com",
      "Message-ID: <Root@Example.com>",
      "In-Reply-To: <Parent@Example.com>",
      "References: <Root@Example.com>",
      " <Parent@Example.com>",
      "",
      "hi",
    ].join("\r\n"),
  );
  const headers = readThreadHeaders(raw);
  assert.equal(headers.messageId, "root@example.com");
  assert.equal(headers.inReplyTo, "parent@example.com");
  assert.deepEqual(headers.refs, ["root@example.com", "parent@example.com"]);
  assert.equal(normalizeMessageId("<Ok@X>"), "ok@x");
  assert.equal(normalizeMessageId("<Ok@X> (added by the gateway)"), "ok@x");
  assert.equal(normalizeMessageId("bad id"), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-thread-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const now = () => 4_000_000;
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: password,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
  });
  const client = cookieJar();
  try {
    insertMessage(db, letter("msg_root", 1_000, "aa".repeat(32)));
    insertMessage(db, letter("msg_child", 2_000, "bb".repeat(32)));
    db.prepare(
      `UPDATE messages SET message_id = ?, thread_key = ?, subject = ?, from_addr = ? WHERE id = 'msg_root'`,
    ).run("root@example.com", "root@example.com", "hello", "a@example.com");
    db.prepare(
      `UPDATE messages SET message_id = ?, in_reply_to = ?, ref_ids = ?, thread_key = ?, subject = ?, from_addr = ? WHERE id = 'msg_child'`,
    ).run("child@example.com", "root@example.com", JSON.stringify(["root@example.com"]), "root@example.com", "Re: hello", "b@example.com");

    await assert.rejects(
      () => submitOutbox(deps(db, dir, now), { from: "a@example.com", to: ["b@example.net"], inReplyTo: "bad id", text: "no" }),
      (err: unknown) => err instanceof OutboundError && /invalid message id/.test(err.message),
    );

    const queued = await submitOutbox(deps(db, dir, now), {
      from: "a@example.com",
      to: ["b@example.net"],
      subject: "Re: hello",
      text: "third",
      inReplyTo: "<Child@Example.com>",
      references: ["root@example.com", "child@example.com"],
    });
    const row = getOutbox(db, queued.id);
    assert.ok(row);
    assert.equal(row.message_id, `${queued.id.toLowerCase()}@example.com`);
    assert.equal(row.in_reply_to, "child@example.com");
    assert.equal(row.thread_key, "root@example.com");
    const text = (await readRaw(dir, row.raw_path, gzipCodec(), row.sha256)).toString("utf8");
    const messageAt = text.indexOf("Message-ID:");
    const replyAt = text.indexOf("In-Reply-To:");
    const refsAt = text.indexOf("References:");
    const mimeAt = text.indexOf("MIME-Version:");
    assert.ok(messageAt >= 0 && messageAt < replyAt && replyAt < refsAt && refsAt < mimeAt);
    assert.match(text, /In-Reply-To: <child@example.com>/);
    assert.match(text, /References: <root@example.com> <child@example.com>/);

    const chain = listThread(db, "msg_child");
    assert.ok(chain);
    assert.deepEqual(chain.map((item) => item.kind + ":" + item.id), ["in:msg_root", "in:msg_child", `sent:${queued.id}`]);

    await client.login(app);
    const alone = await client.get(app, "/v1/messages/msg_root/thread");
    assert.equal(alone.statusCode, 200);
    assert.equal(alone.json().items.some((item: { kind: string }) => item.kind === "sent"), true);
    const opened = await client.get(app, "/v1/messages/msg_child/thread");
    assert.equal(opened.statusCode, 200);
    const current = opened.json().items.filter((item: { current: boolean }) => item.current);
    assert.equal(current.length, 1);
    assert.equal(current[0].id, "msg_child");
    const missing = await client.get(app, "/v1/messages/missing/thread");
    assert.equal(missing.statusCode, 404);
    const bad = await client.post(app, "/v1/outbox", {
      from: "a@example.com",
      to: ["b@example.net"],
      inReplyTo: "not an id",
      text: "x",
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("old letters are scanned once for reply headers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-thread-scan-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  try {
    const bytes = Buffer.from("Message-ID: <Old@Example.com>\r\nIn-Reply-To: <Older@Example.com>\r\nReferences: <Older@Example.com>\r\n\r\nbody\r\n");
    const stored = await storeRaw({ dataDir: dir, bytes, receivedAtMs: 5_000, codec: gzipCodec() });
    insertMessage(db, {
      id: "msg_old",
      sha256: stored.sha256,
      rawPath: stored.relativePath,
      sizeBytes: bytes.length,
      receivedAt: 5_000,
      envelopeFrom: "a@example.com",
      envelopeTo: ["b@example.com"],
      domains: ["example.com"],
      smtpMeta: { schema: 1 },
      now: 5_000,
    });
    db.prepare("UPDATE messages SET message_id = '<Old@Example.com>' WHERE id = 'msg_old'").run();
    insertMessage(db, letter("msg_gone", 4_000, "cd".repeat(32), "raw/missing.eml.gz"));
    await backfillThreadHeaders(db, dir, gzipCodec(), silent);
    const row = db.prepare(
      "SELECT message_id, in_reply_to, ref_ids, thread_key FROM messages WHERE id = 'msg_old'",
    ).get() as { message_id: string; in_reply_to: string; ref_ids: string; thread_key: string };
    assert.equal(row.message_id, "old@example.com");
    assert.equal(row.in_reply_to, "older@example.com");
    assert.equal(row.thread_key, "older@example.com");
    assert.equal(JSON.parse(row.ref_ids)[0], "older@example.com");
    const early = db.prepare("SELECT value FROM settings WHERE key = 'thread_scan'").get() as { value: string } | undefined;
    assert.equal(early, undefined);
    db.prepare("UPDATE messages SET thread_key = 'nope' WHERE id = 'msg_old'").run();
    await backfillThreadHeaders(db, dir, gzipCodec(), silent);
    await backfillThreadHeaders(db, dir, gzipCodec(), silent);
    const flag = db.prepare("SELECT value FROM settings WHERE key = 'thread_scan'").get() as { value: string };
    assert.equal(flag.value, "1");
    const again = db.prepare("SELECT thread_key FROM messages WHERE id = 'msg_old'").get() as { thread_key: string };
    assert.equal(again.thread_key, "nope");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function letter(id: string, receivedAt: number, sha256 = "ab".repeat(32), rawPath = "raw/unused.eml.gz") {
  return {
    id,
    sha256,
    rawPath,
    sizeBytes: 8,
    receivedAt,
    envelopeFrom: "a@example.com",
    envelopeTo: ["b@example.com"],
    domains: ["example.com"],
    smtpMeta: { schema: 1 },
    now: receivedAt,
  };
}

function deps(db: Db, dir: string, now: () => number) {
  return { db, dataDir: dir, codec: gzipCodec(), acceptDomains: ["example.com"], now };
}

function captureSender(calls: string[][]): MailSender {
  return {
    async send(message) {
      calls.push([...message.to]);
      const kept = message.to.filter((address) => address.endsWith("@good.test"));
      const rest = message.to.filter((address) => !address.endsWith("@good.test"));
      if (kept.length > 0 && rest.length > 0) {
        message.onAccepted?.(kept, "250 ok");
        throw new Error("bad.test: timeout");
      }
      message.onAccepted?.([...message.to], "250 ok");
      return { response: "250 ok" };
    },
  };
}

function workerOptions(db: Db, dir: string, sendMail: MailSender, now: () => number): WorkerOptions {
  return {
    db,
    dataDir: dir,
    codec: gzipCodec(),
    banner: "mail.example.com",
    ehloName: "mail.example.com",
    log: silent,
    authenticate: async () => {
      throw new Error("unused");
    },
    classifier: fakeClassifier(now),
    notifiers: [],
    notifyLabels: ["phish"],
    notifyMinConfidence: 0.6,
    promptsDir: path.join(dir, "prompts"),
    panelBaseUrl: "http://127.0.0.1:8080",
    sendMail,
    now,
  };
}

function cookieJar() {
  let cookie = "";
  let token = "";
  const take = (setCookie: string | string[] | undefined) => {
    const jar = new Map<string, string>();
    for (const part of cookie.split(";").filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const line of lines) {
      const pair = (line.split(";")[0] ?? "").trim();
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  };
  return {
    async login(app: Awaited<ReturnType<typeof buildApi>>) {
      const csrf = await app.inject({ method: "GET", url: "/v1/csrf", headers: cookie ? { cookie } : {} });
      take(csrf.headers["set-cookie"]);
      token = csrf.json().token as string;
      const login = await app.inject({
        method: "POST",
        url: "/v1/login",
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload: { username: "admin", password },
      });
      take(login.headers["set-cookie"]);
      assert.equal(login.statusCode, 200);
      await this.csrf(app);
    },
    async csrf(app: Awaited<ReturnType<typeof buildApi>>) {
      const csrf = await app.inject({ method: "GET", url: "/v1/csrf", headers: cookie ? { cookie } : {} });
      take(csrf.headers["set-cookie"]);
      token = csrf.json().token as string;
    },
    async get(app: Awaited<ReturnType<typeof buildApi>>, url: string) {
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      take(response.headers["set-cookie"]);
      return response;
    },
    async post(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      });
      take(response.headers["set-cookie"]);
      return response;
    },
  };
}
