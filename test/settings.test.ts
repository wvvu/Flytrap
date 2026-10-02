import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { enqueueJob } from "../src/db/repos/jobs.js";
import { insertMessage } from "../src/db/repos/messages.js";
import {
  readRuntimeSettings,
  saveAcceptDomains,
  saveJobMaxAttempts,
  saveNameSettings,
  saveNotifySettings,
  SettingsError,
} from "../src/db/repos/settings.js";
import { migrationsDir } from "../src/paths.js";
import { runNotifyJob } from "../src/worker/job-notify.js";

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
};

const defaults = {
  notifyLabels: ["phish", "malware"],
  notifyMinConfidence: 0.6,
  acceptDomains: ["example.com"],
};

test("an empty settings table keeps the environment defaults", () => {
  const db = tempDb();
  try {
    const settings = readRuntimeSettings(db, defaults);
    assert.deepEqual(settings.notifyLabels, ["phish", "malware"]);
    assert.equal(settings.notifyMinConfidence, 0.6);
    assert.deepEqual(settings.acceptDomains, ["example.com"]);
    assert.equal(settings.jobMaxAttempts, 5);
    assert.equal(settings.panelTitle, "Flytrap");
    assert.equal(settings.labelNames.phish, "钓鱼");
    assert.deepEqual(settings.domainNames, {});
    assert.deepEqual(settings.senderNames, []);
  } finally {
    db.close();
  }
});

test("names can be renamed, and a bad name is refused", () => {
  const db = tempDb();
  try {
    const saved = saveNameSettings(
      db,
      {
        panelTitle: "  工资箱 ",
        labelNames: { phish: "诈骗", legit: "正常" },
        domainNames: { "Example.COM": "工资", "other.test": "" },
        senderNames: [
          { address: "Payroll@Example.com", name: "会计" },
          { address: "payroll@example.com", name: "财务" },
        ],
      },
      7,
    );
    assert.equal(saved.panelTitle, "工资箱");
    assert.equal(saved.labelNames.phish, "诈骗");
    assert.equal(saved.labelNames.legit, "正常");
    assert.deepEqual(saved.domainNames, { "example.com": "工资" });
    assert.deepEqual(saved.senderNames, [{ address: "payroll@example.com", name: "财务" }]);
    assert.throws(
      () => saveNameSettings(db, { panelTitle: "ok", labelNames: { nope: "x" }, domainNames: {}, senderNames: [] }, 8),
      SettingsError,
    );
    assert.throws(
      () => saveNameSettings(db, { panelTitle: "ok", labelNames: {}, domainNames: { "*": "x" }, senderNames: [] }, 8),
      SettingsError,
    );
    assert.throws(() => saveNameSettings(db, { panelTitle: " ", labelNames: {}, domainNames: {}, senderNames: [] }, 9), SettingsError);
  } finally {
    db.close();
  }
});

test("saved settings replace the defaults, and a bad value is refused", () => {
  const db = tempDb();
  try {
    assert.deepEqual(saveNotifySettings(db, ["gray", "gray"], 0, 1), ["gray"]);
    assert.throws(() => saveNotifySettings(db, ["nope"], 0.5, 2), SettingsError);
    assert.throws(() => saveNotifySettings(db, ["spam"], 2, 2), SettingsError);
    assert.deepEqual(saveAcceptDomains(db, ["Example.NET"], 3), ["example.net"]);
    assert.throws(() => saveAcceptDomains(db, ["*"], 4), ConfigError);
    assert.throws(() => saveJobMaxAttempts(db, 0, 5), SettingsError);
    assert.equal(saveJobMaxAttempts(db, 3, 6), 3);

    const settings = readRuntimeSettings(db, defaults);
    assert.deepEqual(settings.notifyLabels, ["gray"]);
    assert.equal(settings.notifyMinConfidence, 0);
    assert.deepEqual(settings.acceptDomains, ["example.net"]);
    assert.equal(settings.jobMaxAttempts, 3);
  } finally {
    db.close();
  }
});

test("new jobs take the saved attempt limit unless the caller sets one", () => {
  const db = tempDb();
  try {
    saveJobMaxAttempts(db, 2, 1);
    enqueueJob(db, { id: "job_saved", type: "auth", messageId: "msg_1", now: 10 });
    enqueueJob(db, { id: "job_explicit", type: "parse", messageId: "msg_1", now: 10, maxAttempts: 9 });
    const saved = db.prepare("SELECT max_attempts FROM jobs WHERE id = 'job_saved'").get() as { max_attempts: number };
    const explicit = db.prepare("SELECT max_attempts FROM jobs WHERE id = 'job_explicit'").get() as { max_attempts: number };
    assert.equal(saved.max_attempts, 2);
    assert.equal(explicit.max_attempts, 9);
  } finally {
    db.close();
  }
});

test("a saved notify policy is what the notify step uses", async () => {
  const db = tempDb();
  try {
    insertMessage(db, {
      id: "msg_1",
      sha256: "cd".repeat(32),
      rawPath: "raw/a",
      sizeBytes: 1,
      receivedAt: 1,
      envelopeFrom: "a@example.com",
      envelopeTo: ["me@example.com"],
      domains: ["example.com"],
      smtpMeta: {},
      now: 1,
    });
    db.prepare("UPDATE messages SET subject = ?, from_addr = ?, ai_result = ? WHERE id = ?").run(
      "工资条",
      "payroll@example.com",
      JSON.stringify({
        schema: 1,
        prompt_id: "classify-v1",
        model: "fake",
        provider: "fake",
        at: "2026-09-21T00:00:00.000Z",
        label: "phish",
        confidence: 0.9,
        summary: "looks like a phish",
        tags: [],
        signals: [],
      }),
      "msg_1",
    );
    const calls: string[] = [];
    const notifier = {
      id: "fake",
      async notify(input: { label: string }) {
        calls.push(input.label);
      },
    };
    const job = {
      id: "job_n",
      type: "notify" as const,
      message_id: "msg_1",
      payload: null,
      status: "running" as const,
      attempts: 1,
      max_attempts: 5,
      run_after: 1,
      locked_at: 1,
      locked_by: "t",
      last_error: null,
      created_at: 1,
      updated_at: 1,
    };
    await runNotifyJob(
      {
        db,
        log: silent,
        now: () => 2,
        notifiers: [notifier],
        notifyLabels: ["phish", "malware"],
        notifyMinConfidence: 0.6,
        panelBaseUrl: "http://127.0.0.1:8080",
      },
      job,
    );
    assert.deepEqual(calls, ["phish"]);

    saveNotifySettings(db, ["spam"], 0.6, 3);
    await runNotifyJob(
      {
        db,
        log: silent,
        now: () => 4,
        notifiers: [notifier],
        notifyLabels: ["phish", "malware"],
        notifyMinConfidence: 0.6,
        panelBaseUrl: "http://127.0.0.1:8080",
      },
      job,
    );
    assert.deepEqual(calls, ["phish"]);
  } finally {
    db.close();
  }
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-settings-"));
  const db = openDatabase(path.join(dir, "mail.db"));
  migrate(db, migrationsDir());
  return db;
}
