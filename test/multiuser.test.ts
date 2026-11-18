import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApi } from "../src/api/app.js";
import { gzipCodec } from "../src/compress.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { linkAttachment, upsertAttachment } from "../src/db/repos/attachments.js";
import { insertMessage } from "../src/db/repos/messages.js";
import { sha256 } from "../src/hash.js";
import { readRaw } from "../src/ingest/read-raw.js";
import { storeRaw } from "../src/ingest/store-raw.js";
import { migrationsDir } from "../src/paths.js";

const adminPass = "admin-strong-password-1";
const secret = "0123456789abcdef0123456789abcdef";

test("multi-user accounts enforce strict inbound/outbound/attachment isolation and admin governance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-multiuser-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 17, 10, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com,team.org",
      API_USERNAME: "admin",
      API_PASSWORD: adminPass,
      SESSION_SECRET: secret,
      CLASSIFIER: "gemini",
      GEMINI_API_KEYS: "AIzaSyTestKey1234567890abcd",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
    probeFetch: async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      label: "legit",
                      confidence: 0.99,
                      summary: "验证邮件",
                      tags: ["otp"],
                      signals: [],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  const admin = jar();
  const alice = jar();
  const bob = jar();

  try {
    await admin.csrf(app);
    const adminLogin = await admin.post(app, "/v1/login", { username: "admin", password: adminPass });
    assert.equal(adminLogin.statusCode, 200);
    await admin.csrf(app);

    // 1. Admin creates Alice (exact mailbox + prefix) and Bob (whole domain *@team.org, quota=1)
    const createAlice = await admin.post(app, "/v1/users", {
      username: "alice",
      displayName: "Alice Lin",
      password: "alice-password-99",
      role: "member",
      quotaSendDay: 5,
      allocations: [
        { localpart: "alice", domain: "example.com", canSend: true },
        { localpart: "alerts-*", domain: "example.com", canSend: false },
      ],
    });
    assert.equal(createAlice.statusCode, 201);
    const aliceId = createAlice.json().user.id as string;

    const createBob = await admin.post(app, "/v1/users", {
      username: "bob@team.org",
      displayName: "Bob Chen",
      password: "bob-password-88",
      role: "member",
      quotaSendDay: 1,
      allocations: [{ address: "*@team.org", canSend: true }],
    });
    assert.equal(createBob.statusCode, 201);
    const bobId = createBob.json().user.id as string;

    // 2. Seed inbound messages:
    // - msg_alice: to alice+github@example.com (tests RFC 5233 +tag subaddressing!)
    // - msg_prefix: to alerts-prod@example.com (tests prefix wildcard!)
    // - msg_bob: to hello@team.org with a private attachment
    // - msg_shared: single EML delivered to BOTH alice@example.com AND ceo@team.org!
    // - msg_admin_only: to root@example.com
    const seedMail = async (id: string, subject: string, toList: string[]) => {
      const bytes = Buffer.from(`From: sender@ext.test\r\nTo: ${toList.join(", ")}\r\nSubject: ${subject}\r\n\r\nBody ${id}\r\n`);
      const stored = await storeRaw({ dataDir: dir, bytes, receivedAtMs: clock, codec: gzipCodec() });
      insertMessage(db, {
        id,
        sha256: stored.sha256,
        rawPath: stored.relativePath,
        sizeBytes: bytes.length,
        receivedAt: clock,
        envelopeFrom: "sender@ext.test",
        envelopeTo: toList,
        domains: ["example.com"],
        smtpMeta: { schema: 1, remoteIp: "198.51.100.2" },
        now: clock,
      });
      db.prepare("UPDATE messages SET subject = ?, from_addr = 'sender@ext.test', parsed = ? WHERE id = ?").run(
        subject,
        JSON.stringify({
          schema: 1,
          subject,
          from: { name: "Sender", address: "sender@ext.test" },
          replyTo: null,
          text: `Body ${id}`,
          htmlBytes: 0,
          urls: [],
          attachmentCount: id === "msg_bob" ? 1 : 0,
        }),
        id,
      );
      clock += 1000;
    };

    await seedMail("msg_alice", "GitHub Login Code", ["Alice+github@example.com"]);
    await seedMail("msg_prefix", "Prod Alert", ["alerts-prod@example.com"]);
    await seedMail("msg_bob", "Bob Secret Contract", ["hello@team.org"]);
    await seedMail("msg_shared", "Shared Announcement", ["alice@example.com", "ceo@team.org"]);
    await seedMail("msg_admin_only", "Root Notice", ["root@example.com"]);

    // Store a private attachment linked ONLY to msg_bob
    const attBytes = Buffer.from("bob-confidential-pdf");
    const attSha = sha256(attBytes);
    const attRel = `attachments/aa/bb/${attSha}`;
    fs.mkdirSync(path.join(dir, "attachments/aa/bb"), { recursive: true });
    fs.writeFileSync(path.join(dir, attRel), attBytes);
    upsertAttachment(db, { sha256: attSha, path: attRel, mime: "application/pdf", sizeBytes: attBytes.length, now: clock });
    linkAttachment(db, { messageId: "msg_bob", sha256: attSha, filename: "contract.pdf", contentId: null });

    // 3. Login as Alice & Bob
    await alice.csrf(app);
    assert.equal((await alice.post(app, "/v1/login", { username: "alice", password: "alice-password-99" })).statusCode, 200);
    await alice.csrf(app);

    await bob.csrf(app);
    assert.equal((await bob.post(app, "/v1/login", { username: "bob@team.org", password: "bob-password-88" })).statusCode, 200);
    await bob.csrf(app);

    // 4. Verify strict visibility isolation
    const aliceList = (await alice.get(app, "/v1/messages")).json().items.map((m: { id: string }) => m.id).sort();
    assert.deepEqual(aliceList, ["msg_alice", "msg_prefix", "msg_shared"]);

    const bobList = (await bob.get(app, "/v1/messages")).json().items.map((m: { id: string }) => m.id).sort();
    assert.deepEqual(bobList, ["msg_bob", "msg_shared"]);

    // Alice CANNOT access Bob's message, raw EML, html, or Bob's attachment!
    assert.equal((await alice.get(app, "/v1/messages/msg_bob")).statusCode, 404);
    assert.equal((await alice.get(app, "/v1/messages/msg_bob/raw")).statusCode, 404);
    assert.equal((await alice.get(app, "/v1/messages/msg_bob/html")).statusCode, 404);
    assert.equal((await alice.get(app, "/v1/messages/msg_admin_only")).statusCode, 404);
    assert.equal((await alice.get(app, `/v1/attachments/${attSha}`)).statusCode, 404);

    // Bob CAN download Bob's attachment!
    const bobAtt = await bob.get(app, `/v1/attachments/${attSha}`);
    assert.equal(bobAtt.statusCode, 200);
    assert.equal(bobAtt.body, "bob-confidential-pdf");

    // Member CANNOT hit Admin endpoints!
    assert.equal((await alice.get(app, "/v1/users")).statusCode, 403);
    assert.equal((await alice.get(app, "/v1/jobs")).statusCode, 403);
    assert.equal((await alice.get(app, "/v1/logs")).statusCode, 403);
    assert.equal((await alice.get(app, "/v1/audit")).statusCode, 403);
    assert.equal((await alice.put(app, "/v1/settings/domains", { domains: ["evil.com"] })).statusCode, 403);
    assert.equal((await alice.post(app, "/v1/dkim", { domain: "example.com" })).statusCode, 403);

    // 5. Independent state on shared message (`msg_shared`):
    // Alice stars, relabels, trashes, and deletes `msg_shared` -> Bob & Admin still have it intact and unread!
    assert.equal((await alice.post(app, "/v1/messages/msg_shared/star", { starred: true })).statusCode, 200);
    assert.equal((await alice.patch(app, "/v1/messages/msg_shared/label", { label: "spam" })).statusCode, 200);
    assert.equal((await alice.post(app, "/v1/messages/msg_shared/trash", {})).statusCode, 200);
    assert.equal((await alice.delete(app, "/v1/messages/msg_shared")).statusCode, 200);
    assert.equal((await alice.get(app, "/v1/messages/msg_shared")).statusCode, 404);

    const bobShared = await bob.get(app, "/v1/messages/msg_shared");
    assert.equal(bobShared.statusCode, 200);
    assert.equal(bobShared.json().read, false);
    assert.equal(bobShared.json().starred, false);
    assert.equal(bobShared.json().trashedAt, null);

    const adminShared = await admin.get(app, "/v1/messages/msg_shared");
    assert.equal(adminShared.statusCode, 200);

    // 6. Outbound sender spoofing defense & daily quota enforcement:
    // Alice can send from alice@example.com and alice+tag@example.com,
    // CANNOT send from alerts-prod@example.com (canSend: false) or admin@example.com!
    const spoofAdmin = await alice.post(app, "/v1/outbox", {
      from: "admin@example.com",
      to: ["ext@other.net"],
      subject: "spoof",
      text: "no",
    });
    assert.equal(spoofAdmin.statusCode, 403);

    const noSendPerm = await alice.post(app, "/v1/outbox", {
      from: "alerts-prod@example.com",
      to: ["ext@other.net"],
      subject: "readonly",
      text: "no",
    });
    assert.equal(noSendPerm.statusCode, 403);

    const aliceSendOk = await alice.post(app, "/v1/outbox", {
      from: "alice+work@example.com",
      to: ["ext@other.net"],
      subject: "valid subaddress send",
      text: "hi",
    });
    assert.equal(aliceSendOk.statusCode, 202);
    const aliceSentId = aliceSendOk.json().id as string;

    // Bob has quotaSendDay = 1: first send succeeds, second returns 429!
    const bobSend1 = await bob.post(app, "/v1/outbox", {
      from: "sales@team.org",
      to: ["ext@other.net"],
      subject: "first",
      text: "ok",
    });
    assert.equal(bobSend1.statusCode, 202);
    const bobSend2 = await bob.post(app, "/v1/outbox", {
      from: "sales@team.org",
      to: ["ext@other.net"],
      subject: "second over quota",
      text: "blocked",
    });
    assert.equal(bobSend2.statusCode, 429);

    // Outbox isolation: Bob cannot see Alice's sent mail!
    assert.equal((await bob.get(app, `/v1/outbox/${aliceSentId}`)).statusCode, 404);
    assert.equal((await bob.get(app, "/v1/outbox")).json().items.length, 1);

    // 7. Batch & Mark-all-read + Star/Unread toggles
    const batchStar = await alice.post(app, "/v1/messages/batch", {
      ids: ["msg_alice", "msg_prefix", "msg_bob"],
      action: "star",
    });
    assert.equal(batchStar.statusCode, 200);
    // Only the 2 messages Alice owns are affected; msg_bob is untouched!
    assert.equal(batchStar.json().count, 2);
    assert.equal((await alice.get(app, "/v1/messages?starred=true")).json().items.length, 2);

    const markAll = await alice.post(app, "/v1/messages/mark-all-read", { scope: "inbox" });
    assert.equal(markAll.statusCode, 200);
    assert.equal((await alice.get(app, "/v1/unread")).json().inbox, 0);

    // 8. Admin AI Key Probe & Audit Log & Instant Session Revocation
    const probe = await admin.post(app, "/v1/settings/ai/test-key", {});
    assert.equal(probe.statusCode, 200);
    assert.equal(probe.json().ok, true);
    assert.equal(JSON.stringify(probe.json()).includes("AIzaSy"), false);

    // Admin filters inbox by memberId=bobId
    const adminFilterBob = await admin.get(app, `/v1/messages?memberId=${encodeURIComponent(bobId)}`);
    assert.deepEqual(
      adminFilterBob.json().items.map((m: { id: string }) => m.id).sort(),
      ["msg_bob", "msg_shared"],
    );

    // Disable Alice -> Alice's active session is immediately rejected (401)!
    const disableRes = await admin.patch(app, `/v1/users/${aliceId}`, { status: "disabled" });
    assert.equal(disableRes.statusCode, 200);
    assert.equal((await alice.get(app, "/v1/me")).statusCode, 401);
    assert.equal((await alice.get(app, "/v1/messages")).statusCode, 401);

    // Re-enable Alice & test self-service email password reset on allocated mailbox `alice@example.com`
    await admin.patch(app, `/v1/users/${aliceId}`, { status: "active" });
    clock += 5000;
    const anon = jar();
    await anon.csrf(app);
    const forgot = await anon.post(app, "/v1/password/forgot", { email: "alice@example.com" });
    assert.equal(forgot.statusCode, 200);

    const latestOutbox = db
      .prepare("SELECT raw_path, sha256 FROM outbox ORDER BY created_at DESC, id DESC LIMIT 1")
      .get() as { raw_path: string; sha256: string };
    const rawMail = (await readRaw(dir, latestOutbox.raw_path, gzipCodec(), latestOutbox.sha256)).toString("utf8");
    const split = rawMail.indexOf("\r\n\r\n");
    const bodyDecoded = /Content-Transfer-Encoding: base64/i.test(rawMail.slice(0, split))
      ? Buffer.from(rawMail.slice(split + 4).replace(/\s/g, ""), "base64").toString("utf8")
      : rawMail.slice(split + 4);
    const codeMatch = bodyDecoded.match(/验证码 (\d{6})/);
    assert.ok(codeMatch?.[1]);

    const resetOk = await anon.post(app, "/v1/password/reset", {
      email: "alice@example.com",
      code: codeMatch[1],
      next: "alice-brand-new-pass",
    });
    assert.equal(resetOk.statusCode, 200);

    await alice.csrf(app);
    assert.equal(
      (await alice.post(app, "/v1/login", { username: "alice", password: "alice-brand-new-pass" })).statusCode,
      200,
    );

    const audit = await admin.get(app, "/v1/audit?limit=20");
    assert.equal(audit.statusCode, 200);
    assert.ok(audit.json().items.length >= 5);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function jar() {
  let cookie = "";
  let token = "";
  const save = (setCookie: string | string[] | undefined) => {
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
      save(res.headers["set-cookie"]);
      token = res.json().token as string;
    },
    async get(app: Awaited<ReturnType<typeof buildApi>>, url: string) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      save(res.headers["set-cookie"]);
      return res;
    },
    async post(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      });
      save(res.headers["set-cookie"]);
      return res;
    },
    async put(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>) {
      const res = await app.inject({
        method: "PUT",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      });
      save(res.headers["set-cookie"]);
      return res;
    },
    async patch(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>) {
      const res = await app.inject({
        method: "PATCH",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      });
      save(res.headers["set-cookie"]);
      return res;
    },
    async delete(app: Awaited<ReturnType<typeof buildApi>>, url: string) {
      const res = await app.inject({
        method: "DELETE",
        url,
        headers: { cookie, "x-csrf-token": token },
      });
      save(res.headers["set-cookie"]);
      return res;
    },
  };
}
