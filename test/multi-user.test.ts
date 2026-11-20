import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fakeClassifier } from "../src/ai/classifier.js";
import { buildApi } from "../src/api/app.js";
import { gzipCodec } from "../src/compress.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { enqueueJob, type JobRow } from "../src/db/repos/jobs.js";
import { insertMessage } from "../src/db/repos/messages.js";
import { runNotifyJob } from "../src/worker/job-notify.js";
import { acceptMessage } from "../src/ingest/accept.js";
import { readRaw } from "../src/ingest/read-raw.js";
import type { AppLog } from "../src/log.js";
import { authResultSchema } from "../src/mail/auth.js";
import { defaultPromptsDir, migrationsDir, resolveInside } from "../src/paths.js";
import { buildSmtpMeta } from "../src/smtp/session-meta.js";
import { processNext, type WorkerOptions } from "../src/worker/loop.js";

const adminPassword = "admin-strong-password";
const secret = "0123456789abcdef0123456789abcdef";

const silent: AppLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
};

test("multi-user accounts isolate exact, +subaddress, and wildcard mailboxes with specificity priority", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 18, 9, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com,example.net,example.org",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const admin = jar();
  const alice = jar();
  const bob = jar();

  try {
    await admin.login(app, "admin", adminPassword);

    // Create Alice with exact mailbox alice@example.com
    const createAlice = await admin.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      displayName: "Alice Lin",
      quotaSendPerDay: 5,
      initialMailbox: {
        localpart: "alice",
        domain: "example.com",
        displayName: "Alice Lin",
        canSend: true,
      },
    });
    assert.equal(createAlice.statusCode, 201);
    const aliceId = createAlice.json().user.id as string;

    // Duplicate mailbox allocation is rejected with 409
    const dup = await admin.post(app, `/v1/users/${aliceId}/mailboxes`, {
      localpart: "alice",
      domain: "example.com",
    });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().reason, "mailbox already allocated");

    // Create Bob with catch-all *@example.com (lower priority than alice@example.com) + bob@example.net
    const createBob = await admin.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      displayName: "Bob",
      quotaSendPerDay: 2,
      initialMailbox: {
        localpart: "*",
        domain: "example.com",
        canSend: true,
      },
    });
    assert.equal(createBob.statusCode, 201);
    const bobId = createBob.json().user.id as string;
    const bobExtra = await admin.post(app, `/v1/users/${bobId}/mailboxes`, {
      localpart: "bob",
      domain: "example.net",
      canSend: true,
    });
    assert.equal(bobExtra.statusCode, 201);

    // Deliver 4 distinct messages
    const mAlice = await deliver(db, dir, ["Alice@Example.com"], "Subject: code 482910\r\n\r\nYour OTP is 482910\r\n", ++clock);
    const mAlicePlus = await deliver(db, dir, ["alice+github@example.com"], "Subject: PR review\r\n\r\nHello\r\n", ++clock);
    const mBobCatchAll = await deliver(db, dir, ["anything@example.com"], "Subject: domain catchall\r\n\r\nFor Bob\r\n", ++clock);
    const mOwner = await deliver(db, dir, ["ops@example.org"], "Subject: server alert\r\n\r\nFor Owner\r\n", ++clock);

    await alice.login(app, "alice", "alice-password-123");
    await bob.login(app, "bob", "bob-password-123");

    // Session role metadata
    const aliceSession = (await alice.get(app, "/v1/session")).json();
    assert.equal(aliceSession.role, "member");
    assert.equal(aliceSession.mailboxes.length, 1);
    assert.equal(aliceSession.mailboxes[0].address, "alice@example.com");

    // Alice sees exact + subaddress (+github), nothing else
    const aliceList = (await alice.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.deepEqual(aliceList.map((m) => m.id).sort(), [mAlice.id, mAlicePlus.id].sort());

    // Bob sees *@example.com catch-all, NOT alice@example.com or alice+github@example.com
    const bobList = (await bob.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.deepEqual(bobList.map((m) => m.id), [mBobCatchAll.id]);

    // Admin default ('mine') sees only unallocated ops@example.org; scope=all sees all 4; scope=user:alice sees Alice's 2
    const adminMine = (await admin.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.deepEqual(adminMine.map((m) => m.id), [mOwner.id]);

    const adminAll = (await admin.get(app, "/v1/messages?scope=all")).json().items as Array<{ id: string }>;
    assert.equal(adminAll.length, 4);

    const adminInspectAlice = (await admin.get(app, `/v1/messages?scope=user:${aliceId}`)).json().items as Array<{ id: string }>;
    assert.deepEqual(adminInspectAlice.map((m) => m.id).sort(), [mAlice.id, mAlicePlus.id].sort());

    // Strict cross-tenant 404 isolation on detail and raw endpoints
    assert.equal((await alice.get(app, `/v1/messages/${mBobCatchAll.id}`)).statusCode, 404);
    assert.equal((await alice.get(app, `/v1/messages/${mOwner.id}/raw`)).statusCode, 404);
    assert.equal((await bob.get(app, `/v1/messages/${mAlice.id}`)).statusCode, 404);

    // Mark-all-read and mark-unread for Alice
    assert.equal(((await alice.get(app, "/v1/unread")).json() as { inbox: number }).inbox, 2);
    const readAllRes = await alice.post(app, "/v1/messages/read-all", {});
    assert.equal(readAllRes.statusCode, 200);
    assert.equal(readAllRes.json().count, 2);
    assert.equal(((await alice.get(app, "/v1/unread")).json() as { inbox: number }).inbox, 0);

    const unreadRes = await alice.post(app, `/v1/messages/${mAlice.id}/unread`, {});
    assert.equal(unreadRes.statusCode, 200);
    assert.equal(((await alice.get(app, "/v1/unread")).json() as { inbox: number }).inbox, 1);
    // Bob's unread count is untouched
    assert.equal(((await bob.get(app, "/v1/unread")).json() as { inbox: number }).inbox, 1);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shared multi-recipient mail isolates read/label/delete state, redacts BCC, and reference-counts physical purge", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-shared-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 18, 10, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const admin = jar();
  const alice = jar();
  const bob = jar();

  try {
    await admin.login(app, "admin", adminPassword);
    await admin.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "example.com" },
    });
    await admin.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      initialMailbox: { localpart: "bob", domain: "example.com" },
    });

    const boundary = "----sharedbound";
    const rawMime = [
      "From: Sender <sender@outside.test>",
      "To: team@outside.test",
      "Subject: Shared Doc",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please review attached.",
      "",
      `--${boundary}`,
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      "",
      "confidential-attachment-payload",
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const shared = await deliver(db, dir, ["alice@example.com", "bob@example.com"], rawMime, ++clock);
    const workerOpts: WorkerOptions = {
      db,
      dataDir: dir,
      codec: gzipCodec(),
      banner: "mx.test",
      log: silent,
      authenticate: async () =>
        authResultSchema.parse({
          schema: 1,
          spf: "pass",
          dkim: "none",
          dmarc: "pass",
          arc: "none",
          rdns: { ptr: null, match: false },
          headers: "",
        }),
      classifier: fakeClassifier(() => clock),
      notifiers: [],
      notifyLabels: ["phish"],
      notifyMinConfidence: 0.6,
      promptsDir: defaultPromptsDir(),
      panelBaseUrl: "http://127.0.0.1:8080",
      now: () => clock,
    };
    while (await processNext(workerOpts, "w1")) {
      // drain auth -> parse -> classify -> notify
    }

    await alice.login(app, "alice", "alice-password-123");
    await bob.login(app, "bob", "bob-password-123");

    // BCC / envelope privacy: Alice only sees alice@example.com in envelopeTo, never bob@example.com
    const aliceDetail = (await alice.get(app, `/v1/messages/${shared.id}`)).json();
    assert.deepEqual(aliceDetail.envelopeTo, ["alice@example.com"]);
    assert.equal(JSON.stringify(aliceDetail.smtpMeta).includes("bob@example.com"), false);
    const attSha = aliceDetail.attachments[0]?.sha256 as string;
    assert.ok(attSha);

    // Alice overrides label to legit & reads it; Bob still sees gray & unread
    await alice.post(app, `/v1/messages/${shared.id}/read`, {});
    await alice.patch(app, `/v1/messages/${shared.id}/label`, { label: "legit" });

    const bobList = (await bob.get(app, "/v1/messages?label=gray")).json().items as Array<{ id: string; read: boolean; label: string }>;
    assert.equal(bobList.length, 1);
    assert.equal(bobList[0]?.read, false);
    assert.equal(bobList[0]?.label, "gray");

    const msgRow = db.prepare("SELECT raw_path FROM messages WHERE id = ?").get(shared.id) as { raw_path: string };
    const rawAbs = resolveInside(dir, msgRow.raw_path);
    assert.equal(fs.existsSync(rawAbs), true);

    // Alice deletes her copy -> hidden for Alice, but physical EML & attachment remain for Bob!
    const aliceDel = await alice.delete(app, `/v1/messages/${shared.id}`);
    assert.equal(aliceDel.statusCode, 200);
    assert.equal((await alice.get(app, `/v1/messages/${shared.id}`)).statusCode, 404);
    assert.equal((await alice.get(app, `/v1/attachments/${attSha}`)).statusCode, 404);
    assert.equal(fs.existsSync(rawAbs), true);
    assert.equal((await bob.get(app, `/v1/attachments/${attSha}`)).statusCode, 200);

    // Bob deletes his copy -> zero active owners remain -> physical EML & orphan attachment are purged!
    const bobDel = await bob.delete(app, `/v1/messages/${shared.id}`);
    assert.equal(bobDel.statusCode, 200);
    assert.equal(fs.existsSync(rawAbs), false);
    assert.equal(db.prepare("SELECT id FROM messages WHERE id = ?").get(shared.id), undefined);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("member RBAC, outbound sender authorization, daily send quota, session revocation, and AI key probe", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-rbac-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 18, 12, 0, 0);
  const leakedSecret = "AIzaSySecretKeyValueForProbe9876";

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "gemini",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
    probeFetch: async (url) => {
      const target = String(url);
      if (target.includes("bad-model")) {
        return new Response(`key=${leakedSecret} model bad-model not valid`, { status: 403 });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
    },
  });

  const admin = jar();
  const alice = jar();
  const bob = jar();

  try {
    await admin.login(app, "admin", adminPassword);

    // Test AI Key Probe & secret scrubbing
    const savedAi = await admin.put(app, "/v1/settings/ai", {
      models: ["gemini-2.5-flash"],
      keys: [{ secret: leakedSecret }],
    });
    assert.equal(savedAi.statusCode, 200);
    const keyId = savedAi.json().aiPool.keys[0].id as string;

    const okProbe = await admin.post(app, "/v1/settings/ai/test-key", { id: keyId });
    assert.equal(okProbe.statusCode, 200);
    assert.equal(okProbe.json().ok, true);
    assert.equal(okProbe.json().model, "gemini-2.5-flash");
    assert.equal(typeof okProbe.json().latencyMs, "number");

    const errProbe = await admin.post(app, "/v1/settings/ai/test-key", { id: keyId, model: "bad-model" });
    assert.equal(errProbe.statusCode, 200);
    assert.equal(errProbe.json().ok, false);
    assert.equal(JSON.stringify(errProbe.json()).includes(leakedSecret), false);

    // Create Alice (exact alice@example.com) and Bob (wildcard *@example.com, quota 2)
    const aliceCreated = await admin.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      recoveryEmail: "alice.ext@example.com",
      initialMailbox: { localpart: "alice", domain: "example.com", displayName: "Alice Studio", canSend: true },
    });
    const aliceId = aliceCreated.json().user.id as string;

    await admin.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      quotaSendPerDay: 2,
      initialMailbox: { localpart: "*", domain: "example.com", canSend: true },
    });

    await alice.login(app, "alice", "alice-password-123");
    await bob.login(app, "bob", "bob-password-123");

    // Member RBAC blocks admin-only endpoints
    assert.equal((await alice.get(app, "/v1/users")).statusCode, 403);
    assert.equal((await alice.get(app, "/v1/jobs/summary")).statusCode, 403);
    assert.equal((await alice.put(app, "/v1/settings/domains", { domains: ["evil.com"] })).statusCode, 403);
    assert.equal((await alice.post(app, "/v1/settings/ai/test-key", { id: keyId })).statusCode, 403);
    // Member GET /v1/settings never leaks AI pool or channels
    const memberSettings = (await alice.get(app, "/v1/settings")).json();
    assert.equal(memberSettings.aiPool, undefined);
    assert.equal(memberSettings.channels, undefined);

    // Bob (*@example.com) CANNOT spoof alice@example.com!
    const spoof = await bob.post(app, "/v1/outbox", {
      from: "alice@example.com",
      to: ["friend@outside.test"],
      subject: "spoof",
      text: "hi",
    });
    assert.equal(spoof.statusCode, 403);

    // Alice CAN send from alice+billing@example.com and gets her mailbox displayName injected
    const aliceSent = await alice.post(app, "/v1/outbox", {
      from: "alice+billing@example.com",
      to: ["client@outside.test"],
      subject: "Invoice",
      text: "Attached",
    });
    assert.equal(aliceSent.statusCode, 202);
    const aliceRaw = await alice.get(app, `/v1/outbox/${aliceSent.json().id}/raw`);
    assert.match(aliceRaw.body, /From: .*Alice Studio.* <alice\+billing@example\.com>|From: =\?UTF-8\?B\?[^ ]+ <alice\+billing@example\.com>/);
    // Bob cannot view Alice's sent mail
    assert.equal((await bob.get(app, `/v1/outbox/${aliceSent.json().id}`)).statusCode, 404);

    // Bob's daily send quota of 2 is enforced
    assert.equal(
      (await bob.post(app, "/v1/outbox", { from: "bob@example.com", to: ["x@outside.test"], subject: "1", text: "1" })).statusCode,
      202,
    );
    assert.equal(
      (await bob.post(app, "/v1/outbox", { from: "news@example.com", to: ["x@outside.test"], subject: "2", text: "2" })).statusCode,
      202,
    );
    assert.equal(
      (await bob.post(app, "/v1/outbox", { from: "news@example.com", to: ["x@outside.test"], subject: "3", text: "3" })).statusCode,
      429,
    );

    // Disabling Alice immediately invalidates Alice's active session without logging out Bob or Admin
    const disableRes = await admin.patch(app, `/v1/users/${aliceId}`, { status: "disabled" });
    assert.equal(disableRes.statusCode, 200);
    assert.equal((await alice.get(app, "/v1/me")).statusCode, 401);
    assert.equal((await bob.get(app, "/v1/me")).statusCode, 200);

    // Re-enabling Alice allows self-service password reset via recoveryEmail without dropping Admin's session
    await admin.patch(app, `/v1/users/${aliceId}`, { status: "active" });
    const anon = jar();
    await anon.csrf(app);
    const forgot = await anon.post(app, "/v1/password/forgot", { email: "alice.ext@example.com" });
    assert.equal(forgot.statusCode, 200);

    const latestOut = db
      .prepare("SELECT raw_path, sha256 FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get() as { raw_path: string; sha256: string };
    const rawReset = (await readRaw(dir, latestOut.raw_path, gzipCodec(), latestOut.sha256)).toString("utf8");
    const bodyPart = rawReset.split("\r\n\r\n")[1] ?? "";
    const decoded = /Content-Transfer-Encoding: base64/i.test(rawReset)
      ? Buffer.from(bodyPart.replace(/\s/g, ""), "base64").toString("utf8")
      : bodyPart;
    const codeMatch = decoded.match(/验证码 (\d{6})/);
    assert.ok(codeMatch?.[1]);

    const resetDone = await anon.post(app, "/v1/password/reset", {
      email: "alice.ext@example.com",
      code: codeMatch[1],
      next: "alice-brand-new-pass",
    });
    assert.equal(resetDone.statusCode, 200);
    // Admin session stays alive!
    assert.equal((await admin.get(app, "/v1/me")).statusCode, 200);
    // Alice logs in with her new password
    await alice.login(app, "alice", "alice-brand-new-pass");
    assert.equal((await alice.get(app, "/v1/me")).json().user, "alice");
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("admin delete follows the requested scope and emptying all-scope trash keeps other holders", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-scope-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 18, 14, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const admin = jar();
  const alice = jar();
  const carol = jar();

  try {
    await admin.login(app, "admin", adminPassword);
    const createAlice = await admin.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "example.com" },
    });
    assert.equal(createAlice.statusCode, 201);
    const aliceId = createAlice.json().user.id as string;
    const createBob = await admin.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      initialMailbox: { localpart: "bob", domain: "example.com" },
    });
    assert.equal(createBob.statusCode, 201);
    const createCarol = await admin.post(app, "/v1/users", {
      username: "carol",
      password: "carol-password-123",
      role: "admin",
    });
    assert.equal(createCarol.statusCode, 201);

    const shared = await deliver(db, dir, ["ops@example.com", "alice@example.com"], "Subject: shared\r\n\r\nHi\r\n", ++clock);
    const carolOnly = await deliver(db, dir, ["carolbox@example.com"], "Subject: carol\r\n\r\nHi\r\n", ++clock);
    const kept = await deliver(db, dir, ["alice@example.com", "bob@example.com"], "Subject: keep\r\n\r\nHi\r\n", ++clock);

    await alice.login(app, "alice", "alice-password-123");
    await carol.login(app, "carol", "carol-password-123");

    const carolMine = (await carol.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.deepEqual(carolMine.map((item) => item.id), []);

    const quietDelete = await admin.delete(app, `/v1/messages/${shared.id}`);
    assert.equal(quietDelete.statusCode, 200);
    assert.equal((await alice.get(app, `/v1/messages/${shared.id}`)).statusCode, 200);
    assert.equal(db.prepare("SELECT id FROM messages WHERE id = ?").get(shared.id) === undefined, false);
    const adminMine = (await admin.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.equal(adminMine.some((item) => item.id === shared.id), false);

    const userDelete = await admin.delete(app, `/v1/messages/${kept.id}?scope=user:${aliceId}`);
    assert.equal(userDelete.statusCode, 200);
    assert.equal((await alice.get(app, `/v1/messages/${kept.id}`)).statusCode, 404);
    const bob = jar();
    await bob.login(app, "bob", "bob-password-123");
    assert.equal((await bob.get(app, `/v1/messages/${kept.id}`)).statusCode, 200);

    const wiped = await admin.delete(app, `/v1/messages/${carolOnly.id}?scope=all`);
    assert.equal(wiped.statusCode, 200);
    assert.equal(db.prepare("SELECT id FROM messages WHERE id = ?").get(carolOnly.id), undefined);

    const trashed = await deliver(db, dir, ["alice@example.com"], "Subject: trash\r\n\r\nHi\r\n", ++clock);
    const trashRes = await admin.post(app, `/v1/messages/${trashed.id}/trash?scope=all`, {});
    assert.equal(trashRes.statusCode, 200);
    const ownerTrash = (await admin.get(app, "/v1/messages?trashed=1")).json().items as Array<{ id: string }>;
    assert.equal(ownerTrash.some((item) => item.id === trashed.id), true);
    const restored = await admin.post(app, `/v1/messages/${trashed.id}/restore`, {});
    assert.equal(restored.statusCode, 200);
    assert.equal((await alice.get(app, `/v1/messages/${trashed.id}`)).statusCode, 200);
    const ownerTrashAfter = (await admin.get(app, "/v1/messages?trashed=1")).json().items as Array<{ id: string }>;
    assert.equal(ownerTrashAfter.some((item) => item.id === trashed.id), false);

    await admin.post(app, `/v1/messages/${trashed.id}/trash?scope=all`, {});
    const emptied = await admin.post(app, "/v1/messages/empty-trash?scope=all", {});
    assert.equal(emptied.statusCode, 200);
    assert.equal((await alice.get(app, `/v1/messages/${trashed.id}`)).statusCode, 200);
    assert.deepEqual(db.prepare("SELECT trashed_at FROM messages WHERE id = ?").get(trashed.id), { trashed_at: null });
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a collaborative admin cannot manage other admins, and a member scope=all stays on their own mail", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-owner-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 18, 16, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const owner = jar();
  const carol = jar();
  const alice = jar();
  const aliceOther = jar();
  const bob = jar();

  try {
    await owner.login(app, "admin", adminPassword);
    const createAlice = await owner.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "example.com" },
    });
    assert.equal(createAlice.statusCode, 201);
    const createCarol = await owner.post(app, "/v1/users", {
      username: "carol",
      password: "carol-password-123",
      role: "admin",
    });
    assert.equal(createCarol.statusCode, 201);
    const carolId = createCarol.json().user.id as string;
    const createBob = await owner.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      role: "admin",
    });
    assert.equal(createBob.statusCode, 201);
    const bobId = createBob.json().user.id as string;

    await carol.login(app, "carol", "carol-password-123");
    await bob.login(app, "bob", "bob-password-123");
    const granted = await carol.post(app, "/v1/users", {
      username: "extra",
      password: "extra-password-123",
      role: "admin",
    });
    assert.equal(granted.statusCode, 403);
    assert.equal(granted.json().reason, "only_owner_can_grant_admin");
    const memberOk = await carol.post(app, "/v1/users", {
      username: "dave",
      password: "dave-password-123",
    });
    assert.equal(memberOk.statusCode, 201);

    const disableAdmin = await carol.patch(app, `/v1/users/${bobId}`, { status: "disabled" });
    assert.equal(disableAdmin.statusCode, 403);
    assert.equal(disableAdmin.json().reason, "only_owner_can_manage_admin");
    const resetAdmin = await carol.put(app, `/v1/users/${bobId}/password`, { next: "bob-password-456" });
    assert.equal(resetAdmin.statusCode, 403);
    assert.equal(resetAdmin.json().reason, "only_owner_can_manage_admin");
    const deleteAdmin = await carol.delete(app, `/v1/users/${bobId}`);
    assert.equal(deleteAdmin.statusCode, 403);
    const disableSelf = await carol.patch(app, `/v1/users/${carolId}`, { status: "disabled" });
    assert.equal(disableSelf.statusCode, 400);
    assert.equal(disableSelf.json().reason, "cannot_disable_self");

    const ownerDisable = await owner.patch(app, `/v1/users/${bobId}`, { status: "disabled" });
    assert.equal(ownerDisable.statusCode, 200);
    assert.equal((await bob.get(app, "/v1/me")).statusCode, 401);

    await alice.login(app, "alice", "alice-password-123");
    await aliceOther.login(app, "alice", "alice-password-123");
    const changed = await alice.put(app, "/v1/settings/password", {
      current: "alice-password-123",
      next: "alice-password-456",
    });
    assert.equal(changed.statusCode, 200);
    assert.equal((await alice.get(app, "/v1/me")).statusCode, 200);
    assert.equal((await aliceOther.get(app, "/v1/me")).statusCode, 401);

    const forAlice = await deliver(db, dir, ["alice@example.com"], "Subject: alice\r\n\r\nHi\r\n", ++clock);
    const forOwner = await deliver(db, dir, ["ops@example.com"], "Subject: ops\r\n\r\nHi\r\n", ++clock);
    const scoped = (await alice.get(app, "/v1/messages?scope=all")).json().items as Array<{ id: string }>;
    assert.deepEqual(scoped.map((item) => item.id), [forAlice.id]);
    assert.equal(scoped.some((item) => item.id === forOwner.id), false);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a prefix mailbox outranks the domain star, and a collaborative admin cannot send as someone else", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-prefix-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 18, 18, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const owner = jar();
  const carol = jar();
  const dave = jar();

  try {
    await owner.login(app, "admin", adminPassword);
    const createCarol = await owner.post(app, "/v1/users", {
      username: "carol",
      password: "carol-password-123",
      initialMailbox: { localpart: "alerts-*", domain: "example.com", canSend: true },
    });
    assert.equal(createCarol.statusCode, 201);
    await owner.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      initialMailbox: { localpart: "*", domain: "example.com", canSend: true },
    });
    const createDave = await owner.post(app, "/v1/users", {
      username: "dave",
      password: "dave-password-123",
      role: "admin",
      initialMailbox: { localpart: "dave", domain: "example.com", canSend: true },
    });
    assert.equal(createDave.statusCode, 201);
    await owner.post(app, `/v1/users/${createCarol.json().user.id}/mailboxes`, {
      localpart: "team*",
      domain: "example.com",
      canSend: true,
    });

    const prod = await deliver(db, dir, ["alerts-prod@example.com"], "Subject: prod\r\n\r\nHi\r\n", ++clock);
    const exact = await deliver(db, dir, ["alice@example.com"], "Subject: alice\r\n\r\nHi\r\n", ++clock);
    const mate = await deliver(db, dir, ["teammate@example.com"], "Subject: mate\r\n\r\nHi\r\n", ++clock);
    const other = await deliver(db, dir, ["other@example.com"], "Subject: other\r\n\r\nHi\r\n", ++clock);

    await carol.login(app, "carol", "carol-password-123");
    const carolList = (await carol.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.deepEqual(carolList.map((item) => item.id).sort(), [prod.id, mate.id].sort());
    assert.equal(carolList.some((item) => item.id === exact.id), false);

    const bob = jar();
    await bob.login(app, "bob", "bob-password-123");
    const bobList = (await bob.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.deepEqual(bobList.map((item) => item.id).sort(), [exact.id, other.id].sort());

    await dave.login(app, "dave", "dave-password-123");
    const spoof = await dave.post(app, "/v1/outbox", {
      from: "alice@example.com",
      to: ["x@outside.test"],
      subject: "spoof",
      text: "hi",
    });
    assert.equal(spoof.statusCode, 403);
    const own = await dave.post(app, "/v1/outbox", {
      from: "dave@example.com",
      to: ["x@outside.test"],
      subject: "own",
      text: "hi",
    });
    assert.equal(own.statusCode, 202);
    const ownerSend = await owner.post(app, "/v1/outbox", {
      from: "alice@example.com",
      to: ["x@outside.test"],
      subject: "owner",
      text: "hi",
    });
    assert.equal(ownerSend.statusCode, 202);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a longer prefix wildcard outranks a shorter prefix and the domain star", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-prefix-length-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 19, 1, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const owner = jar();
  const short = jar();
  const long = jar();
  const catchAll = jar();

  try {
    await owner.login(app, "admin", adminPassword);
    await owner.post(app, "/v1/users", {
      username: "short",
      password: "short-password-123",
      initialMailbox: { localpart: "alerts-*", domain: "example.com" },
    });
    await owner.post(app, "/v1/users", {
      username: "long",
      password: "long-password-123",
      initialMailbox: { localpart: "alerts-prod-*", domain: "example.com" },
    });
    await owner.post(app, "/v1/users", {
      username: "catch",
      password: "catch-password-123",
      initialMailbox: { localpart: "*", domain: "example.com" },
    });

    const eu = await deliver(db, dir, ["alerts-prod-eu@example.com"], "Subject: eu\r\n\r\nHi\r\n", ++clock);
    const stage = await deliver(db, dir, ["alerts-stage@example.com"], "Subject: stage\r\n\r\nHi\r\n", ++clock);
    const other = await deliver(db, dir, ["other@example.com"], "Subject: other\r\n\r\nHi\r\n", ++clock);

    await short.login(app, "short", "short-password-123");
    await long.login(app, "long", "long-password-123");
    await catchAll.login(app, "catch", "catch-password-123");

    const shortList = (await short.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    const longList = (await long.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    const catchList = (await catchAll.get(app, "/v1/messages")).json().items as Array<{ id: string }>;

    assert.deepEqual(shortList.map((item) => item.id), [stage.id]);
    assert.deepEqual(longList.map((item) => item.id), [eu.id]);
    assert.deepEqual(catchList.map((item) => item.id), [other.id]);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a single-character mailbox keeps its plus-tag base for receiving and sending", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-single-base-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 19, 2, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const owner = jar();
  const single = jar();
  const catchAll = jar();

  try {
    await owner.login(app, "admin", adminPassword);
    await owner.post(app, "/v1/users", {
      username: "single",
      password: "single-password-123",
      initialMailbox: { localpart: "a", domain: "example.com", canSend: true },
    });
    await owner.post(app, "/v1/users", {
      username: "catch",
      password: "catch-password-123",
      initialMailbox: { localpart: "*", domain: "example.com", canSend: true },
    });

    const exact = await deliver(db, dir, ["a@example.com"], "Subject: exact\r\n\r\nHi\r\n", ++clock);
    const tagged = await deliver(db, dir, ["a+github@example.com"], "Subject: tagged\r\n\r\nHi\r\n", ++clock);

    await single.login(app, "single", "single-password-123");
    await catchAll.login(app, "catch", "catch-password-123");

    const singleList = (await single.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    const catchList = (await catchAll.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.deepEqual(singleList.map((item) => item.id).sort(), [exact.id, tagged.id].sort());
    assert.deepEqual(catchList.map((item) => item.id), []);

    const sendTagged = await single.post(app, "/v1/outbox", {
      from: "a+github@example.com",
      to: ["x@outside.test"],
      subject: "tagged",
      text: "hi",
    });
    assert.equal(sendTagged.statusCode, 202);

    const catchSpoof = await catchAll.post(app, "/v1/outbox", {
      from: "a+github@example.com",
      to: ["x@outside.test"],
      subject: "spoof",
      text: "hi",
    });
    assert.equal(catchSpoof.statusCode, 403);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("partial blocklists keep classification and the unblocked holder's webhook running", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-partial-block-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 19, 3, 0, 0);
  const originalFetch = globalThis.fetch;
  const webhookHits: string[] = [];
  const globalHits: string[] = [];

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const owner = jar();
  const alice = jar();
  const bob = jar();

  try {
    await owner.login(app, "admin", adminPassword);
    const createAlice = await owner.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "example.com" },
    });
    const aliceId = createAlice.json().user.id as string;
    const createBob = await owner.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      initialMailbox: { localpart: "bob", domain: "example.com" },
    });
    assert.equal(createBob.statusCode, 201);

    await alice.login(app, "alice", "alice-password-123");
    await bob.login(app, "bob", "bob-password-123");
    const blocked = await alice.put(app, "/v1/settings/blocklist", { addresses: ["sender@outside.test"] });
    assert.equal(blocked.statusCode, 200);
    const notify = await bob.put(app, "/v1/settings/notify/personal", {
      labels: ["gray"],
      minConfidence: 0.1,
      webhookUrl: "https://bob.hooks/in",
    });
    assert.equal(notify.statusCode, 200);

    globalThis.fetch = (async (input) => {
      webhookHits.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const shared = await deliver(
      db,
      dir,
      ["alice@example.com", "bob@example.com"],
      "Subject: partial block\r\n\r\nHi\r\n",
      ++clock,
    );

    const workerOpts: WorkerOptions = {
      db,
      dataDir: dir,
      codec: gzipCodec(),
      banner: "mx.test",
      log: silent,
      authenticate: async () =>
        authResultSchema.parse({
          schema: 1,
          spf: "pass",
          dkim: "none",
          dmarc: "pass",
          arc: "none",
          rdns: { ptr: null, match: false },
          headers: "",
        }),
      classifier: fakeClassifier(() => clock),
      notifiers: [{
        id: "global",
        async notify(input: { label: string }) {
          globalHits.push(input.label);
        },
      }],
      notifyLabels: ["gray"],
      notifyMinConfidence: 0,
      promptsDir: defaultPromptsDir(),
      panelBaseUrl: "http://127.0.0.1:8080",
      now: () => clock,
    };
    while (await processNext(workerOpts, "w1")) {
      // drain auth -> parse -> classify -> notify
    }

    const classified = db.prepare("SELECT ai_result FROM messages WHERE id = ?").get(shared.id) as { ai_result: string };
    assert.equal((JSON.parse(classified.ai_result) as { label: string }).label, "gray");

    const aliceInbox = (await alice.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    const aliceTrash = (await alice.get(app, "/v1/messages?trashed=1")).json().items as Array<{ id: string }>;
    const bobInbox = (await bob.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.equal(aliceInbox.some((item) => item.id === shared.id), false);
    assert.equal(aliceTrash.some((item) => item.id === shared.id), true);
    assert.equal(bobInbox.some((item) => item.id === shared.id), true);

    assert.deepEqual(globalHits, ["gray"]);
    assert.equal(webhookHits.includes("https://bob.hooks/in"), true);
    assert.equal(webhookHits.some((url) => url.includes("alice.hooks")), false);
    const aliceState = db
      .prepare("SELECT trashed_at FROM user_message_state WHERE user_id = ? AND message_id = ?")
      .get(aliceId, shared.id) as { trashed_at: number | null } | undefined;
    assert.notEqual(aliceState?.trashed_at, null);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("global empty trash records the owner soft delete and releases the shared reference", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-empty-release-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 19, 4, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const owner = jar();
  const alice = jar();

  try {
    await owner.login(app, "admin", adminPassword);
    await owner.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "example.com" },
    });

    const shared = await deliver(
      db,
      dir,
      ["ops@example.com", "alice@example.com"],
      "Subject: release\r\n\r\nHi\r\n",
      ++clock,
    );
    const rawRow = db.prepare("SELECT raw_path FROM messages WHERE id = ?").get(shared.id) as { raw_path: string };
    const rawAbs = resolveInside(dir, rawRow.raw_path);
    assert.equal(fs.existsSync(rawAbs), true);

    await owner.post(app, `/v1/messages/${shared.id}/trash?scope=all`, {});
    const emptied = await owner.post(app, "/v1/messages/empty-trash?scope=all", {});
    assert.equal(emptied.statusCode, 200);

    assert.deepEqual(db.prepare("SELECT trashed_at FROM messages WHERE id = ?").get(shared.id), { trashed_at: null });
    const ownerState = db
      .prepare("SELECT deleted_at FROM user_message_state WHERE user_id = 'owner' AND message_id = ?")
      .get(shared.id) as { deleted_at: number | null };
    assert.notEqual(ownerState?.deleted_at, null);

    await alice.login(app, "alice", "alice-password-123");
    assert.equal((await owner.get(app, `/v1/messages/${shared.id}`)).statusCode, 404);
    assert.equal((await owner.post(app, `/v1/messages/${shared.id}/restore`, {})).statusCode, 404);
    assert.equal((await alice.get(app, `/v1/messages/${shared.id}`)).statusCode, 200);

    const released = await alice.delete(app, `/v1/messages/${shared.id}`);
    assert.equal(released.statusCode, 200);
    assert.equal(db.prepare("SELECT id FROM messages WHERE id = ?").get(shared.id), undefined);
    assert.equal(fs.existsSync(rawAbs), false);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a shared letter keeps stars, labels, trash, and soft-delete on the person who did them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-star-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 18, 19, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const owner = jar();
  const alice = jar();
  const bob = jar();
  const dave = jar();

  try {
    await owner.login(app, "admin", adminPassword);
    const createAlice = await owner.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "example.com" },
    });
    assert.equal(createAlice.statusCode, 201);
    const aliceId = createAlice.json().user.id as string;
    await owner.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      initialMailbox: { localpart: "bob", domain: "example.com" },
    });
    const createDave = await owner.post(app, "/v1/users", {
      username: "dave",
      password: "dave-password-123",
      role: "admin",
      initialMailbox: { localpart: "dave", domain: "example.com" },
    });
    assert.equal(createDave.statusCode, 201);
    const daveId = createDave.json().user.id as string;

    const shared = await deliver(db, dir, ["alice@example.com", "bob@example.com"], "Subject: shared\r\n\r\nHi\r\n", ++clock);
    await alice.login(app, "alice", "alice-password-123");
    await bob.login(app, "bob", "bob-password-123");
    await dave.login(app, "dave", "dave-password-123");

    const starred = await alice.post(app, `/v1/messages/${shared.id}/star`, { starred: true });
    assert.equal(starred.statusCode, 200);
    assert.equal(starred.json().starred, true);
    const labeled = await alice.patch(app, `/v1/messages/${shared.id}/label`, { label: "spam" });
    assert.equal(labeled.statusCode, 200);

    const bobDetail = (await bob.get(app, `/v1/messages/${shared.id}`)).json();
    assert.equal(bobDetail.starred, false);
    assert.equal(bobDetail.aiResult, null);
    assert.equal(bobDetail.trashedAt, null);

    const aliceDetail = (await alice.get(app, `/v1/messages/${shared.id}`)).json();
    assert.equal(aliceDetail.starred, true);
    assert.equal(aliceDetail.aiResult.label, "spam");

    const previewBefore = (await dave.get(app, `/v1/messages?scope=user:${aliceId}`)).json().items as Array<{
      id: string;
      starred: boolean;
      label: string | null;
    }>;
    const previewRow = previewBefore.find((item) => item.id === shared.id);
    assert.ok(previewRow);
    assert.equal(previewRow?.starred, false);
    assert.equal(previewRow?.label, "spam");

    const daveStar = await dave.post(app, `/v1/messages/${shared.id}/star`, { starred: true });
    assert.equal(daveStar.statusCode, 200);
    const previewAfter = (await dave.get(app, `/v1/messages?scope=user:${aliceId}`)).json().items as Array<{
      id: string;
      starred: boolean;
    }>;
    assert.equal(previewAfter.find((item) => item.id === shared.id)?.starred, true);
    assert.equal((await alice.get(app, `/v1/messages/${shared.id}`)).json().starred, true);
    assert.equal((await bob.get(app, `/v1/messages/${shared.id}`)).json().starred, false);

    const ownerStar = await owner.post(app, `/v1/messages/${shared.id}/star`, { starred: true });
    assert.equal(ownerStar.statusCode, 200);
    const starRows = db
      .prepare("SELECT user_id, starred_at FROM user_message_state WHERE message_id = ?")
      .all(shared.id) as Array<{ user_id: string; starred_at: number | null }>;
    const starOf = (userId: string) => starRows.find((row) => row.user_id === userId)?.starred_at ?? null;
    assert.ok(starOf(aliceId));
    assert.ok(starOf(daveId));
    assert.ok(starOf("owner"));
    assert.equal(starRows.some((row) => row.user_id !== aliceId && row.user_id !== daveId && row.user_id !== "owner"), false);

    const ownerStarred = (await owner.get(app, "/v1/messages?scope=all&starred=true")).json().items as Array<{ id: string }>;
    assert.equal(ownerStarred.some((item) => item.id === shared.id), true);
    const bobStarred = (await bob.get(app, "/v1/messages?starred=true")).json().items as Array<{ id: string }>;
    assert.equal(bobStarred.some((item) => item.id === shared.id), false);

    const daveClear = await dave.post(app, `/v1/messages/${shared.id}/star`, { starred: false });
    assert.equal(daveClear.statusCode, 200);
    assert.equal(daveClear.json().starred, false);
    assert.equal((await alice.get(app, `/v1/messages/${shared.id}`)).json().starred, true);
    assert.equal(
      (
        db.prepare("SELECT starred_at FROM user_message_state WHERE user_id = ? AND message_id = ?").get(daveId, shared.id) as {
          starred_at: number | null;
        }
      ).starred_at,
      null,
    );
    assert.ok(
      (
        db.prepare("SELECT starred_at FROM user_message_state WHERE user_id = ? AND message_id = ?").get("owner", shared.id) as {
          starred_at: number | null;
        }
      ).starred_at,
    );

    const trashed = await alice.post(app, `/v1/messages/${shared.id}/trash`, {});
    assert.equal(trashed.statusCode, 200);
    const bobInbox = (await bob.get(app, "/v1/messages")).json().items as Array<{ id: string; starred: boolean; label: string | null }>;
    const bobRow = bobInbox.find((item) => item.id === shared.id);
    assert.ok(bobRow);
    assert.equal(bobRow?.starred, false);
    assert.equal(bobRow?.label, null);
    const aliceInbox = (await alice.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.equal(aliceInbox.some((item) => item.id === shared.id), false);
    const aliceTrash = (await alice.get(app, "/v1/messages?trashed=true")).json().items as Array<{ id: string; starred: boolean }>;
    assert.equal(aliceTrash.find((item) => item.id === shared.id)?.starred, true);

    const removed = await alice.delete(app, `/v1/messages/${shared.id}`);
    assert.equal(removed.statusCode, 200);
    assert.equal((await alice.get(app, `/v1/messages/${shared.id}`)).statusCode, 404);
    const bobAfter = await bob.get(app, `/v1/messages/${shared.id}`);
    assert.equal(bobAfter.statusCode, 200);
    assert.equal(bobAfter.json().starred, false);
    assert.equal(bobAfter.json().aiResult, null);
    assert.equal(bobAfter.json().trashedAt, null);
    assert.ok(db.prepare("SELECT id FROM messages WHERE id = ?").get(shared.id));

    const messageCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    assert.equal(messageCols.some((col) => col.name === "starred_at"), false);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("audit list filters by actor and action, and redacts secrets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-audit-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 18, 20, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const owner = jar();
  const alice = jar();

  try {
    await owner.login(app, "admin", adminPassword);
    const created = await owner.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "example.com" },
    });
    assert.equal(created.statusCode, 201);
    await alice.login(app, "alice", "alice-password-123");

    const denied = await alice.get(app, "/v1/audit");
    assert.equal(denied.statusCode, 403);

    const aliceLogin = (await owner.get(app, "/v1/audit?actor=alice&action=login")).json().items as Array<{
      actor: string;
      action: string;
    }>;
    assert.equal(aliceLogin.length, 1);
    assert.equal(aliceLogin[0]?.actor, "alice");
    assert.equal(aliceLogin[0]?.action, "login");

    const createdByAdmin = (await owner.get(app, "/v1/audit?actor=admin&action=user_create")).json().items as Array<{
      action: string;
    }>;
    assert.equal(createdByAdmin.length, 1);
    assert.equal(createdByAdmin[0]?.action, "user_create");

    const secretLine = "posted ?key=sk-abcdefghijklmnopqrstuvwxyz AIzaSyDUMMYKEY123456";
    db.prepare("INSERT INTO audit_log (id, at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
      "audit_secret",
      ++clock,
      "admin",
      "settings_ai",
      null,
      secretLine,
    );
    const leaked = (await owner.get(app, "/v1/audit?actor=admin&action=settings_ai")).json().items as Array<{
      detail: string | null;
    }>;
    assert.equal(leaked.length, 1);
    assert.match(leaked[0]?.detail ?? "", /\[redacted\]/);
    assert.equal((leaked[0]?.detail ?? "").includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal((leaked[0]?.detail ?? "").includes("AIzaSyDUMMYKEY123456"), false);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("allocating a mailbox checks the domain against the current accept list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mu-domain-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 18, 21, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const owner = jar();

  try {
    await owner.login(app, "admin", adminPassword);
    const created = await owner.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "other.test" },
    });
    assert.equal(created.statusCode, 400);
    assert.equal(created.json().reason, "domain is not accepted");
    assert.equal((await owner.get(app, "/v1/users")).json().items.length, 0);

    const ok = await owner.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "example.com" },
    });
    assert.equal(ok.statusCode, 201);
    const aliceId = ok.json().user.id as string;
    const extra = await owner.post(app, `/v1/users/${aliceId}/mailboxes`, {
      localpart: "ops",
      domain: "other.test",
    });
    assert.equal(extra.statusCode, 400);
    assert.equal(extra.json().reason, "domain is not accepted");
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a personal webhook is sent only to the resolved holder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-hook-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => Date.UTC(2026, 10, 19, 8, 0, 0),
  });
  const admin = jar();
  const alice = jar();
  const bob = jar();
  const originalFetch = globalThis.fetch;
  const seen: Array<{ who: string; auth: string | null; panel: string }> = [];

  try {
    await admin.login(app, "admin", adminPassword);
    const aliceCreated = await admin.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "alice", domain: "example.com", canSend: true },
    });
    assert.equal(aliceCreated.statusCode, 201);
    const aliceId = aliceCreated.json().user.id as string;
    const bobCreated = await admin.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      initialMailbox: { localpart: "bob", domain: "example.com", canSend: true },
    });
    assert.equal(bobCreated.statusCode, 201);
    const bobId = bobCreated.json().user.id as string;
    await alice.login(app, "alice", "alice-password-123");
    await bob.login(app, "bob", "bob-password-123");

    const aliceSaved = await alice.put(app, "/v1/settings/notify/personal", {
      labels: ["phish"],
      minConfidence: 0.6,
      webhookUrl: "https://alice.hooks/in",
      webhookBearer: "alice-webhook-secret",
    });
    assert.equal(aliceSaved.statusCode, 200);
    assert.equal(aliceSaved.json().notifyWebhookBearerSet, true);
    assert.equal(JSON.stringify(aliceSaved.json()).includes("alice-webhook-secret"), false);
    const aliceKept = await alice.put(app, "/v1/settings/notify/personal", {
      labels: ["phish"],
      minConfidence: 0.6,
      webhookUrl: "https://alice.hooks/in",
    });
    assert.equal(aliceKept.statusCode, 200);
    assert.equal(aliceKept.json().notifyWebhookBearerSet, true);

    const bobSaved = await bob.put(app, "/v1/settings/notify/personal", {
      labels: ["phish"],
      minConfidence: 0.6,
      webhookUrl: "https://bob.hooks/in",
      webhookBearer: "bob-webhook-secret",
    });
    assert.equal(bobSaved.statusCode, 200);
    const ownerSaved = await admin.put(app, "/v1/settings/notify/personal", {
      labels: ["phish"],
      minConfidence: 0.6,
      webhookUrl: "https://owner.hooks/in",
    });
    assert.equal(ownerSaved.statusCode, 200);

    const badUrl = await alice.put(app, "/v1/settings/notify/personal", {
      labels: ["phish"],
      minConfidence: 0.6,
      webhookUrl: "ftp://alice.hooks/in",
    });
    assert.equal(badUrl.statusCode, 400);
    assert.equal(badUrl.json().reason, "invalid webhook url");
    assert.equal((await alice.put(app, "/v1/settings/notify", { labels: ["spam"], minConfidence: 0.2 })).statusCode, 403);

    const aliceView = (await alice.get(app, "/v1/settings")).json();
    assert.equal(aliceView.personalNotify.notifyWebhookUrl, "https://alice.hooks/in");
    assert.equal(aliceView.personalNotify.notifyWebhookBearerSet, true);
    assert.equal(JSON.stringify(aliceView).includes("alice-webhook-secret"), false);
    assert.equal(aliceView.channels, undefined);
    const adminView = (await admin.get(app, "/v1/settings")).json();
    assert.deepEqual(adminView.notifyLabels, ["legit"]);
    assert.equal(adminView.personalNotify.notifyWebhookUrl, "https://owner.hooks/in");
    const audit = (await admin.get(app, "/v1/audit?actor=alice&action=settings_notify_personal")).json();
    assert.equal(JSON.stringify(audit).includes("alice-webhook-secret"), false);
    assert.equal(JSON.stringify(audit).includes("https://alice.hooks/in"), false);

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as { url?: string };
      const who = url.includes("alice.hooks") ? "alice" : url.includes("bob.hooks") ? "bob" : url.includes("owner.hooks") ? "owner" : url;
      seen.push({ who, auth: headers.get("authorization"), panel: body.url ?? "" });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const globalHits: string[] = [];
    const notifyDeps = {
      db,
      log: silent,
      now: () => 20,
      notifiers: [{
        id: "webhook",
        async notify(input: { label: string }) {
          globalHits.push(input.label);
        },
      }],
      notifyLabels: ["phish", "malware"],
      notifyMinConfidence: 0.6,
      panelBaseUrl: "http://127.0.0.1:8080/",
    };

    seedClassified(db, "msg_bob", "ab".repeat(32), ["bob@example.com"]);
    enqueueJob(db, { id: "job_bob", type: "notify", messageId: "msg_bob", now: 1 });
    await runNotifyJob(notifyDeps, notifyJob("job_bob", "msg_bob"));
    assert.deepEqual(globalHits, ["phish"]);
    assert.deepEqual(seen.map((item) => item.who), ["bob"]);
    assert.equal(seen[0]?.auth, "Bearer bob-webhook-secret");
    assert.equal(seen[0]?.panel, "http://127.0.0.1:8080/#/m/msg_bob");
    const stored = db.prepare("SELECT payload FROM jobs WHERE id = ?").get("job_bob") as { payload: string };
    const notified = (JSON.parse(stored.payload) as { notified: string[] }).notified;
    assert.ok(notified.includes("webhook"));
    assert.ok(notified.includes(`user:${bobId}:webhook`));
    assert.equal(notified.includes(`user:${aliceId}:webhook`), false);
    const beforeRetry = seen.length;
    await runNotifyJob(notifyDeps, notifyJob("job_bob", "msg_bob", stored.payload));
    assert.equal(seen.length, beforeRetry);
    assert.deepEqual(globalHits, ["phish"]);

    seen.length = 0;
    globalHits.length = 0;
    seedClassified(db, "msg_both", "cd".repeat(32), ["alice@example.com", "bob@example.com"]);
    enqueueJob(db, { id: "job_both", type: "notify", messageId: "msg_both", now: 2 });
    await runNotifyJob(notifyDeps, notifyJob("job_both", "msg_both"));
    assert.deepEqual(globalHits, ["phish"]);
    assert.deepEqual(seen.map((item) => item.who).slice().sort(), ["alice", "bob"]);
    assert.equal(seen.find((item) => item.who === "alice")?.auth, "Bearer alice-webhook-secret");

    seen.length = 0;
    globalHits.length = 0;
    await alice.put(app, "/v1/settings/notify/personal", {
      labels: ["phish"],
      minConfidence: 0.99,
      webhookUrl: "https://alice.hooks/in",
    });
    seedClassified(db, "msg_low", "ef".repeat(32), ["alice@example.com"], 0.9);
    enqueueJob(db, { id: "job_low", type: "notify", messageId: "msg_low", now: 3 });
    await runNotifyJob(notifyDeps, notifyJob("job_low", "msg_low"));
    assert.deepEqual(globalHits, ["phish"]);
    assert.equal(seen.length, 0);

    seen.length = 0;
    globalHits.length = 0;
    await alice.put(app, "/v1/settings/notify/personal", {
      labels: ["phish"],
      minConfidence: 0.6,
      webhookUrl: "https://alice.hooks/in",
    });
    seedClassified(db, "msg_trashed", "12".repeat(32), ["alice@example.com"]);
    db.prepare(
      "INSERT INTO user_message_state (user_id, message_id, trashed_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(aliceId, "msg_trashed", 5, 5);
    enqueueJob(db, { id: "job_trashed", type: "notify", messageId: "msg_trashed", now: 4 });
    await runNotifyJob(notifyDeps, notifyJob("job_trashed", "msg_trashed"));
    assert.deepEqual(globalHits, ["phish"]);
    assert.equal(seen.length, 0);

    seen.length = 0;
    globalHits.length = 0;
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(bobId);
    seedClassified(db, "msg_disabled", "34".repeat(32), ["bob@example.com"]);
    enqueueJob(db, { id: "job_disabled", type: "notify", messageId: "msg_disabled", now: 5 });
    await runNotifyJob(notifyDeps, notifyJob("job_disabled", "msg_disabled"));
    assert.deepEqual(globalHits, ["phish"]);
    assert.equal(seen.length, 0);

    seen.length = 0;
    globalHits.length = 0;
    seedClassified(db, "msg_owner", "56".repeat(32), ["other@example.com"]);
    enqueueJob(db, { id: "job_owner", type: "notify", messageId: "msg_owner", now: 6 });
    await runNotifyJob(notifyDeps, notifyJob("job_owner", "msg_owner"));
    assert.deepEqual(globalHits, ["phish"]);
    assert.deepEqual(seen.map((item) => item.who), ["owner"]);
    assert.equal(seen[0]?.panel, "http://127.0.0.1:8080/#/m/msg_owner");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedClassified(db: Db, id: string, sha256: string, envelopeTo: string[], confidence = 0.9): void {
  insertMessage(db, {
    id,
    sha256,
    rawPath: `raw/${id}`,
    sizeBytes: 20,
    receivedAt: 10,
    envelopeFrom: "sender@outside.test",
    envelopeTo,
    domains: ["example.com"],
    smtpMeta: {},
    now: 10,
  });
  db.prepare("UPDATE messages SET subject = ?, from_addr = ?, ai_result = ?, status = 'classified' WHERE id = ?").run(
    "工资条",
    "payroll@outside.test",
    JSON.stringify({
      schema: 1,
      prompt_id: "classify-v1",
      model: "fake",
      provider: "fake",
      at: "2026-11-19T00:00:00.000Z",
      label: "phish",
      confidence,
      summary: "looks notable",
      tags: [],
      signals: [],
    }),
    id,
  );
}

function notifyJob(id: string, messageId: string, payload: string | null = null): JobRow {
  return {
    id,
    type: "notify",
    message_id: messageId,
    payload,
    status: "running",
    attempts: 1,
    max_attempts: 5,
    run_after: 1,
    locked_at: 1,
    locked_by: "t",
    last_error: null,
    created_at: 1,
    updated_at: 1,
  };
}

async function deliver(db: Db, dir: string, rcptTo: string[], content: string, receivedAtMs: number) {
  return acceptMessage(
    { db, dataDir: dir, codec: gzipCodec() },
    {
      bytes: Buffer.from(content, "utf8"),
      receivedAtMs,
      meta: buildSmtpMeta({
        remoteIp: "203.0.113.25",
        reverseDns: "mx.sender.test",
        helo: "mx.sender.test",
        mailFrom: "sender@outside.test",
        rcptTo,
        secure: true,
        receivedAtMs,
        localIp: "127.0.0.1",
        localPort: 2525,
      }),
    },
  );
}

function jar() {
  let cookie = "";
  let token = "";
  const merge = (setCookie: string | string[] | undefined) => {
    const map = new Map<string, string>();
    for (const part of cookie.split(";").filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const line of lines) {
      const pair = (line.split(";")[0] ?? "").trim();
      const eq = pair.indexOf("=");
      if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    cookie = [...map].map(([k, v]) => `${k}=${v}`).join("; ");
  };
  return {
    async csrf(app: Awaited<ReturnType<typeof buildApi>>) {
      const res = await app.inject({ method: "GET", url: "/v1/csrf", headers: cookie ? { cookie } : {} });
      merge(res.headers["set-cookie"]);
      token = res.json().token as string;
    },
    async login(app: Awaited<ReturnType<typeof buildApi>>, username: string, password: string) {
      await this.csrf(app);
      const res = await app.inject({
        method: "POST",
        url: "/v1/login",
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload: { username, password },
      });
      merge(res.headers["set-cookie"]);
      assert.equal(res.statusCode, 200);
      await this.csrf(app);
    },
    async get(app: Awaited<ReturnType<typeof buildApi>>, url: string) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      merge(res.headers["set-cookie"]);
      return res;
    },
    async post(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      });
      merge(res.headers["set-cookie"]);
      return res;
    },
    async put(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>) {
      const res = await app.inject({
        method: "PUT",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      });
      merge(res.headers["set-cookie"]);
      return res;
    },
    async patch(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>) {
      const res = await app.inject({
        method: "PATCH",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      });
      merge(res.headers["set-cookie"]);
      return res;
    },
    async delete(app: Awaited<ReturnType<typeof buildApi>>, url: string) {
      const res = await app.inject({
        method: "DELETE",
        url,
        headers: { cookie, "x-csrf-token": token },
      });
      merge(res.headers["set-cookie"]);
      return res;
    },
  };
}
