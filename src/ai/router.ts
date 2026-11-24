import type { Classifier, ClassifyInput } from "./classifier.js";
import { classifyWithGemini, geminiThinkingConfig, type ThinkingLevel } from "./gemini.js";
import { classifyWithOpenAi } from "./openai-compat.js";
import {
  createKeyPool,
  MISSING_API_KEY_MESSAGE,
  PoolCooldownError,
  type AiChannelSnapshot,
  type KeyPool,
} from "./pool.js";

export interface MultiChannelClassifierOptions {
  resolve: () => readonly AiChannelSnapshot[];
  thinking?: () => ThinkingLevel;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cooldownMs?: number;
  defaultModel?: string;
}

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRunnableChannel(channel: AiChannelSnapshot): boolean {
  if (!channel.model.trim() || channel.keys.length === 0) return false;
  if (channel.provider === "openai-compat") return isHttpUrl(channel.baseUrl.trim());
  return true;
}

/**
 * Priority-ordered multi-channel classifier.
 * Tries each configured Gemini or OpenAI-compatible channel in order; within each
 * channel, keys rotate with per-key cooldown tracking via a persistent KeyPool.
 */
export function createMultiChannelClassifier(options: MultiChannelClassifierOptions): Classifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pools = new Map<string, { sig: string; pool: KeyPool }>();

  function poolFor(channel: AiChannelSnapshot): KeyPool {
    const sig = `${channel.provider}|${channel.baseUrl.trim()}`;
    const existing = pools.get(channel.id);
    if (existing && existing.sig === sig) return existing.pool;
    const pool = createKeyPool({
      provider: channel.provider,
      cooldownMs: options.cooldownMs,
      now,
    });
    pools.set(channel.id, { sig, pool });
    return pool;
  }

  return {
    id: "multi-channel",
    model: options.defaultModel ?? "",
    async classify(input: ClassifyInput) {
      const runnable = options.resolve().filter(isRunnableChannel);
      if (runnable.length === 0) throw new Error(MISSING_API_KEY_MESSAGE);

      let lastErr: Error | null = null;
      let nonCooldownErr: Error | null = null;
      let minCooldownMs: number | null = null;
      let anyMadeCall = false;

      for (const channel of runnable) {
        const pool = poolFor(channel);
        const model = channel.model.trim();
        const baseUrl = channel.baseUrl.trim();
        try {
          return await pool.run({ models: [model], keys: channel.keys }, (modelName, secret) => {
            if (channel.provider === "gemini") {
              const thinking = options.thinking ? geminiThinkingConfig(modelName, options.thinking()) : undefined;
              return classifyWithGemini({
                fetchImpl,
                baseUrl: baseUrl || undefined,
                model: modelName,
                secret,
                input,
                timeoutMs,
                thinking,
                now,
              });
            }
            return classifyWithOpenAi({
              fetchImpl,
              baseUrl,
              model: modelName,
              secret,
              input,
              timeoutMs,
              now,
            });
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          lastErr = error;
          if (err instanceof PoolCooldownError) {
            minCooldownMs = minCooldownMs === null ? err.retryAfterMs : Math.min(minCooldownMs, err.retryAfterMs);
            if (err.madeCall) anyMadeCall = true;
          } else {
            nonCooldownErr = error;
            anyMadeCall = true;
          }
        }
      }

      if (!nonCooldownErr && minCooldownMs !== null) {
        throw new PoolCooldownError(
          lastErr?.message ?? `all ${runnable.length} ai channels cooling down`,
          minCooldownMs,
          anyMadeCall,
        );
      }
      throw nonCooldownErr ?? lastErr ?? new Error("ai all channels failed");
    },
  };
}
