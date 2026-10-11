import type { Codec } from "../compress.js";
import type { Db } from "../db/index.js";
import { outboxIdOf, type JobRow } from "../db/repos/jobs.js";
import { acceptedAddresses, getOutbox, markOutboxSent, recordAccepted } from "../db/repos/outbox.js";
import { readRaw } from "../ingest/read-raw.js";
import type { MailSender } from "../mail/deliver.js";

export interface SendJobDeps {
  db: Db;
  dataDir: string;
  codec: Codec;
  ehloName: string;
  sendMail: MailSender;
  now: () => number;
}

export async function runSendJob(deps: SendJobDeps, job: JobRow): Promise<void> {
  const outboxId = outboxIdOf(job.payload);
  if (!outboxId) throw new Error("send job has no outbox");
  const row = getOutbox(deps.db, outboxId);
  if (!row) throw new Error("outbox missing");
  if (row.status === "sent") return;
  const done = new Set(acceptedAddresses(row.accepted));
  const pending = acceptedAddresses(row.to_addrs).filter((address) => !done.has(address));
  if (pending.length === 0) {
    markOutboxSent(deps.db, row.id, row.smtp_response ?? "250", deps.now());
    return;
  }
  const raw = await readRaw(deps.dataDir, row.raw_path, deps.codec, row.sha256);
  const result = await deps.sendMail.send({
    from: row.from_addr,
    to: pending,
    raw,
    ehloName: deps.ehloName,
    onAccepted: (addresses, response) => {
      recordAccepted(deps.db, row.id, addresses, response, deps.now());
    },
  });
  markOutboxSent(deps.db, row.id, result.response, deps.now());
}
