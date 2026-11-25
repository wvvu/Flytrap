import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildUserMessage } from "../src/ai/prompt.js";
import { finalizeAiResult } from "../src/ai/types.js";
import { buildApi } from "../src/api/app.js";
import { gzipCodec } from "../src/compress.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { rebuildFromRaw } from "../src/ingest/rebuild.js";
import { readRaw } from "../src/ingest/read-raw.js";
import type { AppLog } from "../src/log.js";
import { defaultPromptsDir, migrationsDir } from "../src/paths.js";
import { barkPayload } from "../src/notify/bark.js";
import { processNext, type WorkerOptions } from "../src/worker/loop.js";

const adminPassword = "admin-strong-password";
const secret = "0123456789abcdef0123456789abcdef";
const smsToken = "sms-ingest-token-0123456789abcdef";

const silent: AppLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
};

test("sms ingest verifies bearer auth, bypasses CSRF, deduplicates idempotently, and skips auth stage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-sms-ingest-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const clock = Date.UTC(2026, 10, 25, 5, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
      SMS_INGEST_TOKEN: smsToken,
      BARK_URL: "https://api.day.app/global-bark-key",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  try {
    // Missing / wrong token rejected even without CSRF token or cookie
    const noAuth = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      payload: {
        device: "redmi-note11",
        smsId: 1,
        from: "10086",
        text: "test",
        receivedAt: clock,
      },
    });
    assert.equal(noAuth.statusCode, 401);

    const badAuth = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      headers: { authorization: "Bearer wrong-token" },
      payload: {
        device: "redmi-note11",
        smsId: 1,
        from: "10086",
        text: "test",
        receivedAt: clock,
      },
    });
    assert.equal(badAuth.statusCode, 401);

    // Config endpoint returns dynamic Bark target & smsDomain
    const cfgDenied = await app.inject({ method: "GET", url: "/v1/ingest/sms/config" });
    assert.equal(cfgDenied.statusCode, 401);

    const cfgRes = await app.inject({
      method: "GET",
      url: "/v1/ingest/sms/config?device=redmi-note11&slot=sim1",
      headers: { authorization: `Bearer ${smsToken}` },
    });
    assert.equal(cfgRes.statusCode, 200);
    assert.deepEqual(cfgRes.json(), {
      ok: true,
      smsDomain: "sms.local",
      bark: { url: "https://api.day.app/global-bark-key" },
    });

    // Valid ingestion works without Cookie / CSRF and accepts Unix seconds
    const receivedSec = Math.floor(clock / 1000);
    const first = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      headers: { authorization: `Bearer ${smsToken}` },
      payload: {
        device: "Redmi-Note11",
        smsId: 42,
        from: "106933818222266",
        slot: "sim1",
        text: "【测试银行】您的验证码是 482910，5分钟内有效。",
        receivedAt: receivedSec,
      },
    });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(typeof firstBody.id, "string");
    assert.equal(firstBody.duplicate, undefined);
    assert.deepEqual(firstBody.bark, { url: "https://api.day.app/global-bark-key" });

    // Only a parse job is queued; auth is skipped
    const jobs = db.prepare("SELECT type, message_id FROM jobs WHERE message_id = ?").all(firstBody.id) as Array<{
      type: string;
      message_id: string;
    }>;
    assert.deepEqual(jobs, [{ type: "parse", message_id: firstBody.id }]);

    const row = db
      .prepare("SELECT sha256, raw_path, received_at, envelope_to, domains, message_id, auth_result FROM messages WHERE id = ?")
      .get(firstBody.id) as {
      sha256: string;
      raw_path: string;
      received_at: number;
      envelope_to: string;
      domains: string;
      message_id: string;
      auth_result: string | null;
    };
    assert.equal(row.received_at, receivedSec * 1000);
    assert.deepEqual(JSON.parse(row.envelope_to), ["redmi-note11-sim1@sms.local"]);
    assert.deepEqual(JSON.parse(row.domains), ["sms.local"]);
    assert.match(row.message_id, /^sms-redmi-note11-42-[0-9a-f]{10}@sms\.local$/);
    assert.equal(row.auth_result, null);

    // Stored raw EML has expected headers and survives decompression check
    const rawText = (await readRaw(dir, row.raw_path, gzipCodec(), row.sha256)).toString("utf8");
    assert.match(rawText, /^X-Flytrap-Channel: sms$/m);
    assert.match(rawText, /^X-Flytrap-Device: Redmi-Note11$/m);
    assert.match(rawText, /^X-Flytrap-Sms-Id: 42$/m);
    assert.match(rawText, /^X-Flytrap-Slot: sim1$/m);
    assert.match(rawText, /^Message-ID: <sms-redmi-note11-42-[0-9a-f]{10}@sms\.local>$/m);

    // Idempotent retry with ISO timestamp / identical smsId returns duplicate: true and adds no DB rows or jobs
    const dupIso = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      headers: { authorization: `Bearer ${smsToken}` },
      payload: {
        device: "Redmi-Note11",
        smsId: "42",
        from: "106933818222266",
        slot: "sim1",
        text: "【测试银行】您的验证码是 482910，5分钟内有效。",
        receivedAt: new Date(receivedSec * 1000).toISOString(),
      },
    });
    assert.equal(dupIso.statusCode, 200);
    assert.equal(dupIso.json().ok, true);
    assert.equal(dupIso.json().id, firstBody.id);
    assert.equal(dupIso.json().duplicate, true);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 1);

    // Run worker pipeline: parse -> classify -> notify (no auth invoked)
    let seenUserMessage = "";
    const pushed: Array<{ otp?: string | null; label: string; from: string | null }> = [];
    const workerOpts: WorkerOptions = {
      db,
      dataDir: dir,
      codec: gzipCodec(),
      banner: "mx.test",
      log: silent,
      authenticate: async () => {
        throw new Error("auth must not run for sms");
      },
      classifier: {
        id: "stub",
        model: "stub",
        async classify(input) {
          seenUserMessage = input.userMessage;
          return finalizeAiResult({
            schema: 1,
            prompt_id: input.promptId,
            model: "stub",
            provider: "stub",
            at: new Date(clock).toISOString(),
            label: "legit",
            confidence: 0.99,
            summary: "测试银行登录验证码 482910。",
            tags: ["otp", "sms"],
            signals: [{ name: "channel", value: "sms" }],
            otp: "482910",
          });
        },
      },
      notifiers: [
        {
          id: "bark-stub",
          async notify(input) {
            pushed.push({ otp: input.otp, label: input.label, from: input.from });
          },
        },
      ],
      notifyLabels: ["legit"],
      notifyMinConfidence: 0.6,
      promptsDir: defaultPromptsDir(),
      panelBaseUrl: "https://mail.example",
      now: () => clock,
    };

    while (await processNext(workerOpts, "w-sms")) {
      // drain parse -> classify -> notify
    }

    assert.match(seenUserMessage, /CHANNEL: sms/);
    assert.match(seenUserMessage, /SMS_META: device=Redmi-Note11 slot=sim1/);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]?.label, "legit");
    assert.equal(pushed[0]?.otp, "482910");
    assert.equal(pushed[0]?.from, "106933818222266@sender.sms.local");

    const finalMsg = db.prepare("SELECT status, auth_result FROM messages WHERE id = ?").get(firstBody.id) as {
      status: string;
      auth_result: string | null;
    };
    assert.equal(finalMsg.status, "notified");
    assert.equal(finalMsg.auth_result, null);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sms ingest integrates with domain filter, multi-user isolation, personal Bark config, and rebuild", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-sms-mu-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const clock = Date.UTC(2026, 10, 25, 6, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
      SMS_INGEST_TOKEN: smsToken,
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  const admin = jar();
  const alice = jar();

  try {
    await admin.login(app, "admin", adminPassword);

    // Admin session exposes smsDomain for top filter even though ACCEPT_DOMAINS only has example.com
    const adminSess = (await admin.get(app, "/v1/session")).json();
    assert.deepEqual(adminSess.acceptDomains, ["example.com"]);
    assert.equal(adminSess.smsDomain, "sms.local");

    // Admin can allocate redmi-sim2@sms.local to Alice and Alice can configure personal Bark
    const createdAlice = await admin.post(app, "/v1/users", {
      username: "alice",
      password: "alice-password-123",
      initialMailbox: { localpart: "redmi-sim2", domain: "sms.local", canSend: false },
    });
    assert.equal(createdAlice.statusCode, 201);
    await alice.login(app, "alice", "alice-password-123");

    const setPersonalBark = await alice.put(app, "/v1/settings/notify/personal", {
      labels: ["legit"],
      minConfidence: 0.6,
      webhookUrl: "https://api.day.app/alice-personal-bark",
      webhookBearer: "alice-bark-bearer",
      webhookFormat: "bark",
    });
    assert.equal(setPersonalBark.statusCode, 200);

    // Ingest SIM1 (unallocated -> owner) and SIM2 (allocated -> Alice)
    const sim1Res = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      headers: { authorization: `Bearer ${smsToken}` },
      payload: {
        device: "redmi",
        smsId: 101,
        from: "10001",
        slot: "sim1",
        text: "SIM1 msg",
        receivedAt: clock,
      },
    });
    assert.equal(sim1Res.statusCode, 200);
    const sim1Id = sim1Res.json().id as string;

    const sim2Res = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      headers: { authorization: `Bearer ${smsToken}` },
      payload: {
        device: "redmi",
        smsId: 102,
        from: "10001",
        slot: "sim2",
        text: "SIM2 msg",
        receivedAt: clock + 1000,
      },
    });
    assert.equal(sim2Res.statusCode, 200);
    const sim2Id = sim2Res.json().id as string;
    // Response delivers Alice's personal Bark target dynamically
    assert.deepEqual(sim2Res.json().bark, {
      url: "https://api.day.app/alice-personal-bark",
      bearer: "alice-bark-bearer",
    });

    // Domain filters: all domains, sms.local, and example.com
    const adminAllDomains = (await admin.get(app, "/v1/messages")).json().items as Array<{ id: string }>;
    assert.deepEqual(adminAllDomains.map((m) => m.id), [sim1Id]);

    const adminSmsOnly = (await admin.get(app, "/v1/messages?domain=sms.local")).json().items as Array<{ id: string }>;
    assert.deepEqual(adminSmsOnly.map((m) => m.id), [sim1Id]);

    const adminRealOnly = (await admin.get(app, "/v1/messages?domain=example.com")).json().items as Array<{ id: string }>;
    assert.deepEqual(adminRealOnly, []);

    const aliceList = (await alice.get(app, "/v1/messages?domain=sms.local")).json().items as Array<{ id: string }>;
    assert.deepEqual(aliceList.map((m) => m.id), [sim2Id]);
    assert.equal((await alice.get(app, `/v1/messages/${sim1Id}`)).statusCode, 404);

    const aliceSess = (await alice.get(app, "/v1/session")).json();
    assert.equal(aliceSess.smsDomain, "sms.local");

    // Rebuild from raw preserves SMS channel (queues parse, not auth, and restores domain)
    db.prepare("DELETE FROM jobs").run();
    db.prepare("DELETE FROM deliveries").run();
    db.prepare("DELETE FROM messages").run();
    const report = await rebuildFromRaw({ db, dataDir: dir, codec: gzipCodec(), now: clock + 5000 });
    assert.equal(report.inserted, 2);
    const rebuiltJobs = db.prepare("SELECT type FROM jobs").all() as Array<{ type: string }>;
    assert.deepEqual(rebuiltJobs.map((j) => j.type), ["parse", "parse"]);
    const rebuiltDomains = db.prepare("SELECT domains FROM messages ORDER BY received_at ASC").all() as Array<{ domains: string }>;
    assert.deepEqual(JSON.parse(rebuiltDomains[0]!.domains), ["sms.local"]);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildUserMessage keeps email telemetry unchanged and adds sms channel note when channel=sms", () => {
  const emailMsg = buildUserMessage({
    spf: "none",
    dkim: "none",
    dmarc: "none",
    rdns: "no-match",
    envelopeFrom: "a@example.com",
    envelopeTo: ["b@example.com"],
    from: "a@example.com",
    subject: "hi",
    messageId: "<1@example.com>",
    text: "body",
    urls: [],
    history: [],
    missingHistory: [],
    attachments: [],
  });
  assert.equal(emailMsg.includes("CHANNEL:"), false);

  const smsMsg = buildUserMessage({
    channel: "sms",
    smsDevice: "redmi",
    smsSlot: "sim1",
    spf: "none",
    dkim: "none",
    dmarc: "none",
    rdns: "no-match",
    envelopeFrom: "10086@sender.sms.local",
    envelopeTo: ["redmi-sim1@sms.local"],
    from: "10086 <10086@sender.sms.local>",
    subject: "[短信·sim1] 余额提醒",
    messageId: "<sms-redmi-1@sms.local>",
    text: "余额提醒",
    urls: [],
    history: [],
    missingHistory: [],
    attachments: [],
  });
  assert.match(smsMsg, /CHANNEL: sms/);
  assert.match(smsMsg, /SMS_META: device=redmi slot=sim1/);
  assert.equal(/\bunknown\b/i.test(smsMsg), false);
});

