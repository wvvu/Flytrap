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
import { getOutbox } from "../src/db/repos/outbox.js";
import { rebuildFromRaw } from "../src/ingest/rebuild.js";
import { readRaw } from "../src/ingest/read-raw.js";
import { authenticateMessage } from "../src/mail/auth.js";
import { deliverToMx, type MailSender } from "../src/mail/deliver.js";
import { submitOutbox } from "../src/mail/submit.js";
import { migrationsDir } from "../src/paths.js";
import { fakeClassifier } from "../src/ai/classifier.js";
import type { AppLog } from "../src/log.js";
import { processNext, type WorkerOptions } from "../src/worker/loop.js";

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
