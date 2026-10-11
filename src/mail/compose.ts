const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface ComposeTextInput {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  text: string;
  messageId: string;
  date: Date;
}

/** A text/plain letter. Bcc stays off the header so it only exists on the envelope. */
export function composeText(input: ComposeTextInput): Buffer {
  const encoded = encodeBody(input.text);
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    input.cc.length > 0 ? `Cc: ${input.cc.join(", ")}` : "",
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${formatDate(input.date)}`,
    `Message-ID: <${input.messageId}>`,
    "MIME-Version: 1.0",
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: ${encoded.cte}`,
  ].filter((line) => line.length > 0);
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${encoded.body}`, "utf8");
}

function encodeHeader(value: string): string {
  if (/^[\t\x20-\x7E]*$/.test(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  const words: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 45) {
    words.push(`=?UTF-8?B?${bytes.subarray(offset, offset + 45).toString("base64")}?=`);
  }
  return words.join("\r\n ");
}

function encodeBody(text: string): { cte: "7bit" | "base64"; body: string } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  if (/^[\t\r\n\x20-\x7E]*$/.test(normalized)) {
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
