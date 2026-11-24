import { createKeyPool, type KeyPoolSummary, type KeyState, type PoolKey } from "./pool.js";
import { finalizeAiResult, parseModelJson, parseModelOutput } from "./types.js";
import type { Classifier, ClassifyInput } from "./classifier.js";

export type ThinkingLevel = "off" | "low" | "medium" | "high";
export type { KeyPoolSummary, KeyState };
export type GeminiPoolKey = PoolKey;

export function geminiThinkingConfig(
  model: string,
  level: ThinkingLevel,
): { thinkingBudget: number } | { thinkingLevel: string } {
  if (/gemini-3/i.test(model)) {
    const name = { off: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }[level];
    return { thinkingLevel: name };
  }
  const budget = { off: 0, low: 1024, medium: 8192, high: 24576 }[level];
  return { thinkingBudget: budget };
}

export interface GeminiClassifierOptions {
  apiKeys?: string[];
  model?: string;
  models?: string[];
  /** Read on every call so a settings change applies without a restart. */
  resolve?: () => { models: string[]; keys: GeminiPoolKey[] };
  thinking?: () => ThinkingLevel;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cooldownMs?: number;
}

export interface GeminiClassifier extends Classifier {
  getKeyPoolStatus(): KeyPoolSummary;
}

export function createGeminiClassifier(options: GeminiClassifierOptions): GeminiClassifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const model = options.model || "gemini-2.5-flash";
  const baseUrl = (options.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");

  const staticKeys: GeminiPoolKey[] = (options.apiKeys ?? [])
    .map((secret) => secret.trim())
    .filter(Boolean)
    .map((secret, index) => ({ id: `static:${index}`, secret }));
  const staticModels = (options.models ?? [model]).map((item) => item.trim()).filter(Boolean);

  const pool = createKeyPool({
    provider: "gemini",
    cooldownMs: options.cooldownMs,
    now,
  });

  function snapshot(): { models: string[]; keys: GeminiPoolKey[] } {
    if (options.resolve) {
      const resolved = options.resolve();
      const models = resolved.models.map((item) => item.trim()).filter(Boolean);
      return {
        models: models.length > 0 ? models : staticModels,
        keys: resolved.keys,
      };
    }
    return { models: staticModels, keys: staticKeys };
  }

  return {
    id: "gemini",
    model,
    classify(input: ClassifyInput) {
      return pool.run(snapshot(), async (modelName, secret) => {
        const thinking = options.thinking ? geminiThinkingConfig(modelName, options.thinking()) : undefined;
        const content = await callGemini(fetchImpl, baseUrl, modelName, secret, input, timeoutMs, thinking);
        const output = parseModelOutput(parseModelJson(content));
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
          ...(output.otp !== undefined ? { otp: output.otp || null } : {}),
          raw: output,
        });
      });
    },
    getKeyPoolStatus() {
      return pool.status(snapshot(), model);
    },
  };
}

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
    otp: {
      type: "STRING",
      nullable: true,
    },
  },
  required: ["label", "confidence", "summary", "tags", "signals"],
};

async function callGemini(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  apiKey: string,
  input: ClassifyInput,
  timeoutMs: number,
  thinking?: { thinkingBudget: number } | { thinkingLevel: string },
): Promise<string> {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
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
      ...(thinking ? { thinkingConfig: thinking } : {}),
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
