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

const ownerPassword = "owner-root-secret-pw";
const sessionSecret = "0123456789abcdef0123456789abcdef";

interface Injected {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  json: () => any;
}

test("multi-user accounts enforce RBAC, +tag/prefix/domain mailbox isolation, independent state, quotas, session revocation, and AI key probing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-multiuser-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let clock = Date.UTC(2026, 10, 17, 12, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com,team.org",
      API_USERNAME: "root",
      API_PASSWORD: ownerPassword,
      SESSION_SECRET: sessionSecret,
      CLASSIFIER: "gemini",
      GEMINI_MODEL: "gemini-2.5-flash",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
    probeFetch: async (url) => {
      const target = String(url);
      if (target.includes("bad-key-secret")) {
        return new Response("API key not valid: bad-key-secret-9999", { status: 400 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      label: "legit",
                      confidence: 0.99,
                      summary: "连通正常",
                      tags: ["probe"],
                      signals: [],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const owner = cookieJar();
  const alice = cookieJar();
  const bob = cookieJar();
  const deputy = cookieJar();

  try {
    // 1. Owner logs in and inspects session capabilities
    await owner.csrf(app);
    const ownerLogin = await owner.post(app, "/v1/login", { username: "root", password: ownerPassword });
    assert.equal(ownerLogin.statusCode, 200);
    assert.deepEqual(ownerLogin.json(), { user: "root" });
    await owner.csrf(app);

    const ownerSession = (await owner.get(app, "/v1/session")).json();
    assert.equal(ownerSession.role, "owner");
    assert.equal(ownerSession.isAdmin, true);
    assert.equal(ownerSession.isOwner, true);

    // 2. Owner creates Alice (member: exact + prefix, quota=2), Bob (member: whole domain *@team.org, quota=0), and Deputy (admin)
    const createAlice = await owner.post(app, "/v1/users", {
      username: "alice",
      displayName: "Alice",
      password: "alice-password-123",
      role: "member",
      dailySendLimit: 2,
      allocations: [
        { pattern: "alice@example.com", canSend: true },
        { pattern: "ops-*@example.com", canSend: true },
      ],
    });
    assert.equal(createAlice.statusCode, 201);
    assert.equal(createAlice.json().user.allocations.length, 2);

    // Conflicting allocation to another user must return 409
    const createBobConflict = await owner.post(app, "/v1/users", {
      username: "bob",
      password: "bob-password-123",
      allocations: [{ pattern: "alice@example.com" }],
    });
    assert.equal(createBobConflict.statusCode, 409);

    const createBob = await owner.post(app, "/v1/users", {
      username: "bob@team.org",
      displayName: "Bob",
      password: "bob-password-123",
      role: "member",
      dailySendLimit: 0,
      allocations: [{ pattern: "*@team.org", canSend: true }],
    });
    assert.equal(createBob.statusCode, 201);
    const bobId = createBob.json().user.id as string;

    const createDeputy = await owner.post(app, "/v1/users", {
      username: "deputy",
      displayName: "Deputy Admin",
      password: "deputy-password-123",
      role: "admin",
    });
    assert.equal(createDeputy.statusCode, 201);

    // 3. Delegated admin cannot escalate or create another admin
    await deputy.csrf(app);
    assert.equal((await deputy.post(app, "/v1/login", { username: "deputy", password: "deputy-password-123" })).statusCode, 200);
    await deputy.csrf(app);
    const escalate = await deputy.post(app, "/v1/users", {
      username: "rogue-admin",
      password: "rogue-password-123",
      role: "admin",
    });
    assert.equal(escalate.statusCode, 403);

    // 4. Seed messages across exact (+tag), prefix, whole domain, shared, and unassigned addresses
    const seedMail = async (id: string, subject: string, rcpts: string[], label: string | null = "legit") => {
      const rawBytes = Buffer.from(`From: sender@ext.test\r\nTo: ${rcpts.join(", ")}\r\nSubject: ${subject}\r\n\r\nBody of ${id}\r\n`);
      const stored = await storeRaw({ dataDir: dir, bytes: rawBytes, receivedAtMs: clock, codec: gzipCodec() });
      const domains = [...new Set(rcpts.map((r) => r.split("@")[1]!))];
      insertMessage(db, {
        id,
        sha256: stored.sha256,
        rawPath: stored.relativePath,
        sizeBytes: rawBytes.length,
        receivedAt: clock,
        envelopeFrom: "sender@ext.test",
        envelopeTo: rcpts,
        domains,
        smtpMeta: { schema: 1, remoteIp: "198.51.100.5" },
        now: clock,
      });
      db.prepare("UPDATE messages SET subject = ?, from_addr = 'sender@ext.test', parsed = ?, ai_result = ?, status = 'classified' WHERE id = ?").run(
        subject,
        JSON.stringify({ schema: 1, subject, from: { name: "Sender", address: "sender@ext.test" }, replyTo: null, text: `Body of ${id}`, htmlBytes: 0, urls: [], attachmentCount: 0 }),
        label ? JSON.stringify({ schema: 1, prompt_id: "v1", model: "fake", provider: "fake", at: new Date(clock).toISOString(), label, confidence: 0.9, summary: subject, tags: [], signals: [] }) : null,
        id,
      );
      clock += 1000;
    };

    await seedMail("msg_alice_sub", "GitHub OTP 482910", ["alice+github@example.com"]);
    await seedMail("msg_alice_prefix", "Ops Alert", ["ops-alert@example.com"]);
    await seedMail("msg_bob_domain", "Team Invoice", ["billing@team.org"]);
    await seedMail("msg_shared", "Cross Team Notice", ["alice@example.com", "ceo@team.org"]);
    await seedMail("msg_unassigned", "Root Catchall Secret", ["vault@example.com"]);

    // Attach a private file ONLY to msg_alice_sub
    const attBytes = Buffer.from("alice-confidential-pdf");
    const attHash = sha256(attBytes);
    const attRel = "attachments/alice_secret.bin";
    fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dir, attRel), attBytes);
    upsertAttachment(db, { sha256: attHash, path: attRel, mime: "application/pdf", sizeBytes: attBytes.length, now: clock });
    linkAttachment(db, { messageId: "msg_alice_sub", sha256: attHash, filename: "secret.pdf", contentId: null });

    // 5. Alice & Bob log in and verify strict inbox, detail, and attachment isolation
    await alice.csrf(app);
    assert.equal((await alice.post(app, "/v1/login", { username: "alice", password: "alice-password-123" })).statusCode, 200);
    await alice.csrf(app);

    await bob.csrf(app);
    assert.equal((await bob.post(app, "/v1/login", { username: "bob@team.org", password: "bob-password-123" })).statusCode, 200);
    await bob.csrf(app);

    const aliceList = (await alice.get(app, "/v1/messages")).json().items.map((m: { id: string }) => m.id).sort();
    assert.deepEqual(aliceList, ["msg_alice_prefix", "msg_alice_sub", "msg_shared"]);

    const bobList = (await bob.get(app, "/v1/messages")).json().items.map((m: { id: string }) => m.id).sort();
    assert.deepEqual(bobList, ["msg_bob_domain", "msg_shared"]);

    // Bob cannot access Alice's message detail, raw EML, or attachment
    assert.equal((await bob.get(app, "/v1/messages/msg_alice_sub")).statusCode, 404);
    assert.equal((await bob.get(app, "/v1/messages/msg_alice_sub/raw")).statusCode, 404);
    assert.equal((await bob.get(app, `/v1/attachments/${attHash}`)).statusCode, 404);
    // Alice CAN download her attachment
    assert.equal((await alice.get(app, `/v1/attachments/${attHash}`)).statusCode, 200);

    // Members are forbidden from admin endpoints
    assert.equal((await alice.get(app, "/v1/users")).statusCode, 403);
    assert.equal((await alice.get(app, "/v1/jobs")).statusCode, 403);
    assert.equal((await alice.put(app, "/v1/settings/domains", { domains: ["hacked.com"] })).statusCode, 403);

    // 6. Per-user independent state: Alice reads, relabels, trashes, and deletes msg_shared; Bob & Owner stay unaffected!
    assert.equal((await alice.get(app, "/v1/unread")).json().inbox, 3);
    assert.equal((await bob.get(app, "/v1/unread")).json().inbox, 2);

    const readAllRes = await alice.post(app, "/v1/messages/read-all", { target: "inbox" });
    assert.equal(readAllRes.statusCode, 200);
    assert.equal(readAllRes.json().count, 3);
    assert.equal((await alice.get(app, "/v1/unread")).json().inbox, 0);
    assert.equal((await bob.get(app, "/v1/unread")).json().inbox, 2);

    assert.equal((await alice.patch(app, "/v1/messages/msg_shared/label", { label: "spam" })).statusCode, 200);
    assert.equal((await bob.get(app, "/v1/messages/msg_shared")).json().aiResult.label, "legit");

    assert.equal((await alice.post(app, "/v1/messages/msg_shared/trash", {})).statusCode, 200);
    assert.equal((await alice.delete(app, "/v1/messages/msg_shared")).statusCode, 200);
    assert.equal((await alice.get(app, "/v1/messages/msg_shared")).statusCode, 404);

    assert.equal((await bob.get(app, "/v1/messages/msg_shared")).statusCode, 200);
    assert.equal((await owner.get(app, "/v1/messages/msg_shared")).statusCode, 200);

    // 7. Outbound sender authorization & 24h quota enforcement
    const spoofAttempt = await alice.post(app, "/v1/outbox", {
      from: "vault@example.com",
      to: ["ext@example.net"],
      subject: "Spoof",
      text: "Nope",
    });
    assert.equal(spoofAttempt.statusCode, 403);
    assert.equal(spoofAttempt.json().reason, "sender_not_allowed");

    const send1 = await alice.post(app, "/v1/outbox", {
      from: "alice+work@example.com",
      to: ["ext@example.net"],
      subject: "Hello 1",
      text: "First",
    });
    assert.equal(send1.statusCode, 202);
    clock += 1000;

    const send2 = await alice.post(app, "/v1/outbox", {
      from: "ops-bot@example.com",
      to: ["ext@example.net"],
      subject: "Hello 2",
      text: "Second",
    });
    assert.equal(send2.statusCode, 202);
    clock += 1000;

    const send3 = await alice.post(app, "/v1/outbox", {
      from: "alice@example.com",
      to: ["ext@example.net"],
      subject: "Hello 3",
      text: "Over quota",
    });
    assert.equal(send3.statusCode, 429);
    assert.equal(send3.json().reason, "daily_quota_exceeded");

    const bobSend = await bob.post(app, "/v1/outbox", {
      from: "bob@team.org",
      to: ["ext@example.net"],
      subject: "Hi",
      text: "Blocked",
    });
    assert.equal(bobSend.statusCode, 403);
    assert.equal((await bob.get(app, "/v1/outbox")).json().items.length, 0);
    assert.equal((await bob.get(app, `/v1/outbox/${send1.json().id}`)).statusCode, 404);
    assert.equal((await alice.get(app, "/v1/outbox")).json().items.length, 2);

    // 8. Owner probes saved AI keys (passing & failing keys without leaking secrets)
    const savedAi = await owner.put(app, "/v1/settings/ai", {
      models: ["gemini-2.5-flash"],
      keys: [{ secret: "AIzaGoodKeyValue1234" }, { secret: "bad-key-secret-9999" }],
    });
    assert.equal(savedAi.statusCode, 200);
    const [goodKey, badKey] = savedAi.json().aiPool.keys as Array<{ id: string; tail: string }>;

    const probeOk = await owner.post(app, "/v1/settings/ai/test", { keyId: goodKey!.id });
    assert.equal(probeOk.statusCode, 200);
    assert.equal(probeOk.json().ok, true);
    assert.equal(probeOk.json().label, "legit");

    const probeBad = await owner.post(app, "/v1/settings/ai/test", { keyId: badKey!.id });
    assert.equal(probeBad.statusCode, 200);
    assert.equal(probeBad.json().ok, false);
    assert.equal(JSON.stringify(probeBad.json()).includes("bad-key-secret-9999"), false);

    // 9. Member self-service password reset via allocated exact mailbox (alice@example.com)
    clock += 5000;
    const anon = cookieJar();
    await anon.csrf(app);
    const forgotRes = await anon.post(app, "/v1/password/forgot", { email: "Alice@Example.com" });
    assert.equal(forgotRes.statusCode, 200);
    const latestOutbox = db.prepare("SELECT raw_path, sha256 FROM outbox ORDER BY created_at DESC LIMIT 1").get() as {
      raw_path: string;
      sha256: string;
    };
    const rawMail = (await readRaw(dir, latestOutbox.raw_path, gzipCodec(), latestOutbox.sha256)).toString("utf8");
    const split = rawMail.indexOf("\r\n\r\n");
    const bodyPart = rawMail.slice(split + 4);
    const decodedBody = /Content-Transfer-Encoding: base64/i.test(rawMail)
      ? Buffer.from(bodyPart.replace(/\s/g, ""), "base64").toString("utf8")
      : bodyPart;
    const codeMatch = decodedBody.match(/验证码 (\d{6})/);
    assert.ok(codeMatch?.[1]);

    const resetRes = await anon.post(app, "/v1/password/reset", {
      email: "alice@example.com",
      code: codeMatch[1],
      next: "alice-new-password-456",
    });
    assert.equal(resetRes.statusCode, 200);
    assert.equal((await alice.get(app, "/v1/me")).statusCode, 401);
    assert.equal((await bob.get(app, "/v1/me")).statusCode, 200);

    // 10. Disabling Bob immediately kills Bob's session
    const disableBob = await owner.patch(app, `/v1/users/${bobId}`, { disabled: true });
    assert.equal(disableBob.statusCode, 200);
    assert.equal((await bob.get(app, "/v1/me")).statusCode, 401);
    await bob.csrf(app);
    assert.equal((await bob.post(app, "/v1/login", { username: "bob@team.org", password: "bob-password-123" })).statusCode, 401);

    const auditRes = await owner.get(app, "/v1/audit?limit=20");
    assert.equal(auditRes.statusCode, 200);
    assert.equal(auditRes.json().items.length > 0, true);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function cookieJar() {
  let cookie = "";
  let token = "";
  return {
    async csrf(app: Awaited<ReturnType<typeof buildApi>>) {
      const response = await app.inject({ method: "GET", url: "/v1/csrf", headers: cookie ? { cookie } : {} });
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      token = response.json().token as string;
    },
    async get(app: Awaited<ReturnType<typeof buildApi>>, url: string): Promise<Injected> {
      const response = (await app.inject({ method: "GET", url, headers: { cookie } })) as Injected;
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      return response;
    },
    async post(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>): Promise<Injected> {
      const response = (await app.inject({
        method: "POST",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      })) as Injected;
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      return response;
    },
    async put(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>): Promise<Injected> {
      const response = (await app.inject({
        method: "PUT",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      })) as Injected;
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      return response;
    },
    async patch(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>): Promise<Injected> {
      const response = (await app.inject({
        method: "PATCH",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      })) as Injected;
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      return response;
    },
    async delete(app: Awaited<ReturnType<typeof buildApi>>, url: string): Promise<Injected> {
      const response = (await app.inject({
        method: "DELETE",
        url,
        headers: { cookie, "x-csrf-token": token },
      })) as Injected;
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      return response;
    },
  };
}

function mergeCookie(current: string, setCookie: string | string[] | undefined): string {
  const jar = new Map<string, string>();
  for (const part of current.split(";").filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of lines) {
    const pair = (line.split(";")[0] ?? "").trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}
