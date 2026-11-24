import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Codec } from "../compress.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { findMessageByMessageId } from "../db/repos/messages.js";
import { readPersonalNotifySettings } from "../db/repos/settings.js";
import { OWNER_USER_ID, resolveAddressOwner } from "../db/repos/users.js";
import { sha256 } from "../hash.js";
import { normalizeAddress } from "../mail/address.js";
import { composeText } from "../mail/compose.js";
import { isBarkUrl } from "../notify/bark.js";
import { acceptMessage } from "./accept.js";

export const smsIngestBody = z
  .object({
    device: z.string().trim().min(1).max(64),
    smsId: z.union([z.number().int().nonnegative(), z.string().trim().min(1).max(64)]),
    from: z.string().trim().min(1).max(128),
    to: z.string().trim().min(1).max(128).optional(),
    slot: z.string().trim().min(1).max(64).optional(),
    text: z.string().max(100_000),
    receivedAt: z.union([z.number().finite(), z.string().trim().min(1).max(64)]),
  })
  .strict();

export type SmsIngestPayload = z.infer<typeof smsIngestBody>;

export interface SmsBarkTarget {
  url: string;
  bearer?: string;
}

export interface IngestSmsResult {
  id: string;
  sha256: string;
  duplicate: boolean;
  sizeBytes: number;
  recipient: string;
}

/** Constant-time Bearer check using SHA-256 digests so token length never leaks or throws. */
export function bearerTokenMatches(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (!authorizationHeader || !expectedToken) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  const provided = match?.[1];
  if (!provided) return false;
  const providedDigest = Buffer.from(sha256(Buffer.from(provided, "utf8")), "hex");
  const expectedDigest = Buffer.from(sha256(Buffer.from(expectedToken, "utf8")), "hex");
  return timingSafeEqual(providedDigest, expectedDigest);
}

/** Accept Unix seconds, Unix milliseconds, numeric strings, or ISO-8601 timestamps. */
export function parseSmsTimestamp(raw: number | string): number | null {
  let num: number;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    num = raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
  } else {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      num = parsed < 1e11 ? Math.round(parsed * 1000) : Math.round(parsed);
    } else {
      const parsed = Date.parse(trimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      num = Math.round(parsed);
    }
  }
  if (!Number.isSafeInteger(num) || num <= 0 || num > 8.64e15) return null;
  return num;
}

export function resolveSmsRecipient(
  toRaw: string | undefined,
  device: string,
  slot: string | undefined,
  smsDomain: string,
): string {
  const deviceSlug = slugifyToken(device, "dev");
  const slotSlug = slot ? slugifyToken(slot, "slot") : "";
  const fallbackLocal = slotSlug ? `${deviceSlug}-${slotSlug}` : deviceSlug;

  if (toRaw && toRaw.trim()) {
    const trimmed = toRaw.trim();
    const at = trimmed.lastIndexOf("@");
    const candidateLocal = at > 0 ? trimmed.slice(0, at) : trimmed;
    const localSlug = slugifyToken(candidateLocal, "to");
    const normalized = normalizeAddress(`${localSlug}@${smsDomain}`);
    if (normalized) return normalized;
  }

  return normalizeAddress(`${fallbackLocal}@${smsDomain}`) ?? `sms@${smsDomain}`;
}

export function buildSmsSender(fromRaw: string, smsDomain: string): { displayName: string; address: string } {
  const displayName = oneLine(fromRaw, 80) || "SMS";
  const cleanedLocal = fromRaw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.+_-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 64);
  const local = cleanedLocal && normalizeAddress(`${cleanedLocal}@sender.${smsDomain}`)
    ? cleanedLocal
    : `sms-${sha256(Buffer.from(fromRaw, "utf8")).slice(0, 12)}`;
  const address = normalizeAddress(`${local}@sender.${smsDomain}`) ?? `sms@sender.${smsDomain}`;
  return { displayName, address };
}

