import { hostname } from "node:os";
import { ulid } from "ulid";
import type { Db } from "../db/index.js";
import { claimJob, completeJob, failJob, outboxIdOf, recoverRunning, releaseJob, requeueJob, type JobRow } from "../db/repos/jobs.js";
import { markOutboxDead, markOutboxRetry } from "../db/repos/outbox.js";
import { readAiEnabled } from "../db/repos/settings.js";
import { markMessageError } from "../db/repos/messages.js";
import type { Codec } from "../compress.js";
import type { Classifier } from "../ai/classifier.js";
import type { AppLog } from "../log.js";
import type { Authenticator } from "../mail/auth.js";
import type { Notifier } from "../notify/types.js";
import type { MailSender } from "../mail/deliver.js";
import { createMxSender, SMTP_SOCKET_TIMEOUT_MS } from "../mail/deliver.js";
import { runAuthJob } from "./job-auth.js";
import { runClassifyJob } from "./job-classify.js";
import { runNotifyJob } from "./job-notify.js";
import { runParseJob } from "./job-parse.js";
import { runSendJob } from "./job-send.js";

export interface WorkerOptions {
  db: Db;
  dataDir: string;
  codec: Codec;
  banner: string;
  log: AppLog;
  authenticate: Authenticator;
  classifier: Classifier;
  notifiers: readonly Notifier[];
  notifyLabels: readonly string[];
  notifyMinConfidence: number;
  promptsDir: string;
  panelBaseUrl: string;
  ehloName?: string;
  sendMail?: MailSender;
  pollMs?: number;
  now?: () => number;
  shutdownWaitMs?: number;
  workerId?: string;
}

export interface RunningWorker {
  workerId: string;
  close: () => Promise<void>;
  /** Resolves when the loop has stopped claiming work. */
  settled: Promise<void>;
}

const INBOUND_JOB_TYPES = ["auth", "parse", "classify", "notify"] as const;
const SEND_JOB_TYPES = ["send"] as const;

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const workerId = options.workerId ?? `${hostname()}-${process.pid}-${ulid()}`;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 1000;
  const shutdownWaitMs = options.shutdownWaitMs ?? SMTP_SOCKET_TIMEOUT_MS + 15_000;
  const recovered = recoverRunning(options.db, now());
  if (recovered > 0) options.log.warn({ recovered }, "requeued jobs left running");

  const inbound = startLane(options, {
    workerId: `${workerId}:in`,
    types: INBOUND_JOB_TYPES,
    pollMs,
    shutdownWaitMs,
    now,
  });
  const send = startLane(options, {
    workerId: `${workerId}:out`,
    types: SEND_JOB_TYPES,
    pollMs,
    shutdownWaitMs,
    now,
  });

  return {
    workerId,
    settled: Promise.all([inbound.settled, send.settled]).then(
      () => undefined,
      () => undefined,
    ),
    async close() {
      await Promise.all([inbound.close(), send.close()]);
    },
  };
}

/** One loop, one kind of ticket. Inbound and send run side by side. */
function startLane(
  options: WorkerOptions,
  lane: { workerId: string; types: readonly string[]; pollMs: number; shutdownWaitMs: number; now: () => number },
): RunningWorker {
  const { workerId, types, pollMs, shutdownWaitMs, now } = lane;
  let stopped = false;
  let current: Promise<void> | null = null;
  let currentJob: JobRow | null = null;
  let wakeSleep: (() => void) | null = null;

  const loop = (async () => {
    while (!stopped) {
      const job = claimJob(options.db, workerId, now(), types);
      if (!job) {
        await interruptibleSleep(pollMs, (wake) => {
          wakeSleep = wake;
        });
        wakeSleep = null;
        continue;
      }
      currentJob = job;
      current = runClaimed(options, job, now).finally(() => {
        current = null;
        currentJob = null;
      });
      await current;
    }
  })();

  return {
    workerId,
    settled: loop.then(
      () => undefined,
      () => undefined,
    ),
    async close() {
      stopped = true;
      wakeSleep?.();
      wakeSleep = null;
      const outcome = current
        ? await Promise.race([current.then(() => "done" as const), sleep(shutdownWaitMs).then(() => "timeout" as const)])
        : "done";
      if (outcome === "timeout" && currentJob) {
        const requeued = requeueJob(options.db, currentJob.id, workerId, now());
        if (requeued) options.log.warn({ jobId: currentJob.id, type: currentJob.type }, "requeued job on shutdown");
      }
    },
  };
}

/** Claim and run a single job. Returns false when the queue is empty. */
export async function processNext(options: WorkerOptions, workerId: string): Promise<boolean> {
  const now = options.now ?? Date.now;
  const job = claimJob(options.db, workerId, now(), SUPPORTED_JOB_TYPES);
  if (!job) return false;
  await runClaimed(options, job, now);
  return true;
}

async function runClaimed(options: WorkerOptions, job: JobRow, now: () => number): Promise<void> {
  if (job.type === "classify" && !readAiEnabled(options.db)) {
    releaseJob(options.db, job.id, now() + 60_000, now());
    return;
  }
  try {
    await dispatch(options, job, now);
    completeJob(options.db, job.id, now());
  } catch (err) {
    const message = err instanceof Error ? err.message : "job failed";
    options.log.error({ jobId: job.id, type: job.type, messageId: job.message_id, err: message }, "job failed");
    const outcome = failJob(options.db, job.id, message, now());
    if (job.type === "send") {
      const outboxId = outboxIdOf(job.payload);
      if (outboxId) {
        if (outcome === "dead") markOutboxDead(options.db, outboxId, message, now());
        else markOutboxRetry(options.db, outboxId, message, now());
      }
    } else if (outcome === "dead" && job.message_id) {
      markMessageError(options.db, job.message_id, message, now());
    }
  }
}

type JobHandler = (options: WorkerOptions, job: JobRow, now: () => number) => Promise<void>;

const JOB_HANDLERS: Record<string, JobHandler> = {
  auth: (options, job, now) =>
    runAuthJob(
      {
        db: options.db,
        dataDir: options.dataDir,
        codec: options.codec,
        banner: options.banner,
        authenticate: options.authenticate,
        log: options.log,
        now,
      },
      job,
    ),
  parse: (options, job, now) =>
    runParseJob(
      { db: options.db, dataDir: options.dataDir, codec: options.codec, log: options.log, now },
      job,
    ),
  classify: (options, job, now) =>
    runClassifyJob(
      { db: options.db, promptsDir: options.promptsDir, classifier: options.classifier, log: options.log, now },
      job,
    ),
  send: (options, job, now) =>
    runSendJob(
      {
        db: options.db,
        dataDir: options.dataDir,
        codec: options.codec,
        ehloName: options.ehloName ?? options.banner,
        sendMail: options.sendMail ?? createMxSender(),
        now,
      },
      job,
    ),
  notify: (options, job, now) =>
    runNotifyJob(
      {
        db: options.db,
        log: options.log,
        now,
        notifiers: options.notifiers,
        notifyLabels: options.notifyLabels,
        notifyMinConfidence: options.notifyMinConfidence,
        panelBaseUrl: options.panelBaseUrl,
      },
      job,
    ),
};

export const SUPPORTED_JOB_TYPES: readonly string[] = Object.keys(JOB_HANDLERS);

async function dispatch(options: WorkerOptions, job: JobRow, now: () => number): Promise<void> {
  const handler = JOB_HANDLERS[job.type];
  if (!handler) throw new Error(`unsupported job type ${job.type}`);
  await handler(options, job, now);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function interruptibleSleep(ms: number, bind: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    bind(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
