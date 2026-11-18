import { ulid } from "ulid";
import { keyTail } from "../../ai/secret.js";
import { LABELS, type Label } from "../../ai/types.js";
import { ConfigError, parseAcceptDomains } from "../../config.js";
import type { Db } from "../index.js";
import { OWNER_USER_ID } from "./users.js";

export const SETTING_NOTIFY_LABELS = "notify_labels";
export const SETTING_NOTIFY_MIN_CONFIDENCE = "notify_min_confidence";
export const SETTING_ACCEPT_DOMAINS = "accept_domains";
export const SETTING_JOB_MAX_ATTEMPTS = "job_max_attempts";
export const SETTING_PANEL_TITLE = "panel_title";
export const SETTING_LABEL_NAMES = "label_names";
export const SETTING_DOMAIN_NAMES = "domain_names";
export const SETTING_SENDER_NAMES = "sender_names";
export const SETTING_AI_MODELS = "ai_models";
export const SETTING_AI_KEYS = "ai_keys";
export const SETTING_AI_ENABLED = "ai_enabled";
export const SETTING_AI_THINKING = "ai_thinking";
export const SETTING_PASSWORD_HASH = "password_hash";
export const SETTING_PASSWORD_RESET = "password_reset";
export const SETTING_OWNER_DISPLAY_NAME = "owner_display_name";
export const SETTING_OWNER_RECOVERY_EMAIL = "owner_recovery_email";
export const SETTING_BLOCKED_SENDERS = "blocked_senders";
export const SETTING_NOTIFY_WEBHOOK_URL = "notify_webhook_url";
export const SETTING_NOTIFY_WEBHOOK_BEARER = "notify_webhook_bearer";
export const SETTING_NOTIFY_WEBHOOK_LABELS = "notify_webhook_labels";
export const SETTING_NOTIFY_WEBHOOK_MIN_CONFIDENCE = "notify_webhook_min_confidence";

export interface ResetSeal {
  salt: string;
  hash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
  target?: string;
}

export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "low";

export const DEFAULT_JOB_MAX_ATTEMPTS = 5;
export const MAX_JOB_ATTEMPTS = 20;
export const DEFAULT_PANEL_TITLE = "邮箱";
export const MAX_PANEL_TITLE = 40;
export const MAX_LABEL_NAME = 16;
export const MAX_DOMAIN_NAME = 24;
export const MAX_SENDER_NAMES = 200;
export const MAX_SENDER_NAME = 40;
export const MAX_DOMAIN_NAMES = 50;
export const MAX_AI_MODELS = 8;
export const MAX_AI_KEYS = 20;
export const MAX_BLOCKED_SENDERS = 500;

const MODEL_RE = /^[A-Za-z0-9._:@/-]{1,80}$/;

export const DEFAULT_LABEL_NAMES: Record<Label, string> = {
  legit: "正常",
  spam: "垃圾",
  phish: "钓鱼",
  malware: "恶意",
  gray: "待看",
  "unsolicited-admin": "推广",
};

const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(.+)$/;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export interface RuntimeDefaults {
  notifyLabels: readonly string[];
  notifyMinConfidence: number;
  acceptDomains: readonly string[];
}

export interface SenderName {
  address: string;
  name: string;
}

export interface NameSettings {
  panelTitle: string;
  labelNames: Record<Label, string>;
  domainNames: Record<string, string>;
  senderNames: SenderName[];
}

export interface RuntimeSettings extends NameSettings {
  notifyLabels: Label[];
  notifyMinConfidence: number;
  acceptDomains: string[];
  jobMaxAttempts: number;
}

function userKey(userId: string, baseKey: string): string {
  return userId === OWNER_USER_ID ? baseKey : `u:${userId}:${baseKey}`;
}

export function readRuntimeSettings(db: Db, defaults: RuntimeDefaults, userId = OWNER_USER_ID): RuntimeSettings {
  return {
    notifyLabels: readNotifyLabels(db, defaults.notifyLabels),
    notifyMinConfidence: readNotifyMinConfidence(db, defaults.notifyMinConfidence),
    acceptDomains: readAcceptDomains(db, defaults.acceptDomains),
    jobMaxAttempts: readJobMaxAttempts(db),
    ...readNameSettings(db, userId),
  };
}

