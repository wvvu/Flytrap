import type { Db } from "../db/index.js";
import type { JobRow } from "../db/repos/jobs.js";
import { readRuntimeSettings } from "../db/repos/settings.js";
import { getMessage, markMessageNotified } from "../db/repos/messages.js";
import { findUserById, readUserPersonalSettings } from "../db/repos/users.js";
import type { AppLog } from "../log.js";
import { aiResultSchema } from "../ai/types.js";
import type { Notifier } from "../notify/types.js";
import { createWebhookNotifier } from "../notify/webhook.js";

export interface NotifyJobDeps {
  db: Db;
  log: AppLog;
  now: () => number;
  notifiers: readonly Notifier[];
  notifyLabels: readonly string[];
  notifyMinConfidence: number;
  panelBaseUrl: string;
}

export async function runNotifyJob(deps: NotifyJobDeps, job: JobRow): Promise<void> {
  if (!job.message_id) throw new Error("notify job has no message");
  const message = getMessage(deps.db, job.message_id);
  if (!message) throw new Error("message missing");
  if (message.trashed_at) return;
  if (!message.ai_result) throw new Error("message has no ai result");
  const ai = aiResultSchema.parse(JSON.parse(message.ai_result));
  const policy = readRuntimeSettings(deps.db, {
    notifyLabels: deps.notifyLabels,
    notifyMinConfidence: deps.notifyMinConfidence,
    acceptDomains: [],
  });

  const input = {
    messageId: message.id,
    subject: message.subject,
    from: message.from_addr,
    label: ai.label,
    confidence: ai.confidence,
    summary: ai.summary,
    panelUrl: `${deps.panelBaseUrl.replace(/\/$/, "")}/#/m/${message.id}`,
  };

  const done = notifiedIds(job.payload);
  let sentAny = false;

  const wantedGlobal = policy.notifyLabels.includes(ai.label) && ai.confidence >= policy.notifyMinConfidence;
  if (wantedGlobal && deps.notifiers.length > 0) {
    for (const notifier of deps.notifiers) {
      if (done.includes(notifier.id)) continue;
      await notifier.notify(input);
      done.push(notifier.id);
      rememberNotified(deps.db, job.id, done, deps.now());
      deps.log.info({ messageId: message.id, notifier: notifier.id, label: ai.label }, "notified");
      sentAny = true;
    }
  }

  const activeHolders = deps.db
    .prepare("SELECT user_id FROM user_messages WHERE message_id = ? AND trashed_at IS NULL")
    .all(message.id) as Array<{ user_id: string }>;

  for (const holder of activeHolders) {
    const user = findUserById(deps.db, holder.user_id);
    if (!user || user.disabled_at !== null) continue;
    const personal = readUserPersonalSettings(user);
    if (!personal.notifyWebhookUrl) continue;
    if (!personal.notifyLabels.includes(ai.label) || ai.confidence < personal.notifyMinConfidence) continue;
    const channelId = `user:${user.id}:webhook`;
    if (done.includes(channelId)) continue;
    const notifier = createWebhookNotifier({
      url: personal.notifyWebhookUrl,
      bearer: personal.notifyWebhookBearer || undefined,
    });
    await notifier.notify(input);
    done.push(channelId);
    rememberNotified(deps.db, job.id, done, deps.now());
    deps.log.info({ messageId: message.id, userId: user.id, label: ai.label }, "user webhook notified");
    sentAny = true;
  }

  if (!sentAny) {
    deps.log.info({ messageId: message.id, label: ai.label, confidence: ai.confidence }, "notify skipped");
  }
  markMessageNotified(deps.db, message.id, deps.now());
}

function notifiedIds(payload: string | null): string[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as { notified?: unknown };
    if (!Array.isArray(parsed.notified)) return [];
    return parsed.notified.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

function rememberNotified(db: Db, jobId: string, ids: readonly string[], now: number): void {
  const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as { payload: string | null } | undefined;
  let parsed: Record<string, unknown> = {};
  if (row?.payload) {
    try {
      const value = JSON.parse(row.payload) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  parsed.notified = [...ids];
  db.prepare("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(parsed), now, jobId);
}
