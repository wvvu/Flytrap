import type { Db } from "../db/index.js";
import type { JobRow } from "../db/repos/jobs.js";
import { readPersonalNotifySettings, readRuntimeSettings } from "../db/repos/settings.js";
import { getMessage, markMessageNotified } from "../db/repos/messages.js";
import { getUserById, OWNER_USER_ID, sqlResolvedOwner } from "../db/repos/users.js";
import type { AppLog } from "../log.js";
import { aiResultSchema } from "../ai/types.js";
import { extractFallbackOtp } from "../mail/otp.js";
import { parsedSchema } from "../mail/parse.js";
import { createBarkNotifier, isBarkUrl } from "../notify/bark.js";
import type { Notifier, NotifyInput } from "../notify/types.js";
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
  const fallbackMode = !message.ai_result && isFallbackNotify(job.payload);
  if (!message.ai_result && !fallbackMode) throw new Error("message has no ai result");

  const ai = message.ai_result ? aiResultSchema.parse(JSON.parse(message.ai_result)) : null;
  const policy = readRuntimeSettings(deps.db, {
    notifyLabels: deps.notifyLabels,
    notifyMinConfidence: deps.notifyMinConfidence,
    acceptDomains: [],
  });
  const panelUrl = `${deps.panelBaseUrl.replace(/\/$/, "")}/#/m/${message.id}`;
  const input: NotifyInput = ai
    ? {
        messageId: message.id,
        subject: message.subject,
        from: message.from_addr,
        label: ai.label,
        confidence: ai.confidence,
        summary: ai.summary,
        otp: ai.otp ?? null,
        panelUrl,
      }
    : {
        messageId: message.id,
        subject: message.subject,
        from: message.from_addr,
        label: "unclassified",
        confidence: 0,
        summary: "AI 分拣暂时失败，已保留原信，请在面板查看正文或重试。",
        otp: fallbackOtpOf(message.subject, message.parsed),
        fallback: true,
        panelUrl,
      };

  const done = notifiedIds(job.payload);
  let sentAny = false;

  const wantedGlobal = ai
    ? policy.notifyLabels.includes(ai.label) && ai.confidence >= policy.notifyMinConfidence
    : policy.notifyLabels.length > 0;
  if (wantedGlobal && deps.notifiers.length > 0) {
    for (const notifier of deps.notifiers) {
      if (done.includes(notifier.id)) continue;
      await notifier.notify(input);
      done.push(notifier.id);
      rememberNotified(deps.db, job.id, done, deps.now());
      deps.log.info({ messageId: message.id, notifier: notifier.id, label: input.label }, "notified");
      sentAny = true;
    }
  }

  for (const holderId of listNotifyHolderIds(deps.db, message.id)) {
    if (holderId !== OWNER_USER_ID) {
      const user = getUserById(deps.db, holderId);
      if (!user || user.status !== "active") continue;
      const overlay = deps.db
        .prepare("SELECT trashed_at, deleted_at FROM user_message_state WHERE user_id = ? AND message_id = ?")
        .get(holderId, message.id) as { trashed_at: number | null; deleted_at: number | null } | undefined;
      if (overlay && (overlay.trashed_at != null || overlay.deleted_at != null)) continue;
    }
    const personal = readPersonalNotifySettings(deps.db, holderId);
    if (!personal.notifyWebhookUrl) continue;
    const wantedPersonal = ai
      ? personal.notifyLabels.includes(ai.label) && ai.confidence >= personal.notifyMinConfidence
      : personal.notifyLabels.length > 0;
    if (!wantedPersonal) continue;
    const channelId = `user:${holderId}:webhook`;
    if (done.includes(channelId)) continue;
    const useBark =
      personal.notifyWebhookFormat === "bark" ||
      (personal.notifyWebhookFormat === "auto" && isBarkUrl(personal.notifyWebhookUrl));
    const notifier = useBark
      ? createBarkNotifier({
          url: personal.notifyWebhookUrl,
          bearer: personal.notifyWebhookBearer || undefined,
        })
      : createWebhookNotifier({
          url: personal.notifyWebhookUrl,
          bearer: personal.notifyWebhookBearer || undefined,
        });
    await notifier.notify(input);
    done.push(channelId);
    rememberNotified(deps.db, job.id, done, deps.now());
    deps.log.info({ messageId: message.id, userId: holderId, label: input.label }, "user webhook notified");
    sentAny = true;
  }

  if (!sentAny) {
    deps.log.info({ messageId: message.id, label: input.label, confidence: input.confidence }, "notify skipped");
  }
  if (!fallbackMode) {
    markMessageNotified(deps.db, message.id, deps.now());
  }
}

function isFallbackNotify(payload: string | null): boolean {
  if (!payload) return false;
  try {
    const parsed = JSON.parse(payload) as { fallback?: unknown };
    return parsed.fallback === true;
  } catch {
    return false;
  }
}

function fallbackOtpOf(subject: string | null, rawParsed: string | null): string | null {
  if (!rawParsed) return extractFallbackOtp(subject, null);
  try {
    const parsed = parsedSchema.safeParse(JSON.parse(rawParsed));
    return extractFallbackOtp(subject, parsed.success ? parsed.data.text : null);
  } catch {
    return extractFallbackOtp(subject, null);
  }
}

/** Holders are the read-time winners of envelope_to. Unallocated recipients belong to the owner. */
function listNotifyHolderIds(db: Db, messageId: string): string[] {
  const resolved = sqlResolvedOwner("je.value");
  const rows = db
    .prepare(
      `SELECT DISTINCT COALESCE(${resolved}, ?) AS user_id
       FROM messages m
       JOIN json_each(m.envelope_to) je
       WHERE m.id = ?
       UNION
       SELECT ?
       FROM messages m
       WHERE m.id = ? AND json_array_length(m.envelope_to) = 0`,
    )
    .all(OWNER_USER_ID, messageId, OWNER_USER_ID, messageId) as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
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
