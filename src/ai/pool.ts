import type { Config } from "../config.js";
import { keyTail, scrubSecrets } from "./secret.js";

export interface PoolKey {
  id: string;
  secret: string;
}

export interface AiPoolSnapshot {
  models: string[];
  keys: PoolKey[];
}

export interface KeyState {
  key: string;
  cooldownUntil: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  lastUsedAt: number;
  lastError?: string;
}

export interface KeyPoolSummary {
  model: string;
  keys: Array<{
    tail: string;
    isCoolingDown: boolean;
    cooldownRemainingSec: number;
    successCalls: number;
    failedCalls: number;
    lastError?: string;
  }>;
}

/** Thrown by classifiers when the effective pool has no usable key. The worker treats this as "not yet", not a failure: the job is deferred without spending an attempt. */
export const MISSING_API_KEY_MESSAGE = "no api key configured";

const MAX_TIMEOUT_RETRIES_PER_CALL = 2;

/** Thrown when every key in the pool is cooling down so the worker can wait until thaw instead of burning retries. */
export class PoolCooldownError extends Error {
  readonly retryAfterMs: number;
  readonly madeCall: boolean;

  constructor(message: string, retryAfterMs: number, madeCall: boolean) {
    super(message);
    this.name = "PoolCooldownError";
    this.retryAfterMs = Math.max(0, retryAfterMs);
    this.madeCall = madeCall;
  }
}

export type ErrorKind = "missing_model" | "rate_limit" | "auth" | "transient" | "fatal";

export function isTimeoutError(err: unknown, message: string): boolean {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return true;
  }
  return /aborted due to timeout|timed out|\btimeout\b/i.test(message);
}

export function classifyPoolError(err: unknown, message: string): ErrorKind {
  if (/\b404\b/.test(message) || message.includes("NOT_FOUND") || /not found|invalid model/i.test(message)) {
    return "missing_model";
  }
  if (/\b429\b/.test(message) || /ResourceExhausted|rate[_ ]?limit|quota/i.test(message)) {
    return "rate_limit";
  }
  if (
    /\b40[13]\b/.test(message) ||
    /UNAUTHENTICATED|PERMISSION_DENIED|API_KEY_INVALID|API key not valid|invalid_api_key/i.test(message)
  ) {
    return "auth";
  }
  if (
    /\b50[0234]\b/.test(message) ||
    /Unavailable|overloaded|empty completion|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(
      message,
    ) ||
    isTimeoutError(err, message)
  ) {
    return "transient";
  }
  return "fatal";
}

export interface KeyPool {
  run<T>(
    snapshot: AiPoolSnapshot,
    callModel: (model: string, secret: string) => Promise<T>,
  ): Promise<T>;
  status(snapshot: AiPoolSnapshot, defaultModel: string): KeyPoolSummary;
}

