import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Db } from "../db/index.js";
import { resolveInside } from "../paths.js";
import { splitAddress } from "../smtp/policy.js";

export interface HistoryFact {
  domain: string;
  localpart: string;
  firstSeen: number | null;
  lastSeen: number | null;
  notes: string | null;
}

export interface PromptAttachment {
  filename: string;
  sha256: string;
  mime: string | null;
  sizeBytes: number;
}

export interface ClassifyFacts {
  spf: string;
  dkim: string;
  dmarc: string;
  rdns: "match" | "no-match";
  envelopeFrom: string;
  envelopeTo: string[];
  from: string;
  subject: string;
  messageId: string;
  text: string;
  urls: string[];
  history: HistoryFact[];
  missingHistory: Array<{ domain: string; localpart: string }>;
  attachments: PromptAttachment[];
}

export function readPrompt(dir: string, id = "classify-v1", db?: Db): string {
  if (db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`prompt:${id}`) as { value: string } | undefined;
    if (row && typeof row.value === "string") return row.value;
  }
  let file: string;
  try {
    file = resolveInside(dir, `${id}.txt`);
  } catch {
    throw new Error(`prompt ${id} is outside the prompts directory`);
  }
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error(`prompt ${id} is missing`);
  }
}

export function listPrompts(dir: string, db?: Db): Array<{ id: string; name: string }> {
  const ids = new Set<string>();
  if (db) {
    const rows = db.prepare("SELECT key FROM settings WHERE key LIKE 'prompt:%'").all() as Array<{ key: string }>;
    for (const r of rows) {
      ids.add(r.key.slice("prompt:".length));
    }
  }
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (f.endsWith(".txt")) ids.add(f.replace(/\.txt$/, ""));
    }
  } catch {
    // ignore
  }
  if (ids.size === 0) ids.add("classify-v1");
  return Array.from(ids).sort().map((id) => ({ id, name: id }));
}

export function savePrompt(dir: string, id: string, content: string, db?: Db, now = Date.now()): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("invalid prompt id");
  }
  if (db) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(`prompt:${id}`, content, now);
  }
  try {
    const file = resolveInside(dir, `${id}.txt`);
    writeFileSync(file, content, "utf8");
  } catch {
    // on read-only file systems (e.g. docker read_only: true), ignore disk write failure
    // as sqlite settings table already stores the updated prompt.
  }
}

function sanitizeXmlBoundary(text: string): string {
  return text.replace(/<\/?(untrusted_email|system_telemetry)[^>]*>/gi, "[filtered-tag]");
}

export function buildUserMessage(facts: ClassifyFacts): string {
  const from = facts.envelopeFrom ? facts.envelopeFrom : "<>";
  const telemetryLines = [
    `AUTH: spf= ${facts.spf} dkim= ${facts.dkim} dmarc= ${facts.dmarc} rdns= ${facts.rdns}`,
    `ENVELOPE: from=${from} to=${facts.envelopeTo.join(",")}`,
    "MAILBOX_NOTES: operator notes about recipient addresses. A missing note is normal. It is not a category and it is not suspicious.",
  ];
  if (facts.history.length === 0 && facts.missingHistory.length === 0) {
    telemetryLines.push("MAILBOX_NOTES: none attached");
  }
  for (const row of facts.history) {
    const notes = row.notes ? ` note=${JSON.stringify(row.notes)}` : "";
    telemetryLines.push(
      `MAILBOX_NOTE: ${row.localpart}@${row.domain} first_seen=${day(row.firstSeen)} last_seen=${day(row.lastSeen)}${notes}`,
    );
  }
  for (const row of facts.missingHistory) {
    telemetryLines.push(`MAILBOX_NOTE: ${row.localpart}@${row.domain} has no operator note`);
  }

  const urlLines = facts.urls.length === 0 ? ["-"] : facts.urls.map((url) => `- ${url}`);
  const attachmentLines: string[] = [];
  if (facts.attachments.length === 0) {
    attachmentLines.push("-");
  } else {
    for (const attachment of facts.attachments) {
      const name = attachment.filename || "(unnamed)";
      const mime = attachment.mime || "application/octet-stream";
      attachmentLines.push(`- ${name} sha256=${attachment.sha256} mime=${mime} size=${formatSize(attachment.sizeBytes)}`);
    }
  }

  return [
    "<system_telemetry>",
    ...telemetryLines,
    "</system_telemetry>",
    "",
    "<untrusted_email>",
    "<headers>",
    `HEADER: From=${oneLine(facts.from)} Subject=${oneLine(facts.subject)} Message-ID=${oneLine(facts.messageId)}`,
    "</headers>",
    "<body_text>",
    "TEXT:",
    sanitizeXmlBoundary(facts.text),
    "</body_text>",
    "<urls>",
    "URLS:",
    ...urlLines,
    "</urls>",
    "<attachments>",
    "ATTACHMENTS:",
    ...attachmentLines,
    "</attachments>",
    "</untrusted_email>",
  ].join("\n");
}


export function envelopeAddresses(raw: string | null): string[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

export function recipientParts(addresses: readonly string[]): Array<{ domain: string; localpart: string }> {
  const out: Array<{ domain: string; localpart: string }> = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const parts = splitAddress(address);
    if (!parts) continue;
    const key = `${parts.localpart.toLowerCase()}@${parts.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parts);
  }
  return out;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function day(ms: number | null): string {
  if (!ms) return "unset";
  return new Date(ms).toISOString().slice(0, 10);
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}m`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}k`;
  return `${bytes}b`;
}