export function resolveSmsBarkTarget(db: Db, config: Config, recipientAddr?: string): SmsBarkTarget | null {
  if (recipientAddr) {
    const ownerId = resolveAddressOwner(db, recipientAddr);
    const personal = readPersonalNotifySettings(db, ownerId);
    const url = personal.notifyWebhookUrl.trim();
    if (url && (personal.notifyWebhookFormat === "bark" || (personal.notifyWebhookFormat === "auto" && isBarkUrl(url)))) {
      return personal.notifyWebhookBearer
        ? { url, bearer: personal.notifyWebhookBearer }
        : { url };
    }
  }
  const ownerPersonal = readPersonalNotifySettings(db, OWNER_USER_ID);
  const ownerUrl = ownerPersonal.notifyWebhookUrl.trim();
  if (
    ownerUrl &&
    (ownerPersonal.notifyWebhookFormat === "bark" ||
      (ownerPersonal.notifyWebhookFormat === "auto" && isBarkUrl(ownerUrl)))
  ) {
    return ownerPersonal.notifyWebhookBearer
      ? { url: ownerUrl, bearer: ownerPersonal.notifyWebhookBearer }
      : { url: ownerUrl };
  }
  if (config.barkUrl) return { url: config.barkUrl };
  if (config.notifyWebhookUrl && isBarkUrl(config.notifyWebhookUrl)) {
    return config.notifyWebhookBearer
      ? { url: config.notifyWebhookUrl, bearer: config.notifyWebhookBearer }
      : { url: config.notifyWebhookUrl };
  }
  return null;
}

export async function ingestSms(
  deps: { db: Db; dataDir: string; codec: Codec; smsDomain: string },
  input: SmsIngestPayload,
  remoteIp: string,
): Promise<IngestSmsResult | null> {
  const receivedAtMs = parseSmsTimestamp(input.receivedAt);
  if (receivedAtMs === null) return null;

  const smsIdRaw = String(input.smsId).trim();
  const deviceSlug = slugifyToken(input.device, "dev");
  const smsIdSlug = slugifyToken(smsIdRaw, "msg");
  const messageId = `sms-${deviceSlug}-${smsIdSlug}@${deps.smsDomain}`;

  const recipient = resolveSmsRecipient(input.to, input.device, input.slot, deps.smsDomain);
  const existingById = findMessageByMessageId(deps.db, messageId);
  if (existingById) {
    return {
      id: existingById.id,
      sha256: existingById.sha256,
      duplicate: true,
      sizeBytes: existingById.size_bytes,
      recipient,
    };
  }

  const sender = buildSmsSender(input.from, deps.smsDomain);
  const slotClean = input.slot ? oneLine(input.slot, 48) : undefined;
  const deviceClean = oneLine(input.device, 64);
  const smsIdClean = oneLine(smsIdRaw, 64);
  const subject = buildSmsSubject(sender.displayName, slotClean, input.text);
  const extraHeaders: Array<readonly [string, string]> = [
    ["Delivered-To", recipient],
    ["X-Flytrap-Channel", "sms"],
    ["X-Flytrap-Device", deviceClean],
    ["X-Flytrap-Sms-Id", smsIdClean],
  ];
  if (slotClean) extraHeaders.push(["X-Flytrap-Slot", slotClean]);

  const bytes = composeText({
    from: sender.address,
    fromName: sender.displayName,
    to: [recipient],
    cc: [],
    subject,
    text: input.text,
    messageId,
    date: new Date(receivedAtMs),
    extraHeaders,
  });

  const accepted = await acceptMessage(
    { db: deps.db, dataDir: deps.dataDir, codec: deps.codec },
    {
      bytes,
      receivedAtMs,
      initialJob: "parse",
      messageId,
      meta: {
        schema: 1,
        channel: "sms",
        device: deviceClean,
        smsId: smsIdClean,
        ...(slotClean ? { slot: slotClean } : {}),
        remoteIp,
        reverseDns: null,
        helo: "sms-ingest",
        mailFrom: sender.address,
        rcptTo: [recipient],
        secure: true,
        receivedAt: new Date(receivedAtMs).toISOString(),
        localIp: "",
        localPort: 0,
      },
    },
  );

  return { ...accepted, recipient };
}

function buildSmsSubject(fromDisplay: string, slot: string | undefined, text: string): string {
  const prefix = slot ? `[短信·${slot}]` : "[短信]";
  const snippet = firstLineSnippet(text, 36) || oneLine(fromDisplay, 36);
  return `${prefix} ${snippet}`.slice(0, 120);
}

function firstLineSnippet(text: string, maxLen: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.map((line) => line.replace(/\s+/g, " ").trim()).find((line) => line.length > 0) ?? "";
  if (first.length <= maxLen) return first;
  return `${first.slice(0, maxLen - 1)}…`;
}

function oneLine(value: string, maxLen: number): string {
  return value.replace(/[\u0000-\u001F\u007F\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function slugifyToken(raw: string, prefix: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 48);
  if (cleaned) return cleaned;
  return `${prefix}-${sha256(Buffer.from(raw, "utf8")).slice(0, 8)}`;
}