export function readNameSettings(db: Db, userId = OWNER_USER_ID): NameSettings {
  return {
    panelTitle: readPanelTitle(db, userId),
    labelNames: readLabelNames(db, userId),
    domainNames: readDomainNames(db),
    senderNames: readSenderNames(db, userId),
  };
}

export function saveNameSettings(
  db: Db,
  input: {
    panelTitle: string;
    labelNames: Readonly<Record<string, string>>;
    domainNames: Readonly<Record<string, string>>;
    senderNames: readonly SenderName[];
  },
  now: number,
  userId = OWNER_USER_ID,
): NameSettings {
  const panelTitle = cleanName(input.panelTitle, 1, MAX_PANEL_TITLE, "panel title");
  const labelNames = normalizeLabelNames(input.labelNames);
  const senderNames = normalizeSenderNames(input.senderNames);
  const isOwner = userId === OWNER_USER_ID;
  const domainNames = isOwner ? normalizeDomainNames(input.domainNames) : readDomainNames(db);
  const write = db.transaction(() => {
    writeRaw(db, userKey(userId, SETTING_PANEL_TITLE), panelTitle, now);
    writeRaw(db, userKey(userId, SETTING_LABEL_NAMES), JSON.stringify(labelNames), now);
    if (isOwner) {
      writeRaw(db, SETTING_DOMAIN_NAMES, JSON.stringify(domainNames), now);
    }
    writeRaw(db, userKey(userId, SETTING_SENDER_NAMES), JSON.stringify(senderNames), now);
  });
  write();
  return {
    panelTitle,
    labelNames: resolveLabelNames(labelNames),
    domainNames,
    senderNames,
  };
}

export function readOwnerProfile(db: Db): { displayName: string | null; recoveryEmail: string | null } {
  const name = readRaw(db, SETTING_OWNER_DISPLAY_NAME);
  const email = readRaw(db, SETTING_OWNER_RECOVERY_EMAIL);
  return {
    displayName: name && name.trim() ? name.trim() : null,
    recoveryEmail: email && email.trim() ? email.trim() : null,
  };
}

export function saveOwnerProfile(
  db: Db,
  input: { displayName?: string | null; recoveryEmail?: string | null },
  now: number,
): { displayName: string | null; recoveryEmail: string | null } {
  const current = readOwnerProfile(db);
  let nextName = current.displayName;
  if (input.displayName !== undefined) {
    const trimmed = (input.displayName ?? "").trim();
    nextName = trimmed ? cleanName(trimmed, 1, MAX_SENDER_NAME, "display name") : null;
  }
  let nextEmail = current.recoveryEmail;
  if (input.recoveryEmail !== undefined) {
    const trimmed = (input.recoveryEmail ?? "").trim();
    nextEmail = trimmed ? normalizeAddress(trimmed) : null;
  }
  db.transaction(() => {
    if (nextName) writeRaw(db, SETTING_OWNER_DISPLAY_NAME, nextName, now);
    else db.prepare("DELETE FROM settings WHERE key = ?").run(SETTING_OWNER_DISPLAY_NAME);
    if (nextEmail) writeRaw(db, SETTING_OWNER_RECOVERY_EMAIL, nextEmail, now);
    else db.prepare("DELETE FROM settings WHERE key = ?").run(SETTING_OWNER_RECOVERY_EMAIL);
  })();
  return { displayName: nextName, recoveryEmail: nextEmail };
}

export function readAcceptDomains(db: Db, fallback: readonly string[]): string[] {
  const raw = readRaw(db, SETTING_ACCEPT_DOMAINS);
  if (raw === null) return [...fallback];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return [...fallback];
    return parseAcceptDomains(parsed.join(","));
  } catch (err) {
    if (err instanceof ConfigError) return [...fallback];
    return [...fallback];
  }
}

