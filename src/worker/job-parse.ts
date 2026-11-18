import { ulid } from "ulid";
import { envelopeAddresses } from "../ai/prompt.js";
import type { Codec } from "../compress.js";
import type { Db } from "../db/index.js";
import { enqueueJob, hasOpenJob, type JobRow } from "../db/repos/jobs.js";
import { getMessage, saveParsedMessage, setUserMessageTrashed, trashMessage } from "../db/repos/messages.js";
import { isBlockedSender } from "../db/repos/settings.js";
import { OWNER_USER_ID, resolveAddressOwner } from "../db/repos/users.js";
import { readRaw } from "../ingest/read-raw.js";
import type { AppLog } from "../log.js";
import { parseMessage } from "../mail/parse.js";
import { threadKeyOf } from "../mail/thread.js";

export interface ParseJobDeps {
  db: Db;
  dataDir: string;
  codec: Codec;
  log: AppLog;
  now: () => number;
}

/** Parse always runs, including when authentication failed. Classification is queued after it unless all recipient owners blocked the sender. */
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

  const recipients = envelopeAddresses(message.envelope_to);
  const owners = new Set<string>();
  if (recipients.length === 0) {
    owners.add(OWNER_USER_ID);
  } else {
    for (const rcpt of recipients) {
      owners.add(resolveAddressOwner(deps.db, rcpt));
    }
  }

  const now = deps.now();
  let unblockedCount = 0;
  for (const ownerId of owners) {
    const blocked =
      isBlockedSender(deps.db, fromAddr, ownerId) ||
      isBlockedSender(deps.db, message.envelope_from, ownerId);
    if (blocked) {
      if (ownerId === OWNER_USER_ID) {
        trashMessage(deps.db, message.id, now);
      } else {
        setUserMessageTrashed(deps.db, ownerId, message.id, now, now);
      }
    } else {
      unblockedCount += 1;
    }
  }

  if (unblockedCount === 0) {
    deps.log.info({ messageId: message.id }, "blocked sender moved to trash");
    return;
  }

  if (!hasOpenJob(deps.db, message.id, "classify")) {
    enqueueJob(deps.db, { id: ulid(), type: "classify", messageId: message.id, now });
  }
  deps.log.info(
    { messageId: message.id, attachments: result.parsed.attachmentCount, urls: result.parsed.urls.length },
    "parse done",
  );
}
