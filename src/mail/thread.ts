import { rfc822HeaderBlock } from "./headers.js";

const ID_RE = /^[^\s<>]{1,200}$/;
const MAX_REFS = 20;

export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw.trim();
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1).trim();
  text = text.toLowerCase();
  if (!ID_RE.test(text)) return null;
  return text;
}

/** Pull message-ids out of an In-Reply-To or References header. */
export function extractMessageIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string | null) => {
    if (!value || seen.has(value) || out.length >= MAX_REFS) return;
    seen.add(value);
    out.push(value);
  };
  const bracketed = raw.match(/<[^<>\s]+>/g);
  if (bracketed && bracketed.length > 0) {
    for (const token of bracketed) push(normalizeMessageId(token));
    return out;
  }
  for (const part of raw.split(/\s+/)) push(normalizeMessageId(part));
  return out;
}

export function threadKeyOf(messageId: string | null, inReplyTo: string | null, refs: readonly string[]): string | null {
  return refs[0] ?? inReplyTo ?? messageId;
}

export function readThreadHeaders(raw: Buffer): { messageId: string | null; inReplyTo: string | null; refs: string[] } {
  const unfolded = rfc822HeaderBlock(raw).replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
  const messageId = normalizeMessageId(headerValue(unfolded, "message-id"));
  const replyIds = extractMessageIds(headerValue(unfolded, "in-reply-to"));
  const refs = extractMessageIds(headerValue(unfolded, "references"));
  return { messageId, inReplyTo: replyIds[0] ?? null, refs };
}

function headerValue(unfolded: string, name: string): string | null {
  const match = unfolded.match(new RegExp(`(?:^|\\n)${name}:[ \\t]*([^\\n]*)`, "i"));
  return match?.[1]?.trim() || null;
}