test("sms ingest returns 503 when SMS_INGEST_TOKEN is not configured", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-sms-off-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      headers: { authorization: `Bearer ${smsToken}` },
      payload: {
        device: "redmi",
        smsId: 1,
        from: "10086",
        text: "hello",
        receivedAt: Date.now(),
      },
    });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: "sms_ingest_disabled" });
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sms ingest preserves reused smsId after device reset while deduplicating identical retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-sms-reset-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const clock = Date.UTC(2026, 10, 25, 7, 0, 0);

  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
      SMS_INGEST_TOKEN: smsToken,
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => clock,
  });

  try {
    const first = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      headers: { authorization: `Bearer ${smsToken}` },
      payload: {
        device: "pixel",
        smsId: 1,
        from: "10086",
        text: "First boot message",
        receivedAt: clock,
      },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().duplicate, undefined);

    const retry = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      headers: { authorization: `Bearer ${smsToken}` },
      payload: {
        device: "pixel",
        smsId: 1,
        from: "10086",
        text: "First boot message",
        receivedAt: clock,
      },
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().duplicate, true);
    assert.equal(retry.json().id, first.json().id);

    const afterReset = await app.inject({
      method: "POST",
      url: "/v1/ingest/sms",
      headers: { authorization: `Bearer ${smsToken}` },
      payload: {
        device: "pixel",
        smsId: 1,
        from: "10010",
        text: "Post-reset message",
        receivedAt: clock + 60_000,
      },
    });
    assert.equal(afterReset.statusCode, 200);
    assert.equal(afterReset.json().duplicate, undefined);
    assert.notEqual(afterReset.json().id, first.json().id);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 2);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sms ingest rejects invalid payloads with 400", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-sms-400-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_PASSWORD: adminPassword,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
      SMS_INGEST_TOKEN: smsToken,
    }),
    db,
    codec: gzipCodec(),
    log: false,
  });

  const base = {
    device: "redmi",
    smsId: 5,
    from: "10086",
    text: "hello",
    receivedAt: Date.UTC(2026, 10, 25, 8, 0, 0),
  };

  try {
    for (const payload of [
      { ...base, receivedAt: 0 },
      { ...base, receivedAt: -500 },
      { ...base, receivedAt: "not-a-date" },
      { ...base, device: "   " },
      { ...base, from: "" },
      { ...base, unknownField: true },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/ingest/sms",
        headers: { authorization: `Bearer ${smsToken}` },
        payload,
      });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("barkPayload formats SMS OTP title, copy field, and sender subtitle", () => {
  const payload = barkPayload(
    {
      messageId: "msg_sms_1",
      subject: "[短信·sim1] 【测试银行】您的验证码是 482910，5分钟内有效。",
      from: "106933818222266@sender.sms.local",
      label: "legit",
      confidence: 0.99,
      summary: "测试银行登录验证码 482910。",
      otp: "482910",
      panelUrl: "https://mail.example/#/m/msg_sms_1",
    },
    { defaultGroup: "Flytrap" },
  );

  assert.equal(payload.title, "[验证码 482910] [短信·sim1] 【测试银行】您的验证码是 482910，5分钟内有效。");
  assert.equal(payload.subtitle, "106933818222266@sender.sms.local");
  assert.equal(payload.body, "测试银行登录验证码 482910。");
  assert.equal(payload.copy, "482910");
  assert.equal(payload.group, "Flytrap");
  assert.equal(payload.url, "https://mail.example/#/m/msg_sms_1");
  assert.equal(payload.level, undefined);
});

function jar() {
  let cookie = "";
  let csrf = "";
  return {
    async login(app: Awaited<ReturnType<typeof buildApi>>, username: string, password: string) {
      const cRes = await app.inject({ method: "GET", url: "/v1/csrf", headers: cookie ? { cookie } : {} });
      cookie = mergeCookie(cookie, cRes.headers["set-cookie"]);
      csrf = cRes.json().token as string;
      const res = await app.inject({
        method: "POST",
        url: "/v1/login",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        payload: { username, password },
      });
      assert.equal(res.statusCode, 200);
      cookie = mergeCookie(cookie, res.headers["set-cookie"]);
      const nextCsrf = await app.inject({ method: "GET", url: "/v1/csrf", headers: { cookie } });
      cookie = mergeCookie(cookie, nextCsrf.headers["set-cookie"]);
      csrf = nextCsrf.json().token as string;
    },
    async get(app: Awaited<ReturnType<typeof buildApi>>, url: string) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      cookie = mergeCookie(cookie, res.headers["set-cookie"]);
      return res;
    },
    async post(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        payload,
      });
      cookie = mergeCookie(cookie, res.headers["set-cookie"]);
      return res;
    },
    async put(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: Record<string, unknown>) {
      const res = await app.inject({
        method: "PUT",
        url,
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        payload,
      });
      cookie = mergeCookie(cookie, res.headers["set-cookie"]);
      return res;
    },
  };
}

function mergeCookie(current: string, setCookie: string | string[] | undefined): string {
  const map = new Map<string, string>();
  for (const part of current.split(";").filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of lines) {
    const pair = (line.split(";")[0] ?? "").trim();
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}
