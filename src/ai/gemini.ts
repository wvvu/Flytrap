import { scrubSecrets, keyTail } from "./secret.js";
import { finalizeAiResult, parseModelJson, parseModelOutput } from "./types.js";
import type { Classifier, ClassifyInput } from "./classifier.js";

export interface KeyState {
  key: string;
  cooldownUntil: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  lastUsedAt: number;
  lastError?: string;
}

export interface GeminiPoolKey {
  id: string;
  secret: string;
}

export interface GeminiClassifierOptions {
  apiKeys?: string[];
  model?: string;
  models?: string[];
  /** Read on every call so a settings change applies without a restart. */
  resolve?: () => { models: string[]; keys: GeminiPoolKey[] };
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cooldownMs?: number;
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

export interface GeminiClassifier extends Classifier {
  getKeyPoolStatus(): KeyPoolSummary;
}

export function createGeminiClassifier(options: GeminiClassifierOptions): GeminiClassifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const model = options.model || "gemini-2.5-flash";
  const baseUrl = (options.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");

  const staticKeys: GeminiPoolKey[] = (options.apiKeys ?? [])
    .map((secret) => secret.trim())
    .filter(Boolean)
    .map((secret, index) => ({ id: `static:${index}`, secret }));
  const staticModels = (options.models ?? [model]).map((item) => item.trim()).filter(Boolean);

  const states = new Map<string, KeyState>();
  let roundRobinIdx = 0;

  function snapshot(): { models: string[]; keys: GeminiPoolKey[] } {
    if (options.resolve) {
      const resolved = options.resolve();
      const models = resolved.models.map((item) => item.trim()).filter(Boolean);
      const keys = resolved.keys
        .map((item) => ({ id: item.id, secret: item.secret.trim() }))
        .filter((item) => item.id && item.secret);
      return { models: models.length > 0 ? models : staticModels, keys };
    }
    return { models: staticModels, keys: staticKeys };
  }

  function stateFor(item: GeminiPoolKey): KeyState {
    const current = states.get(item.id);
    if (current) return current;
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

  function pickAvailableKey(keys: readonly GeminiPoolKey[]): { item: GeminiPoolKey; state: KeyState } {
    const currentNow = now();
    const available = keys.filter((item) => stateFor(item).cooldownUntil <= currentNow);
    if (available.length === 0) {
      const minWait = Math.min(...keys.map((item) => Math.max(0, stateFor(item).cooldownUntil - currentNow)));
      throw new Error(`gemini key pool exhausted: all ${keys.length} keys in cooldown (retry in ${Math.ceil(minWait / 1000)}s)`);
    }
    const picked = available[roundRobinIdx % available.length];
    if (!picked) throw new Error("gemini key pool unexpected empty pick");
    roundRobinIdx = (roundRobinIdx + 1) % available.length;
    return { item: picked, state: stateFor(picked) };
  }

  return {
    id: "gemini",
    model,
    async classify(input: ClassifyInput) {
      const pool = snapshot();
      if (pool.keys.length === 0) throw new Error("no api key configured");
      const secrets = pool.keys.map((item) => item.secret);
      let lastErr: Error | null = null;

      for (const modelName of pool.models) {
        let modelRejected = false;
        for (let attempt = 0; attempt < pool.keys.length; attempt += 1) {
          let picked: { item: GeminiPoolKey; state: KeyState };
          try {
            picked = pickAvailableKey(pool.keys);
          } catch (err) {
            const message = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
            throw new Error(message);
          }
          picked.state.totalCalls += 1;
          picked.state.lastUsedAt = now();
          try {
            const content = await callGemini(fetchImpl, baseUrl, modelName, picked.item.secret, input, timeoutMs);
            const output = parseModelOutput(parseModelJson(content));
            picked.state.successCalls += 1;
            return finalizeAiResult({
              schema: 1,
              prompt_id: input.promptId,
              model: modelName,
              provider: "gemini",
              at: new Date(now()).toISOString(),
              label: output.label,
              confidence: output.confidence,
              summary: output.summary,
              tags: output.tags,
              signals: output.signals,
              raw: output,
            });
          } catch (err) {
            const errMsg = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
            picked.state.failedCalls += 1;
            picked.state.lastError = errMsg;
            if (isRateLimit(errMsg)) {
              picked.state.cooldownUntil = now() + cooldownMs;
              lastErr = new Error(errMsg);
              continue;
            }
            if (isMissingModel(errMsg)) {
              modelRejected = true;
              lastErr = new Error(errMsg);
              break;
            }
            throw new Error(errMsg);
          }
        }
        if (modelRejected) continue;
        break;
      }

      throw lastErr || new Error("gemini all attempts failed");
    },
    getKeyPoolStatus() {
      const currentNow = now();
      const pool = snapshot();
      return {
        model: pool.models[0] || model,
        keys: pool.keys.map((item) => {
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

function isRateLimit(message: string): boolean {
  return message.includes("429") || message.includes("503") || message.includes("ResourceExhausted") || message.includes("Unavailable");
}

function isMissingModel(message: string): boolean {
  return message.includes("404") || message.includes("NOT_FOUND") || /not found/i.test(message) || /invalid model/i.test(message);
}

async function callGemini(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  apiKey: string,
  input: ClassifyInput,
  timeoutMs: number,
): Promise<string> {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    label: {
      type: "STRING",
      enum: ["legit", "spam", "phish", "malware", "gray", "unsolicited-admin"],
    },
    confidence: {
      type: "NUMBER",
    },
    summary: {
      type: "STRING",
    },
    tags: {
      type: "ARRAY",
      items: {
        type: "STRING",
      },
    },
    signals: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          value: { type: "STRING" },
        },
        required: ["name", "value"],
      },
    },
  },
  required: ["label", "confidence", "summary", "tags", "signals"],
};

  const body = {
    system_instruction: {
      parts: [{ text: input.systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: input.userMessage }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: GEMINI_RESPONSE_SCHEMA,
    },
  };


  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`gemini ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const partText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!partText || partText.trim().length === 0) {
    throw new Error("gemini empty completion");
  }
  return partText;
}
