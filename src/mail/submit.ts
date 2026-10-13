import { ulid } from "ulid";
import type { Codec } from "../compress.js";
import type { Db } from "../db/index.js";
import { findDkimKey } from "../db/repos/dkim-keys.js";
import { enqueueJob } from "../db/repos/jobs.js";
import { insertOutbox } from "../db/repos/outbox.js";
import { readAcceptDomains } from "../db/repos/settings.js";
import { storeRaw } from "../ingest/store-raw.js";
import { addressDomain, cleanSubject, cleanText, normalizeAddress, OutboundError, uniqueAddresses } from "./address.js";
import { composeText } from "./compose.js";
import { signMessage } from "./dkim.js";
import { normalizeMessageId, threadKeyOf } from "./thread.js";

export interface SubmitInput {
  from: string;
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string;
  text?: string;
  inReplyTo?: string;
  references?: readonly string[];
}

export interface SubmitResult {
  id: string;
  status: "queued";
  domainKnown: boolean;
  dkim: "signed" | "none";
  selector: string | null;
}

export interface SubmitDeps {
  db: Db;
  dataDir: string;
  codec: Codec;
  acceptDomains: readonly string[];
  now?: () => number;
}

const MAX_RECIPIENTS = 20;
const MAX_REFS = 20;

function cleanReply(input: SubmitInput): { inReplyTo: string | null; refs: string[] } {
  const rawReply = input.inReplyTo?.trim() ?? "";
  const inReplyTo = rawReply ? normalizeMessageId(rawReply) : null;
  if (rawReply && !inReplyTo) throw new OutboundError("invalid message id");
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.references ?? []) {
    const id = normalizeMessageId(raw);
    if (!id) throw new OutboundError("invalid message id");
    if (seen.has(id) || refs.length >= MAX_REFS) continue;
    seen.add(id);
    refs.push(id);
  }
  return { inReplyTo, refs };
}

/**
 * Write the letter first, then queue a send. A From domain outside the
 * accept list is kept and reported; it is not refused.
 */
export async function submitOutbox(deps: SubmitDeps, input: SubmitInput): Promise<SubmitResult> {
  const from = normalizeAddress(input.from);
  if (!from) throw new OutboundError("invalid from");
  const to = uniqueAddresses(input.to);
  const cc = uniqueAddresses(input.cc ?? []);
  const bcc = uniqueAddresses(input.bcc ?? []);
  if (to.length === 0) throw new OutboundError("missing to");
  const recipients = uniqueAddresses([...to, ...cc, ...bcc]);
  if (recipients.length > MAX_RECIPIENTS) throw new OutboundError("too many recipients");
  const subject = cleanSubject(input.subject);
  const text = cleanText(input.text);
  const reply = cleanReply(input);
  const domain = addressDomain(from);
  const domainKnown = readAcceptDomains(deps.db, deps.acceptDomains).includes(domain);
  const now = (deps.now ?? Date.now)();
  const id = ulid();
  const messageId = `${id}@${domain}`.toLowerCase();
  let raw = composeText({
    from,
    to,
    cc,
    subject,
    text,
    messageId,
    date: new Date(now),
    inReplyTo: reply.inReplyTo,
    references: reply.refs,
  });
  const key = findDkimKey(deps.db, domain);
  const selector = key?.selector ?? null;
  if (key) {
    raw = await signMessage(raw, {
      domain,
      selector: key.selector,
      privatePem: key.privatePem,
      alg: key.algorithm,
    });
  }
  const stored = await storeRaw({
    dataDir: deps.dataDir,
    bytes: raw,
    receivedAtMs: now,
    codec: deps.codec,
    area: "sent",
  });
  deps.db.transaction(() => {
    insertOutbox(deps.db, {
      id,
      sha256: stored.sha256,
      rawPath: stored.relativePath,
      sizeBytes: stored.sizeBytes,
      from,
      to: recipients,
      subject,
      domainKnown,
      dkimSelector: selector,
      now,
      messageId,
      inReplyTo: reply.inReplyTo,
      refIds: reply.refs.length > 0 ? JSON.stringify(reply.refs) : null,
      threadKey: threadKeyOf(messageId, reply.inReplyTo, reply.refs),
    });
    enqueueJob(deps.db, {
      id: ulid(),
      type: "send",
      payload: { outboxId: id },
      now,
    });
  })();
  return {
    id,
    status: "queued",
    domainKnown,
    dkim: selector ? "signed" : "none",
    selector,
  };
}