export function readJobMaxAttempts(db: Db): number {
  const raw = readRaw(db, SETTING_JOB_MAX_ATTEMPTS);
  if (raw === null) return DEFAULT_JOB_MAX_ATTEMPTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_JOB_ATTEMPTS) return DEFAULT_JOB_MAX_ATTEMPTS;
  return value;
}

export function saveNotifySettings(db: Db, labels: readonly string[], minConfidence: number, now: number): Label[] {
  const normalized = normalizeLabels(labels, true);
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new SettingsError("notify confidence must be between 0 and 1");
  }
  const write = db.transaction(() => {
    writeRaw(db, SETTING_NOTIFY_LABELS, JSON.stringify(normalized), now);
    writeRaw(db, SETTING_NOTIFY_MIN_CONFIDENCE, String(minConfidence), now);
  });
  write();
  return normalized;
}

export interface PersonalNotifySettings {
  notifyLabels: Label[];
  notifyMinConfidence: number;
  notifyWebhookUrl: string;
  notifyWebhookBearer: string;
}

/** Per-person webhook. Keys follow userKey, separate from the global notify policy. */
export function readPersonalNotifySettings(db: Db, userId: string): PersonalNotifySettings {
  return {
    notifyLabels: readPersonalNotifyLabels(db, userId),
    notifyMinConfidence: readPersonalNotifyMinConfidence(db, userId),
    notifyWebhookUrl: (readRaw(db, userKey(userId, SETTING_NOTIFY_WEBHOOK_URL)) ?? "").trim(),
    notifyWebhookBearer: (readRaw(db, userKey(userId, SETTING_NOTIFY_WEBHOOK_BEARER)) ?? "").trim(),
  };
}

export function savePersonalNotifySettings(
  db: Db,
  userId: string,
  input: {
    labels: readonly string[];
    minConfidence: number;
    webhookUrl: string;
    webhookBearer?: string;
  },
  now: number,
): PersonalNotifySettings {
  const labels = normalizeLabels(input.labels, true);
  if (!Number.isFinite(input.minConfidence) || input.minConfidence < 0 || input.minConfidence > 1) {
    throw new SettingsError("notify confidence must be between 0 and 1");
  }
  const webhookUrl = cleanWebhookUrl(input.webhookUrl);
  const current = readPersonalNotifySettings(db, userId);
  const webhookBearer = input.webhookBearer === undefined
    ? current.notifyWebhookBearer
    : input.webhookBearer.trim().slice(0, 512);
  const write = db.transaction(() => {
    writeRaw(db, userKey(userId, SETTING_NOTIFY_WEBHOOK_LABELS), JSON.stringify(labels), now);
    writeRaw(db, userKey(userId, SETTING_NOTIFY_WEBHOOK_MIN_CONFIDENCE), String(input.minConfidence), now);
    writeRaw(db, userKey(userId, SETTING_NOTIFY_WEBHOOK_URL), webhookUrl, now);
    writeRaw(db, userKey(userId, SETTING_NOTIFY_WEBHOOK_BEARER), webhookBearer, now);
  });
  write();
  return readPersonalNotifySettings(db, userId);
}

export function saveAcceptDomains(db: Db, domains: readonly string[], now: number): string[] {
  const normalized = parseAcceptDomains(domains.join(","));
  writeRaw(db, SETTING_ACCEPT_DOMAINS, JSON.stringify(normalized), now);
  return normalized;
}

export function readBlockedSenders(db: Db, userId = OWNER_USER_ID): string[] {
  const raw = readRaw(db, userKey(userId, SETTING_BLOCKED_SENDERS));
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeBlockedSenders(parsed.filter((item): item is string => typeof item === "string"), false);
  } catch {
    return [];
  }
}

export function saveBlockedSenders(db: Db, addresses: readonly string[], now: number, userId = OWNER_USER_ID): string[] {
  const normalized = normalizeBlockedSenders(addresses, true);
  writeRaw(db, userKey(userId, SETTING_BLOCKED_SENDERS), JSON.stringify(normalized), now);
  return normalized;
}

