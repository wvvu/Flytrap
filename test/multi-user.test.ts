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
