import { ulid } from "ulid";
import type { Db } from "../db/index.js";
import { enqueueJob, hasOpenJob, type JobRow } from "../db/repos/jobs.js";
import { getMessage, saveParsedMessage, trashMessage } from "../db/repos/messages.js";
import { isBlockedSender } from "../db/repos/settings.js";
import { findUserById, listMessageOwnerIds, readUserPersonalSettings, routeMessageRecipients } from "../db/repos/users.js";
import type { Codec } from "../compress.js";
import { readRaw } from "../ingest/read-raw.js";
import type { AppLog } from "../log.js";
import { normalizeAddress } from "../mail/address.js";
import { parseMessage } from "../mail/parse.js";
import { threadKeyOf } from "../mail/thread.js";

export interface ParseJobDeps {
  db: Db;
  dataDir: string;
  codec: Codec;
  log: AppLog;
  now: () => number;
}

/** Parse always runs, including when authentication failed. Classification is queued after it. */
export async function runParseJob(deps: ParseJobDeps, job: JobRow): Promise<void> {
  if (!job.message_id) throw new Error("parse job has no message");
  const message = getMessage(deps.db, job.message_id);
  if (!message) throw new Error("message missing");
  const raw = await readRaw(deps.dataDir, message.raw_path, deps.codec, message.sha256);
  const result = await parseMessage(raw, {
    db: deps.db,
    dataDir: deps.dataDir,
    messageId: message.id,
    now: deps.now(),
  });
  const fromAddr = result.parsed.from?.address ?? null;
  saveParsedMessage(deps.db, {
    id: message.id,
    subject: result.parsed.subject || null,
    fromAddr,
    toAddrs: result.toAddrs,
    messageId: result.messageId,
    inReplyTo: result.inReplyTo,
    refIds: result.refs.length > 0 ? JSON.stringify(result.refs) : null,
    threadKey: threadKeyOf(result.messageId, result.inReplyTo, result.refs),
    parsed: JSON.stringify(result.parsed),
    now: deps.now(),
  });

  // If raw rebuild lacked envelope_to, route using parsed header recipients so members still receive rebuilt mail.
  const envelopeList = parseEnvelopeArray(message.envelope_to);
  if (envelopeList.length === 0 && result.toAddrs.length > 0) {
    routeMessageRecipients(deps.db, message.id, result.toAddrs, message.received_at);
  }

  if (isBlockedSender(deps.db, fromAddr) || isBlockedSender(deps.db, message.envelope_from)) {
    trashMessage(deps.db, message.id, deps.now());
    deps.log.info({ messageId: message.id }, "blocked sender moved to trash");
    return;
  }

  const normalizedFrom = fromAddr ? normalizeAddress(fromAddr) : null;
  const normalizedEnvFrom = message.envelope_from ? normalizeAddress(message.envelope_from) : null;
  if (normalizedFrom || normalizedEnvFrom) {
    const ownerIds = listMessageOwnerIds(deps.db, message.id);
    if (ownerIds.length > 0) {
      let blockedCount = 0;
      for (const ownerId of ownerIds) {
        const user = findUserById(deps.db, ownerId);
        if (!user) continue;
        const personal = readUserPersonalSettings(user);
        const hit =
          (normalizedFrom && personal.blockedSenders.includes(normalizedFrom)) ||
          (normalizedEnvFrom && personal.blockedSenders.includes(normalizedEnvFrom));
        if (hit) {
          trashMessage(deps.db, message.id, deps.now(), ownerId);
          blockedCount += 1;
        }
      }
      if (blockedCount === ownerIds.length) {
        deps.log.info({ messageId: message.id }, "blocked by all recipient owners, skipping classify");
        return;
      }
    }
  }

  const now = deps.now();
  if (!hasOpenJob(deps.db, message.id, "classify")) {
    enqueueJob(deps.db, { id: ulid(), type: "classify", messageId: message.id, now });
  }
  deps.log.info(
    { messageId: message.id, attachments: result.parsed.attachmentCount, urls: result.parsed.urls.length },
    "parse done",
  );
}

function parseEnvelopeArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}