export function isBlockedSender(db: Db, address: string | null | undefined, userId = OWNER_USER_ID): boolean {
  if (!address) return false;
  try {
    return readBlockedSenders(db, userId).includes(normalizeAddress(address));
  } catch {
    return false;
  }
}

export function saveJobMaxAttempts(db: Db, maxAttempts: number, now: number): number {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_JOB_ATTEMPTS) {
    throw new SettingsError(`job max attempts must be an integer from 1 to ${MAX_JOB_ATTEMPTS}`);
  }
  writeRaw(db, SETTING_JOB_MAX_ATTEMPTS, String(maxAttempts), now);
  return maxAttempts;
}

export interface StoredAiKey {
  id: string;
  secret: string;
}

export interface AiKeyPublic {
  id: string;
  tail: string;
}

export interface AiPoolSource {
  models: string[];
  keys: StoredAiKey[];
  modelsFrom: "saved" | "env";
  keysFrom: "saved" | "env";
}

export interface AiPoolPublic {
  models: string[];
  keys: AiKeyPublic[];
  modelsFrom: "saved" | "env";
  keysFrom: "saved" | "env";
}

export function readEffectiveAiPool(
  db: Db,
  fallback: { models: readonly string[]; keys: readonly StoredAiKey[] },
): AiPoolSource {
  const stored = readStoredAiPool(db);
  const modelsFrom = stored.models.length > 0 ? "saved" : "env";
  const keysFrom = stored.keys.length > 0 ? "saved" : "env";
  return {
    models: modelsFrom === "saved" ? stored.models : [...fallback.models],
    keys: keysFrom === "saved" ? stored.keys : fallback.keys.map((item) => ({ id: item.id, secret: item.secret })),
    modelsFrom,
    keysFrom,
  };
}

export function presentAiPool(pool: AiPoolSource): AiPoolPublic {
  return {
    models: pool.models,
    keys: pool.keys.map((item) => ({ id: item.id, tail: keyTail(item.secret) })),
    modelsFrom: pool.modelsFrom,
    keysFrom: pool.keysFrom,
  };
}

export function saveAiPool(
  db: Db,
  input: { models: readonly string[]; keys: readonly { id?: string; secret?: string }[] },
  fallback: readonly StoredAiKey[],
  now: number,
): AiPoolPublic {
  const models = normalizeModels(input.models);
  const keys = normalizeAiKeys(db, input.keys, fallback);
  const write = db.transaction(() => {
    writeRaw(db, SETTING_AI_MODELS, JSON.stringify(models), now);
    writeRaw(db, SETTING_AI_KEYS, JSON.stringify(keys), now);
  });
  write();
  return {
    models,
    keys: keys.map((item) => ({ id: item.id, tail: keyTail(item.secret) })),
    modelsFrom: models.length > 0 ? "saved" : "env",
    keysFrom: keys.length > 0 ? "saved" : "env",
  };
}

function readStoredAiPool(db: Db): { models: string[]; keys: StoredAiKey[] } {
  return { models: readModelList(db), keys: readKeyList(db) };
}

function readModelList(db: Db): string[] {
  const raw = readRaw(db, SETTING_AI_MODELS);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string" || !MODEL_RE.test(item)) continue;
      if (!out.includes(item)) out.push(item);
    }
    return out.slice(0, MAX_AI_MODELS);
  } catch {
    return [];
  }
}

function readKeyList(db: Db): StoredAiKey[] {
  const raw = readRaw(db, SETTING_AI_KEYS);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: StoredAiKey[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      const secret = (item as { secret?: unknown }).secret;
      if (typeof id !== "string" || typeof secret !== "string") continue;
      const trimmed = secret.trim();
      if (!id || trimmed.length < 8) continue;
      out.push({ id, secret: trimmed });
    }
    return out.slice(0, MAX_AI_KEYS);
  } catch {
    return [];
  }
}

function normalizeModels(input: readonly string[]): string[] {
  if (input.length > MAX_AI_MODELS) throw new SettingsError(`at most ${MAX_AI_MODELS} models`);
  const out: string[] = [];
  for (const item of input) {
    const model = item.trim();
    if (!model) continue;
    if (!MODEL_RE.test(model)) throw new SettingsError(`invalid model (${model})`);
    if (!out.includes(model)) out.push(model);
  }
  return out;
}

