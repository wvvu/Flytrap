import { createKeyPool, type AiPoolSnapshot } from "./pool.js";
import { finalizeAiResult, parseModelJson, parseModelOutput } from "./types.js";
import type { Classifier, ClassifyInput } from "./classifier.js";

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  resolve?: () => { models: string[]; keys: Array<{ id: string; secret: string }> };
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cooldownMs?: number;
}

export function createOpenAiClassifier(options: OpenAiCompatOptions): Classifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pool = createKeyPool({
    provider: "openai",
    cooldownMs: options.cooldownMs,
    now,
  });

  function snapshot(): AiPoolSnapshot {
    if (options.resolve) return options.resolve();
    return {
      models: options.model ? [options.model] : [],
      keys: options.apiKey ? [{ id: "static", secret: options.apiKey }] : [],
    };
  }

  return {
    id: "openai-compat",
    model: options.model ?? "",
    classify(input) {
      return pool.run(snapshot(), async (modelName, secret) => {
        const content = await complete(fetchImpl, options.baseUrl, secret, modelName, input, timeoutMs);
        const output = parseModelOutput(parseModelJson(content));
        return finalizeAiResult({
          schema: 1,
          prompt_id: input.promptId,
          model: modelName,
          provider: "openai-compat",
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
  };
}

async function complete(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  model: string,
  input: ClassifyInput,
  timeoutMs: number,
): Promise<string> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const messages = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.userMessage },
  ];
  let response = await post(fetchImpl, endpoint, apiKey, { model, temperature: 0, response_format: { type: "json_object" }, messages }, timeoutMs);
  if (response.status === 400) {
    response = await post(fetchImpl, endpoint, apiKey, { model, temperature: 0, messages }, timeoutMs);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail ? `openai ${response.status}: ${detail.slice(0, 300)}` : `openai ${response.status}`);
  }
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) throw new Error("openai empty completion");
  return content;
}

function post(fetchImpl: typeof fetch, endpoint: string, apiKey: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
