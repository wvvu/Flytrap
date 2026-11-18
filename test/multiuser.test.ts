import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import PostalMime from "postal-mime";
import { buildApi } from "../src/api/app.js";
import { gzipCodec } from "../src/compress.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { acceptMessage } from "../src/ingest/accept.js";
import { readRaw } from "../src/ingest/read-raw.js";
import { parseMessage } from "../src/mail/parse.js";
import { migrationsDir, resolveInside } from "../src/paths.js";
import { buildSmtpMeta } from "../src/smtp/session-meta.js";

const adminPassword = "admin-strong-password";
const secret = "0123456789abcdef0123456789abcdef";

interface Injected {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  json: () => any;
}

test("multi-user accounts isolate inboxes, shared EML deletions, attachments, and outbound identities", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-multiuser-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const codec = gzipCodec();
  let clock = Date.UTC(2026, 10, 17, 10, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com,friend.org",
      API_USERNAME: "admin",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "gemini",
      GEMINI_API_KEYS: "AIzaSyTestSecretKeyValue9876",
    }),
    db,
    codec,
    log: false,
    now: () => clock,
    probeFetchImpl: async (input) => {
      clock += 42;
      if (String(input).includes("AIzaSyTestSecretKeyValue9876")) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "pong" }] } }] }), {
          status: 200,
        });
      }
      return new Response("Invalid key leaked", { status: 403 });
    },
  });

  const admin = cookieJar();
  const alice = cookieJar();
  const bob = cookieJar();

  try {
    await admin.login(app, "admin", adminPassword);

    const adminProfile = await admin.get(app, "/v1/profile");
    assert.equal(adminProfile.statusCode, 200);
    assert.equal(adminProfile.json().role, "admin");
    assert.equal(adminProfile.json().catchAll, true);

    // AI Key live probe works and never leaks secret
    const probeRes = await admin.post(app, "/v1/settings/ai/test-key", {});
    assert.equal(probeRes.statusCode, 200);
    assert.equal(probeRes.json().ok, true);
    assert.equal(probeRes.json().latencyMs, 42);
    assert.equal(JSON.stringify(probeRes.json()).includes("AIzaSyTestSecretKeyValue9876"), false);

    // Create member Alice with exact mailbox alice@example.com
    const createAlice = await admin.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      displayName: "Alice",
      recoveryEmail: "alice@example.com",
      role: "member",
      mailboxes: [{ localpart: "alice", domain: "example.com", displayName: "Alice Wang" }],
    });
    assert.equal(createAlice.statusCode, 201);
    const aliceId = createAlice.json().user.id as string;

    // Create member Bob with whole-domain delegation *@friend.org
    const createBob = await admin.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      displayName: "Bob",
      role: "member",
      mailboxes: [{ localpart: "*", domain: "friend.org", displayName: "Bob Studio" }],
    });
    assert.equal(createBob.statusCode, 201);

    await alice.login(app, "alice", "alice-password-123");
    await bob.login(app, "bob", "bob-password-123");

    // RBAC: Members are blocked from admin endpoints and global scope
    assert.equal((await alice.get(app, "/v1/users")).statusCode, 403);
    assert.equal((await alice.get(app, "/v1/dkim")).statusCode, 403);
    assert.equal((await alice.get(app, "/v1/jobs/summary")).statusCode, 403);
    assert.equal((await alice.get(app, "/v1/messages?scope=all")).statusCode, 403);
    assert.equal((await alice.post(app, "/v1/settings/ai/test-key", {})).statusCode, 403);

    // 1. Sub-addressed mail to alice+github@example.com routes exclusively to Alice
    const mAlice = await acceptMessage(
      { db, dataDir: dir, codec },
      {
        bytes: Buffer.from("From: noreply@github.com\r\nSubject: PR merged\r\n\r\nCode 482910\r\n"),
        receivedAtMs: ++clock,
        meta: smtpMeta(["alice+github@example.com"], clock),
      },
    );

    // 2. Wildcard domain mail to hello@friend.org with an attachment routes exclusively to Bob
    const boundary = "----attbound";
    const attBytes = Buffer.from("Bob confidential attachment");
    const rawBob = Buffer.from(
      [
        "From: client@partner.test",
        "To: hello@friend.org",
        "Subject: Contract",
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Please review",
        `--${boundary}`,
        'Content-Type: text/plain; name="secret.txt"',
        'Content-Disposition: attachment; filename="secret.txt"',
        "Content-Transfer-Encoding: base64",
        "",
        attBytes.toString("base64"),
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const mBob = await acceptMessage(
      { db, dataDir: dir, codec },
      {
        bytes: rawBob,
        receivedAtMs: ++clock,
        meta: smtpMeta(["hello@friend.org"], clock),
      },
    );
    await parseMessage(rawBob, { db, dataDir: dir, messageId: mBob.id, now: ++clock });

    // 3. Unmatched address ops@example.com routes to catch-all Admin
    const mAdmin = await acceptMessage(
      { db, dataDir: dir, codec },
      {
        bytes: Buffer.from("From: monitor@infra.test\r\nSubject: Disk OK\r\n\r\nall good\r\n"),
        receivedAtMs: ++clock,
        meta: smtpMeta(["ops@example.com"], clock),
      },
    );

    // 4. Shared EML delivered to BOTH alice@example.com and team@friend.org (single raw file!)
    const sharedBytes = Buffer.from("From: news@digest.test\r\nSubject: Shared Weekly\r\n\r\nshared body\r\n");
    const mShared = await acceptMessage(
      { db, dataDir: dir, codec },
      {
        bytes: sharedBytes,
        receivedAtMs: ++clock,
        meta: smtpMeta(["alice@example.com", "team@friend.org"], clock),
      },
    );
    const sharedRow = db.prepare("SELECT raw_path FROM messages WHERE id = ?").get(mShared.id) as { raw_path: string };

    // Verify strict inbox isolation
    const aliceMsgs = (await alice.get(app, "/v1/messages")).json().items.map((x: { id: string }) => x.id);
    assert.deepEqual(aliceMsgs, [mShared.id, mAlice.id]);

    const bobMsgs = (await bob.get(app, "/v1/messages")).json().items.map((x: { id: string }) => x.id);
    assert.deepEqual(bobMsgs, [mShared.id, mBob.id]);

    const adminMine = (await admin.get(app, "/v1/messages")).json().items.map((x: { id: string }) => x.id);
    assert.deepEqual(adminMine, [mAdmin.id]);

    // Admin can switch to scope=all to inspect all 4 messages
    const adminAll = (await admin.get(app, "/v1/messages?scope=all")).json().items.map((x: { id: string }) => x.id);
    assert.equal(adminAll.length, 4);

    // Attachment IDOR protection: Alice cannot fetch Bob's attachment
    const bobDetail = (await bob.get(app, `/v1/messages/${mBob.id}`)).json();
    const bobAttSha = bobDetail.attachments[0].sha256 as string;
    assert.equal((await bob.get(app, `/v1/attachments/${bobAttSha}`)).statusCode, 200);
    assert.equal((await alice.get(app, `/v1/attachments/${bobAttSha}`)).statusCode, 404);
    assert.equal((await alice.get(app, `/v1/messages/${mBob.id}`)).statusCode, 404);

    // Star, Unread, Read-All & Batch actions work per user
    assert.equal((await alice.post(app, `/v1/messages/${mAlice.id}/star`, { starred: true })).statusCode, 200);
    const aliceStarred = (await alice.get(app, "/v1/messages?starred=true")).json().items;
    assert.equal(aliceStarred.length, 1);
    assert.equal(aliceStarred[0].id, mAlice.id);

    assert.equal((await alice.get(app, "/v1/unread")).json().inbox, 2);
    const readAll = await alice.post(app, "/v1/messages/read-all", { view: "inbox" });
    assert.equal(readAll.json().count, 2);
    assert.equal((await alice.get(app, "/v1/unread")).json().inbox, 0);

    // Bob's copy of mShared is STILL unread even though Alice marked all read!
    assert.equal((await bob.get(app, "/v1/unread")).json().inbox, 2);

    // Mark unread again
    await alice.post(app, `/v1/messages/${mAlice.id}/unread`, {});
    assert.equal((await alice.get(app, "/v1/unread")).json().inbox, 1);

    // Batch mark read
    const batchRes = await alice.post(app, "/v1/messages/batch", {
      ids: [mAlice.id],
      action: "read",
    });
    assert.equal(batchRes.json().count, 1);
    assert.equal((await alice.get(app, "/v1/unread")).json().inbox, 0);

    // Shared EML reference-counted deletion: Alice deletes mShared, Bob's copy and raw file survive!
    assert.equal((await alice.delete(app, `/v1/messages/${mShared.id}`)).statusCode, 200);
    assert.equal((await alice.get(app, `/v1/messages/${mShared.id}`)).statusCode, 404);
    assert.equal(fs.existsSync(resolveInside(dir, sharedRow.raw_path)), true);
    const bobSharedStill = await bob.get(app, `/v1/messages/${mShared.id}`);
    assert.equal(bobSharedStill.statusCode, 200);

    // Once Bob also deletes mShared, the physical raw file is unlinked from disk!
    assert.equal((await bob.delete(app, `/v1/messages/${mShared.id}`)).statusCode, 200);
    assert.equal(fs.existsSync(resolveInside(dir, sharedRow.raw_path)), false);

    // Outbound From authorization & MIME attachment composition
    const spoofAttempt = await alice.post(app, "/v1/outbox", {
      from: "admin@example.com",
      to: ["ext@outside.test"],
      subject: "Spoof",
      text: "nope",
    });
    assert.equal(spoofAttempt.statusCode, 403);

    const aliceSend = await alice.post(app, "/v1/outbox", {
      from: "alice+work@example.com",
      to: ["ext@outside.test"],
      subject: "Hello with file",
      text: "See attached note.",
      attachments: [
        {
          filename: "note.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("attached-hello-world").toString("base64"),
        },
      ],
    });
    assert.equal(aliceSend.statusCode, 202);
    const sentId = aliceSend.json().id as string;

    // Bob cannot view Alice's sent mail
    assert.equal((await bob.get(app, `/v1/outbox/${sentId}`)).statusCode, 404);
    assert.equal((await bob.get(app, "/v1/outbox")).json().items.length, 0);
    assert.equal((await alice.get(app, "/v1/outbox")).json().items.length, 1);

    // Verify composed MIME attachment parses cleanly
    const outRow = db.prepare("SELECT raw_path, sha256 FROM outbox WHERE id = ?").get(sentId) as {
      raw_path: string;
      sha256: string;
    };
    const composedBytes = await readRaw(dir, outRow.raw_path, codec, outRow.sha256);
    const parsedOut = await PostalMime.parse(composedBytes);
    assert.equal(parsedOut.from?.name, "Alice Wang");
    assert.equal(parsedOut.from?.address, "alice+work@example.com");
    assert.equal(parsedOut.attachments.length, 1);
    assert.equal(parsedOut.attachments[0]?.filename, "note.txt");
    assert.equal(Buffer.from(parsedOut.attachments[0]!.content as ArrayBuffer).toString("utf8"), "attached-hello-world");

    // Bob with *@friend.org can send from any localpart on friend.org
    const bobSend = await bob.post(app, "/v1/outbox", {
      from: "billing@friend.org",
      to: ["ext@outside.test"],
      subject: "Invoice",
      text: "Thanks",
    });
    assert.equal(bobSend.statusCode, 202);

    // Suspending Alice immediately revokes her active session
    const suspendRes = await admin.patch(app, `/v1/users/${aliceId}`, { disabled: true });
    assert.equal(suspendRes.statusCode, 200);
    assert.equal((await alice.get(app, "/v1/messages")).statusCode, 401);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function smtpMeta(rcptTo: string[], receivedAtMs: number) {
  return buildSmtpMeta({
    remoteIp: "203.0.113.10",
    reverseDns: "mail.sender.test",
    helo: "mail.sender.test",
    mailFrom: "sender@sender.test",
    rcptTo,
    secure: false,
    receivedAtMs,
    localIp: "127.0.0.1",
    localPort: 2525,
  });
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
    cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  };

  return {
    async csrf(app: Awaited<ReturnType<typeof buildApi>>) {
      const res = await app.inject({ method: "GET", url: "/v1/csrf", headers: cookie ? { cookie } : {} });
      take(res.headers["set-cookie"]);
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
      take(res.headers["set-cookie"]);
      assert.equal(res.statusCode, 200);
      await this.csrf(app);
    },
    async get(app: Awaited<ReturnType<typeof buildApi>>, url: string): Promise<Injected> {
      const res = (await app.inject({ method: "GET", url, headers: { cookie } })) as Injected;
      take(res.headers["set-cookie"]);
      return res;
    },
    async post(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>): Promise<Injected> {
      const res = (await app.inject({
        method: "POST",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      })) as Injected;
      take(res.headers["set-cookie"]);
      return res;
    },
    async patch(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>): Promise<Injected> {
      const res = (await app.inject({
        method: "PATCH",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      })) as Injected;
      take(res.headers["set-cookie"]);
      return res;
    },
    async delete(app: Awaited<ReturnType<typeof buildApi>>, url: string): Promise<Injected> {
      const res = (await app.inject({
        method: "DELETE",
        url,
        headers: { cookie, "x-csrf-token": token },
      })) as Injected;
      take(res.headers["set-cookie"]);
      return res;
    },
  };
}