function normalizeAiKeys(
  db: Db,
  input: readonly { id?: string; secret?: string }[],
  fallback: readonly StoredAiKey[],
): StoredAiKey[] {
  if (input.length > MAX_AI_KEYS) throw new SettingsError(`at most ${MAX_AI_KEYS} keys`);
  const known = new Map<string, string>();
  for (const item of readKeyList(db)) known.set(item.id, item.secret);
  for (const item of fallback) known.set(item.id, item.secret);
  const out: StoredAiKey[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const provided = item.secret?.trim() ?? "";
    const id = item.id?.trim() ?? "";
    let secret = "";
    let nextId = "";
    if (provided) {
      secret = cleanSecret(provided);
      nextId = ulid();
    } else if (id) {
      const found = known.get(id);
      if (!found) throw new SettingsError("unknown key");
      secret = found;
      nextId = id.startsWith("env:") ? ulid() : id;
    } else {
      throw new SettingsError("key needs an id or a secret");
    }
    if (seen.has(secret)) continue;
    seen.add(secret);
    out.push({ id: nextId, secret });
  }
  return out;
}

function cleanSecret(value: string): string {
  if (value.length < 8 || value.length > 512) throw new SettingsError("key length");
  if (CONTROL_RE.test(value) || /\s/.test(value)) throw new SettingsError("key has invalid characters");
  return value;
}

function readPanelTitle(db: Db, userId = OWNER_USER_ID): string {
  const raw = readRaw(db, userKey(userId, SETTING_PANEL_TITLE)) ?? (userId !== OWNER_USER_ID ? readRaw(db, SETTING_PANEL_TITLE) : null);
  if (raw === null) return DEFAULT_PANEL_TITLE;
  try {
    const title = cleanName(raw, 1, MAX_PANEL_TITLE, "panel title");
    if (title === "Flytrap") return DEFAULT_PANEL_TITLE;
    return title;
  } catch {
    return DEFAULT_PANEL_TITLE;
  }
}

function readLabelNames(db: Db, userId = OWNER_USER_ID): Record<Label, string> {
  const stored = readJsonObject(db, userKey(userId, SETTING_LABEL_NAMES))
    ?? (userId !== OWNER_USER_ID ? readJsonObject(db, SETTING_LABEL_NAMES) : null);
  if (!stored) return { ...DEFAULT_LABEL_NAMES };
  const overrides: Partial<Record<Label, string>> = {};
  for (const label of LABELS) {
    const value = stored[label];
    if (typeof value !== "string" || value === DEFAULT_LABEL_NAMES[label]) continue;
    try {
      overrides[label] = cleanName(value, 1, MAX_LABEL_NAME, "label name");
    } catch {
      continue;
    }
  }
  return resolveLabelNames(overrides);
}

function readDomainNames(db: Db): Record<string, string> {
  const stored = readJsonObject(db, SETTING_DOMAIN_NAMES);
  if (!stored) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value !== "string") continue;
    try {
      const domain = oneDomain(key);
      const name = cleanName(value, 1, MAX_DOMAIN_NAME, "domain name");
      out[domain] = name;
    } catch {
      continue;
    }
  }
  return out;
}

function readSenderNames(db: Db, userId = OWNER_USER_ID): SenderName[] {
  const raw = readRaw(db, userKey(userId, SETTING_SENDER_NAMES));
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SenderName[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const address = (item as { address?: unknown }).address;
      const name = (item as { name?: unknown }).name;
      if (typeof address !== "string" || typeof name !== "string") continue;
      try {
        out.push({ address: normalizeAddress(address), name: cleanName(name, 1, MAX_SENDER_NAME, "sender name") });
      } catch {
        continue;
      }
    }
    return out.slice(0, MAX_SENDER_NAMES);
  } catch {
    return [];
  }
}

