import { LABELS, type Label } from "../../ai/types.js";
import { ConfigError, parseAcceptDomains } from "../../config.js";
import type { Db } from "../index.js";

export const SETTING_NOTIFY_LABELS = "notify_labels";
export const SETTING_NOTIFY_MIN_CONFIDENCE = "notify_min_confidence";
export const SETTING_ACCEPT_DOMAINS = "accept_domains";
export const SETTING_JOB_MAX_ATTEMPTS = "job_max_attempts";

export const DEFAULT_JOB_MAX_ATTEMPTS = 5;
export const MAX_JOB_ATTEMPTS = 20;

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

export interface RuntimeSettings {
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
