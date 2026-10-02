import { LABELS, type Label } from "../../ai/types.js";
import { ConfigError, parseAcceptDomains } from "../../config.js";
import type { Db } from "../index.js";

export const SETTING_NOTIFY_LABELS = "notify_labels";
export const SETTING_NOTIFY_MIN_CONFIDENCE = "notify_min_confidence";
export const SETTING_ACCEPT_DOMAINS = "accept_domains";
export const SETTING_JOB_MAX_ATTEMPTS = "job_max_attempts";
export const SETTING_PANEL_TITLE = "panel_title";
export const SETTING_LABEL_NAMES = "label_names";
export const SETTING_DOMAIN_NAMES = "domain_names";
export const SETTING_SENDER_NAMES = "sender_names";

export const DEFAULT_JOB_MAX_ATTEMPTS = 5;
export const MAX_JOB_ATTEMPTS = 20;
export const DEFAULT_PANEL_TITLE = "Flytrap";
export const MAX_PANEL_TITLE = 40;
export const MAX_LABEL_NAME = 16;
export const MAX_DOMAIN_NAME = 24;
export const MAX_SENDER_NAMES = 200;
export const MAX_SENDER_NAME = 40;
export const MAX_DOMAIN_NAMES = 50;

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

export function readRuntimeSettings(db: Db, defaults: RuntimeDefaults): RuntimeSettings {
  return {
    notifyLabels: readNotifyLabels(db, defaults.notifyLabels),
    notifyMinConfidence: readNotifyMinConfidence(db, defaults.notifyMinConfidence),
    acceptDomains: readAcceptDomains(db, defaults.acceptDomains),
    jobMaxAttempts: readJobMaxAttempts(db),
    ...readNameSettings(db),
  };
}

export function readNameSettings(db: Db): NameSettings {
  return {
    panelTitle: readPanelTitle(db),
    labelNames: readLabelNames(db),
    domainNames: readDomainNames(db),
    senderNames: readSenderNames(db),
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
): NameSettings {
  const panelTitle = cleanName(input.panelTitle, 1, MAX_PANEL_TITLE, "panel title");
  const labelNames = normalizeLabelNames(input.labelNames);
  const domainNames = normalizeDomainNames(input.domainNames);
  const senderNames = normalizeSenderNames(input.senderNames);
  const write = db.transaction(() => {
    writeRaw(db, SETTING_PANEL_TITLE, panelTitle, now);
    writeRaw(db, SETTING_LABEL_NAMES, JSON.stringify(labelNames), now);
    writeRaw(db, SETTING_DOMAIN_NAMES, JSON.stringify(domainNames), now);
    writeRaw(db, SETTING_SENDER_NAMES, JSON.stringify(senderNames), now);
  });
  write();
  return {
    panelTitle,
    labelNames: resolveLabelNames(labelNames),
    domainNames,
    senderNames,
  };
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

export function saveAcceptDomains(db: Db, domains: readonly string[], now: number): string[] {
  const normalized = parseAcceptDomains(domains.join(","));
  writeRaw(db, SETTING_ACCEPT_DOMAINS, JSON.stringify(normalized), now);
  return normalized;
}

export function saveJobMaxAttempts(db: Db, maxAttempts: number, now: number): number {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_JOB_ATTEMPTS) {
    throw new SettingsError(`job max attempts must be an integer from 1 to ${MAX_JOB_ATTEMPTS}`);
  }
  writeRaw(db, SETTING_JOB_MAX_ATTEMPTS, String(maxAttempts), now);
  return maxAttempts;
}

function readPanelTitle(db: Db): string {
  const raw = readRaw(db, SETTING_PANEL_TITLE);
  if (raw === null) return DEFAULT_PANEL_TITLE;
  try {
    return cleanName(raw, 1, MAX_PANEL_TITLE, "panel title");
  } catch {
    return DEFAULT_PANEL_TITLE;
  }
}

function readLabelNames(db: Db): Record<Label, string> {
  const stored = readJsonObject(db, SETTING_LABEL_NAMES);
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

function readSenderNames(db: Db): SenderName[] {
  const raw = readRaw(db, SETTING_SENDER_NAMES);
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
  const match = ADDRESS_RE.exec(text);
  if (!match) throw new SettingsError(`invalid sender address (${raw})`);
  const domain = oneDomain(match[1] ?? "");
  const at = text.lastIndexOf("@");
  const local = text.slice(0, at);
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