function normalizeLabelNames(input: Readonly<Record<string, string>>): Partial<Record<Label, string>> {
  const overrides: Partial<Record<Label, string>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!LABELS.includes(key as Label)) throw new SettingsError(`unknown label (${key})`);
    const label = key as Label;
    const trimmed = collapse(value);
    if (!trimmed || trimmed === DEFAULT_LABEL_NAMES[label]) continue;
    overrides[label] = cleanName(trimmed, 1, MAX_LABEL_NAME, "label name");
  }
  return overrides;
}

function resolveLabelNames(overrides: Partial<Record<Label, string>>): Record<Label, string> {
  const resolved = { ...DEFAULT_LABEL_NAMES };
  for (const label of LABELS) {
    const name = overrides[label];
    if (name) resolved[label] = name;
  }
  return resolved;
}

function normalizeDomainNames(input: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length > MAX_DOMAIN_NAMES) {
    throw new SettingsError(`at most ${MAX_DOMAIN_NAMES} domain names`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const trimmed = collapse(value);
    if (!trimmed) continue;
    out[oneDomain(key)] = cleanName(trimmed, 1, MAX_DOMAIN_NAME, "domain name");
  }
  return out;
}

function normalizeBlockedSenders(addresses: readonly string[], strict: boolean): string[] {
  if (addresses.length > MAX_BLOCKED_SENDERS) {
    throw new SettingsError(`at most ${MAX_BLOCKED_SENDERS} blocked senders`);
  }
  const out: string[] = [];
  for (const raw of addresses) {
    try {
      const address = normalizeAddress(raw);
      if (!out.includes(address)) out.push(address);
    } catch (err) {
      if (strict) throw err;
    }
  }
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

function normalizeSenderNames(input: readonly SenderName[]): SenderName[] {
  if (input.length > MAX_SENDER_NAMES) throw new SettingsError(`at most ${MAX_SENDER_NAMES} sender names`);
  const map = new Map<string, string>();
  for (const item of input) {
    map.set(normalizeAddress(item.address), cleanName(item.name, 1, MAX_SENDER_NAME, "sender name"));
  }
  return [...map]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([address, name]) => ({ address, name }));
}

function oneDomain(raw: string): string {
  try {
    const parsed = parseAcceptDomains(raw);
    const domain = parsed[0];
    if (!domain || parsed.length !== 1) throw new SettingsError(`invalid domain (${raw})`);
    return domain;
  } catch (err) {
    if (err instanceof SettingsError) throw err;
    throw new SettingsError(`invalid domain (${raw})`);
  }
}

function normalizeAddress(raw: string): string {
  const text = raw.trim().toLowerCase();
  const angled = text.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] ?? "" : text).trim();
  const match = ADDRESS_RE.exec(candidate);
  if (!match) throw new SettingsError(`invalid sender address (${raw})`);
  const domain = oneDomain(match[1] ?? "");
  const at = candidate.lastIndexOf("@");
  const local = candidate.slice(0, at);
  return `${local}@${domain}`;
}

function cleanName(value: string, min: number, max: number, label: string): string {
  const cleaned = collapse(value);
  if (cleaned.length < min || cleaned.length > max) {
    throw new SettingsError(`${label} must be ${min} to ${max} characters`);
  }
  if (CONTROL_RE.test(cleaned)) throw new SettingsError(`${label} has control characters`);
  return cleaned;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readJsonObject(db: Db, key: string): Record<string, unknown> | null {
  const raw = readRaw(db, key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readPersonalNotifyLabels(db: Db, userId: string): Label[] {
  const raw = readRaw(db, userKey(userId, SETTING_NOTIFY_WEBHOOK_LABELS));
  if (raw === null) return ["phish", "malware"];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ["phish", "malware"];
    return normalizeLabels(parsed.filter((item): item is string => typeof item === "string"), false);
  } catch {
    return ["phish", "malware"];
  }
}

function readPersonalNotifyMinConfidence(db: Db, userId: string): number {
  const raw = readRaw(db, userKey(userId, SETTING_NOTIFY_WEBHOOK_MIN_CONFIDENCE));
  if (raw === null) return 0.6;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return 0.6;
  return value;
}

function cleanWebhookUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return "";
  if (url.length > 500) throw new SettingsError("invalid webhook url");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SettingsError("invalid webhook url");
  } catch (err) {
    if (err instanceof SettingsError) throw err;
    throw new SettingsError("invalid webhook url");
  }
  return url;
}

