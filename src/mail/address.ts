import { ConfigError, parseAcceptDomains } from "../config.js";

const LOCAL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;

export class OutboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundError";
  }
}

/** One mailbox, lowercased. Display names and whitespace are refused. */
export function normalizeAddress(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  const at = text.lastIndexOf("@");
  if (at <= 0) return null;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1).replace(/\.$/, "");
  if (!LOCAL_RE.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  try {
    const parsed = parseAcceptDomains(domain);
    if (parsed.length !== 1 || parsed[0] !== domain) return null;
  } catch (err) {
    if (err instanceof ConfigError) return null;
    return null;
  }
  return `${local}@${domain}`;
}

export function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1) : "";
}

export function uniqueAddresses(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const address = normalizeAddress(value);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

export function cleanSubject(raw: string | undefined): string {
  const text = (raw ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/ {2,}/g, " ").trim();
  if (text.length > 200) throw new OutboundError("subject is too long");
  return text;
}

export function cleanText(raw: string | undefined): string {
  const text = (raw ?? "").replace(/\u0000/g, "");
  if (text.length > 100_000) throw new OutboundError("body is too long");
  return text;
}
