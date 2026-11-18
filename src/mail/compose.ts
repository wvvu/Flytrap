import { randomBytes } from "node:crypto";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface ComposeAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ComposeTextInput {
  from: string;
  /** Display name for the From header. Omitted when the sender has none. */
  fromName?: string;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  text: string;
  messageId: string;
  date: Date;
  inReplyTo?: string | null;
  references?: readonly string[];
}

/** A text/plain letter. Bcc stays off the header so it only exists on the envelope. */
export function composeText(input: ComposeTextInput): Buffer {
  const encoded = encodeBody(input.text);
  const lines = [
    `From: ${formatFrom(input.fromName, input.from)}`,
    foldAddressHeader("To", input.to),
    input.cc.length > 0 ? foldAddressHeader("Cc", input.cc) : "",
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${formatDate(input.date)}`,
    `Message-ID: <${input.messageId}>`,
    ...replyHeaders(input),
    "MIME-Version: 1.0",
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: ${encoded.cte}`,
  ].filter((line) => line.length > 0);
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${encoded.body}`, "utf8");
}

export interface ComposeMailInput extends ComposeTextInput {
  attachments?: readonly ComposeAttachment[];
}

/** Compose either a single text/plain message or a multipart/mixed message with attachments. */
export function composeMail(input: ComposeMailInput): Buffer {
  if (!input.attachments || input.attachments.length === 0) return composeText(input);
  const boundary = `----=_Part_${randomBytes(12).toString("hex")}`;
  const encodedText = encodeBody(input.text);
  const topHeaders = [
    `From: ${formatFrom(input.fromName, input.from)}`,
    foldAddressHeader("To", input.to),
    input.cc.length > 0 ? foldAddressHeader("Cc", input.cc) : "",
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${formatDate(input.date)}`,
    `Message-ID: <${input.messageId}>`,
    ...replyHeaders(input),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter((line) => line.length > 0);

  const parts: string[] = [
    [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      `Content-Transfer-Encoding: ${encodedText.cte}`,
      "",
      encodedText.body.replace(/\r\n$/, ""),
    ].join("\r\n"),
  ];

  for (const att of input.attachments) {
    const mime = sanitizeMimeType(att.contentType);
    const filename = sanitizeAttachmentFilename(att.filename);
    const b64 = wrapBase64(att.content.toString("base64"));
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${mime}; name="${encodeHeader(filename)}"`,
        `Content-Disposition: attachment; ${formatDispositionFilename(filename)}`,
        "Content-Transfer-Encoding: base64",
        "",
        b64,
      ].join("\r\n"),
    );
  }

  const full = `${topHeaders.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`;
  return Buffer.from(full, "utf8");
}

function sanitizeMimeType(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(clean)) return "application/octet-stream";
  return clean;
}

function sanitizeAttachmentFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001F\u007F"\\;]/g, "_").trim().slice(0, 180);
  return clean || "attachment.bin";
}

function formatDispositionFilename(filename: string): string {
  if (/^[\x20-\x7E]+$/.test(filename)) return `filename="${filename}"`;
  return `filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function wrapBase64(b64: string): string {
  if (!b64) return "";
  return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}

function formatFrom(name: string | undefined, address: string): string {
  const clean = (name ?? "").trim().replace(/["<>\r\n]/g, "");
  if (!clean) return address;
  return `${encodeHeader(clean)} <${address}>`;
}

function replyHeaders(input: ComposeTextInput): string[] {
  const lines: string[] = [];
  if (input.inReplyTo) lines.push(`In-Reply-To: <${input.inReplyTo}>`);
  const refs = (input.references ?? []).filter((id) => id.length > 0);
  if (refs.length > 0) lines.push(foldReferences(refs));
  return lines;
}

function foldAddressHeader(name: string, addresses: readonly string[]): string {
  if (addresses.length === 0) return "";
  const lines: string[] = [];
  let current = `${name}:`;
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i]!;
    const isLast = i === addresses.length - 1;
    const addition = ` ${address}${isLast ? "" : ","}`;
    if (current !== `${name}:` && current.length + addition.length > 78) {
      lines.push(current);
      current = ` ${address}${isLast ? "" : ","}`;
    } else {
      current += addition;
    }
  }
  lines.push(current);
  return lines.join("\r\n");
}

function foldReferences(ids: readonly string[]): string {
  const lines: string[] = [];
  let current = "References:";
  for (const id of ids) {
    const addition = ` <${id}>`;
    if (current.length + addition.length > 78 && current !== "References:") {
      lines.push(current);
      current = addition;
    } else {
      current += addition;
    }
  }
  lines.push(current);
  return lines.join("\r\n");
}

function encodeHeader(value: string): string {
  if (/^[\t\x20-\x7E]*$/.test(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  const words: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let next = Math.min(offset + 45, bytes.length);
    if (next < bytes.length) {
      while (next > offset && ((bytes[next] ?? 0) & 0xc0) === 0x80) {
        next--;
      }
      if (next === offset) {
        next = Math.min(offset + 45, bytes.length);
        while (next < bytes.length && ((bytes[next] ?? 0) & 0xc0) === 0x80) {
          next++;
        }
      }
    }
    words.push(`=?UTF-8?B?${bytes.subarray(offset, next).toString("base64")}?=`);
    offset = next;
  }
  return words.join("\r\n ");
}

function encodeBody(text: string): { cte: "7bit" | "base64"; body: string } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const isAscii = /^[\t\r\n\x20-\x7E]*$/.test(normalized);
  const maxLine = normalized.split("\r\n").reduce((max, line) => Math.max(max, line.length), 0);
  if (isAscii && maxLine <= 998) {
    return { cte: "7bit", body: `${normalized}\r\n` };
  }
  const b64 = Buffer.from(normalized, "utf8").toString("base64");
  const lines = b64.match(/.{1,76}/g) ?? [];
  return { cte: "base64", body: `${lines.join("\r\n")}\r\n` };
}

function formatDate(date: Date): string {
  const day = DAYS[date.getUTCDay()] ?? "Thu";
  const month = MONTHS[date.getUTCMonth()] ?? "Jan";
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${day}, ${dd} ${month} ${date.getUTCFullYear()} ${hh}:${mm}:${ss} +0000`;
}