function readNotifyLabels(db: Db, fallback: readonly string[]): Label[] {
  const raw = readRaw(db, SETTING_NOTIFY_LABELS);
  if (raw === null) return normalizeLabels(fallback, false);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return normalizeLabels(fallback, false);
    return normalizeLabels(parsed.filter((item): item is string => typeof item === "string"), false);
  } catch {
    return normalizeLabels(fallback, false);
  }
}

function readNotifyMinConfidence(db: Db, fallback: number): number {
  const raw = readRaw(db, SETTING_NOTIFY_MIN_CONFIDENCE);
  if (raw === null) return clampConfidence(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return clampConfidence(fallback);
  return value;
}

function normalizeLabels(values: readonly string[], strict: boolean): Label[] {
  const out: Label[] = [];
  for (const value of values) {
    if (!LABELS.includes(value as Label)) {
      if (strict) throw new SettingsError(`unknown notify label (${value})`);
      continue;
    }
    const label = value as Label;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.6;
  return Math.min(1, Math.max(0, value));
}

export function readAiEnabled(db: Db): boolean {
  const raw = readRaw(db, SETTING_AI_ENABLED);
  if (raw === null) return true;
  return raw === "1";
}

export function readAiThinking(db: Db): ThinkingLevel {
  const raw = readRaw(db, SETTING_AI_THINKING);
  if (raw && THINKING_LEVELS.includes(raw as ThinkingLevel)) return raw as ThinkingLevel;
  return DEFAULT_THINKING_LEVEL;
}

export function saveAiControls(db: Db, enabled: boolean, thinking: ThinkingLevel, now: number): void {
  if (!THINKING_LEVELS.includes(thinking)) throw new SettingsError("unknown thinking level");
  const write = db.transaction(() => {
    writeRaw(db, SETTING_AI_ENABLED, enabled ? "1" : "0", now);
    writeRaw(db, SETTING_AI_THINKING, thinking, now);
  });
  write();
}

export function readPasswordHash(db: Db): string | null {
  const raw = readRaw(db, SETTING_PASSWORD_HASH);
  if (!raw || !raw.startsWith("scrypt:")) return null;
  return raw;
}

export function savePasswordHash(db: Db, hash: string, now: number): void {
  writeRaw(db, SETTING_PASSWORD_HASH, hash, now);
}

export function readResetSeal(db: Db, targetKey = OWNER_USER_ID): ResetSeal | null {
  const key = targetKey === OWNER_USER_ID ? SETTING_PASSWORD_RESET : `u:${targetKey}:${SETTING_PASSWORD_RESET}`;
  const raw = readRaw(db, key);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.salt !== "string" || row.salt.length < 8 || typeof row.hash !== "string" || row.hash.length < 8) return null;
  if (!Number.isFinite(row.expiresAt) || !Number.isFinite(row.attempts) || !Number.isFinite(row.sentAt)) return null;
  return {
    salt: row.salt,
    hash: row.hash,
    expiresAt: row.expiresAt as number,
    attempts: row.attempts as number,
    sentAt: row.sentAt as number,
    target: typeof row.target === "string" ? row.target : undefined,
  };
}

export function saveResetSeal(db: Db, seal: ResetSeal, now: number, targetKey = OWNER_USER_ID): void {
  const key = targetKey === OWNER_USER_ID ? SETTING_PASSWORD_RESET : `u:${targetKey}:${SETTING_PASSWORD_RESET}`;
  writeRaw(db, key, JSON.stringify(seal), now);
}

export function clearResetSeal(db: Db, targetKey = OWNER_USER_ID): void {
  const key = targetKey === OWNER_USER_ID ? SETTING_PASSWORD_RESET : `u:${targetKey}:${SETTING_PASSWORD_RESET}`;
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

function readRaw(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

function writeRaw(db: Db, key: string, value: string, now: number): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}