/** Shared round-robin key pool with error-aware cooldowns across Gemini and OpenAI-compatible classifiers. */
export function createKeyPool(options: {
  provider: string;
  cooldownMs?: number;
  transientCooldownMs?: number;
  now?: () => number;
}): KeyPool {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const transientCooldownMs = options.transientCooldownMs ?? Math.min(cooldownMs, 15_000);
  const states = new Map<string, KeyState>();
  let roundRobinIdx = 0;

  function stateFor(item: PoolKey): KeyState {
    const current = states.get(item.id);
    if (current) {
      current.key = item.secret;
      return current;
    }
    const created: KeyState = {
      key: item.secret,
      cooldownUntil: 0,
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      lastUsedAt: 0,
    };
    states.set(item.id, created);
    return created;
  }

  function minWaitMs(keys: readonly PoolKey[], currentNow: number): number {
    if (keys.length === 0) return 0;
    return Math.min(...keys.map((item) => Math.max(0, stateFor(item).cooldownUntil - currentNow)));
  }

  function pickAvailable(keys: readonly PoolKey[]): { item: PoolKey; state: KeyState } {
    const currentNow = now();
    const n = keys.length;
    for (let offset = 0; offset < n; offset += 1) {
      const idx = (roundRobinIdx + offset) % n;
      const candidate = keys[idx];
      if (!candidate) continue;
      const state = stateFor(candidate);
      if (state.cooldownUntil <= currentNow) {
        roundRobinIdx = (idx + 1) % n;
        return { item: candidate, state };
      }
    }
    const minWait = minWaitMs(keys, currentNow);
    throw new PoolCooldownError(
      `${options.provider} key pool exhausted: all ${keys.length} keys in cooldown (retry in ${Math.ceil(minWait / 1000)}s)`,
      minWait,
      false,
    );
  }

  return {
    async run(snapshot, callModel) {
      const models = snapshot.models.map((item) => item.trim()).filter(Boolean);
      const keys = snapshot.keys
        .map((item) => ({ id: item.id, secret: item.secret.trim() }))
        .filter((item) => item.id && item.secret);
      if (models.length === 0 || keys.length === 0) throw new Error(MISSING_API_KEY_MESSAGE);

      const secrets = keys.map((item) => item.secret);
      let lastErr: Error | null = null;
      let madeCall = false;
      let timeoutCount = 0;

      for (const modelName of models) {
        let modelRejected = false;
        for (let attempt = 0; attempt < keys.length; attempt += 1) {
          let picked: { item: PoolKey; state: KeyState };
          try {
            picked = pickAvailable(keys);
          } catch (err) {
            if (err instanceof PoolCooldownError) {
              const message = scrubSecrets(err.message, secrets);
              if (madeCall && lastErr) {
                throw new PoolCooldownError(
                  `${lastErr.message} (all ${keys.length} keys in cooldown, retry in ${Math.ceil(err.retryAfterMs / 1000)}s)`,
                  err.retryAfterMs,
                  true,
                );
              }
              throw new PoolCooldownError(message, err.retryAfterMs, false);
            }
            throw err;
          }

          picked.state.totalCalls += 1;
          picked.state.lastUsedAt = now();
          madeCall = true;
          try {
            const result = await callModel(modelName, picked.item.secret);
            picked.state.successCalls += 1;
            return result;
          } catch (err) {
            const errMsg = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
            picked.state.failedCalls += 1;
            picked.state.lastError = errMsg;
            const kind = classifyPoolError(err, errMsg);
            if (kind === "missing_model") {
              modelRejected = true;
              lastErr = new Error(errMsg);
              break;
            }
            if (kind === "rate_limit" || kind === "auth" || kind === "transient") {
              const duration = kind === "transient" ? transientCooldownMs : cooldownMs;
              picked.state.cooldownUntil = now() + duration;
              lastErr = new Error(errMsg);
              if (isTimeoutError(err, errMsg)) {
                timeoutCount += 1;
                if (timeoutCount >= MAX_TIMEOUT_RETRIES_PER_CALL) break;
              }
              continue;
            }
            throw new Error(errMsg);
          }
        }
        if (modelRejected) continue;
        break;
      }

      const wait = minWaitMs(keys, now());
      if (lastErr && wait > 0) {
        throw new PoolCooldownError(
          `${lastErr.message} (all ${keys.length} keys in cooldown, retry in ${Math.ceil(wait / 1000)}s)`,
          wait,
          madeCall,
        );
      }
      throw lastErr || new Error(`${options.provider} all attempts failed`);
    },

    status(snapshot, defaultModel) {
      const currentNow = now();
      const models = snapshot.models.map((item) => item.trim()).filter(Boolean);
      const keys = snapshot.keys
        .map((item) => ({ id: item.id, secret: item.secret.trim() }))
        .filter((item) => item.id && item.secret);
      return {
        model: models[0] || defaultModel,
        keys: keys.map((item) => {
          const keyState = stateFor(item);
          return {
            tail: keyTail(item.secret),
            isCoolingDown: keyState.cooldownUntil > currentNow,
            cooldownRemainingSec: Math.max(0, Math.ceil((keyState.cooldownUntil - currentNow) / 1000)),
            successCalls: keyState.successCalls,
            failedCalls: keyState.failedCalls,
            lastError: keyState.lastError,
          };
        }),
      };
    },
  };
}

/** Keys and models from the process environment. The panel never receives the secret. */
export function fallbackAiPool(config: Config): AiPoolSnapshot {
  if (config.classifier === "gemini") {
    return {
      models: [config.geminiModel || "gemini-2.5-flash"],
      keys: config.geminiApiKeys.map((secret, index) => ({ id: `env:${index}`, secret })),
    };
  }
  if (config.classifier === "openai-compat") {
    return {
      models: config.openaiModel ? [config.openaiModel] : [],
      keys: config.openaiApiKey ? [{ id: "env:0", secret: config.openaiApiKey }] : [],
    };
  }
  return { models: [], keys: [] };
}
