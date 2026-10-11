import { resolveMx } from "node:dns/promises";
import nodemailer from "nodemailer";

export interface OutboundMessage {
  from: string;
  to: readonly string[];
  raw: Buffer;
  ehloName: string;
  /** Called after a recipient domain accepts, before a later domain is tried. */
  onAccepted?: (addresses: readonly string[], response: string) => void;
}

export interface MailSender {
  send(message: OutboundMessage): Promise<{ response: string }>;
}

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface MxDeps {
  resolveMx: (domain: string) => Promise<MxRecord[]>;
  sendToHost: (host: string, message: OutboundMessage) => Promise<string>;
}

/**
 * Deliver straight to each recipient domain's MX.
 * A domain that already accepted is reported before the next one is tried,
 * so a retry can skip it.
 */
export async function deliverToMx(message: OutboundMessage, deps: MxDeps): Promise<{ response: string }> {
  const groups = new Map<string, string[]>();
  for (const address of message.to) {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const list = groups.get(domain) ?? [];
    list.push(address);
    groups.set(domain, list);
  }
  const responses: string[] = [];
  for (const [domain, recipients] of groups) {
    const hosts = await mxHosts(domain, deps.resolveMx);
    let last = "no route";
    let accepted = false;
    for (const host of hosts) {
      try {
        const response = await deps.sendToHost(host, { ...message, to: recipients });
        message.onAccepted?.(recipients, response);
        responses.push(`${domain} ${response}`);
        accepted = true;
        break;
      } catch (err) {
        last = err instanceof Error ? err.message : "send failed";
      }
    }
    if (!accepted) throw new Error(`${domain}: ${last}`.slice(0, 400));
  }
  return { response: responses.join("; ").slice(0, 500) };
}

export function createMxSender(): MailSender {
  return {
    send(message) {
      return deliverToMx(message, {
        resolveMx: (domain) => resolveMx(domain),
        sendToHost: smtpSend,
      });
    },
  };
}

async function mxHosts(domain: string, lookup: MxDeps["resolveMx"]): Promise<string[]> {
  let records: MxRecord[] = [];
  try {
    records = await lookup(domain);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
    if (code === "ENODATA") records = [];
    else throw err;
  }
  const usable = records
    .filter((record) => record.exchange && record.exchange !== ".")
    .sort((a, b) => a.priority - b.priority)
    .map((record) => record.exchange.replace(/\.$/, "").toLowerCase());
  const unique = [...new Set(usable)];
  if (unique.length > 0) return unique.slice(0, 4);
  if (records.some((record) => record.exchange === "." || record.exchange === "")) {
    throw new Error("domain does not accept mail");
  }
  return [domain];
}

async function smtpSend(host: string, message: OutboundMessage): Promise<string> {
  const transport = nodemailer.createTransport({
    host,
    port: 25,
    secure: false,
    name: message.ehloName,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    // Opportunistic TLS. MX certificates often do not match the exchange name.
    tls: { rejectUnauthorized: false },
  });
  try {
    const info = await transport.sendMail({
      envelope: { from: message.from, to: [...message.to] },
      raw: message.raw,
    });
    return (info.response || "250").slice(0, 300);
  } catch (err) {
    const response = typeof err === "object" && err !== null && "response" in err && typeof err.response === "string" ? err.response : "";
    const messageText = err instanceof Error ? err.message : "send failed";
    throw new Error([messageText, response].filter(Boolean).join(": ").slice(0, 400));
  } finally {
    transport.close();
  }
}
