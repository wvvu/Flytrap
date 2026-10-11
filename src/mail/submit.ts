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

export interface SubmitInput {
  from: string;
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string;
  text?: string;
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
  const domain = addressDomain(from);
  const domainKnown = readAcceptDomains(deps.db, deps.acceptDomains).includes(domain);
  const now = (deps.now ?? Date.now)();
  const id = ulid();
  let raw = composeText({
    from,
    to,
    cc,
    subject,
    text,
    messageId: `${id}@${domain}`,
    date: new Date(now),
  });
  const key = findDkimKey(deps.db, domain);
  const selector = key?.selector ?? null;
  if (key) raw = await signMessage(raw, { domain, selector: key.selector, privatePem: key.privatePem });
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
