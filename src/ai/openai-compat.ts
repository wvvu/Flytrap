import { scrubSecrets } from "./secret.js";
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
}

export function createOpenAiClassifier(options: OpenAiCompatOptions): Classifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    id: "openai-compat",
    model: options.model ?? "",
    async classify(input) {
      const pool = options.resolve
        ? options.resolve()
        : {
            models: options.model ? [options.model] : [],
            keys: options.apiKey ? [{ id: "static", secret: options.apiKey }] : [],
          };
      const models = pool.models.map((item) => item.trim()).filter(Boolean);
      const keys = pool.keys.map((item) => ({ ...item, secret: item.secret.trim() })).filter((item) => item.secret);
      if (models.length === 0 || keys.length === 0) throw new Error("no api key configured");
      const secrets = keys.map((item) => item.secret);
      let lastErr: Error | null = null;
      for (const modelName of models) {
        let modelRejected = false;
        for (const key of keys) {
          try {
            const content = await complete(fetchImpl, options.baseUrl, key.secret, modelName, input, timeoutMs);
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
              raw: output,
            });
          } catch (err) {
            const message = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
            lastErr = new Error(message);
            if (message.includes("429") || message.includes("503")) continue;
            if (message.includes("404") || /not found/i.test(message)) {
              modelRejected = true;
              break;
            }
            throw lastErr;
          }
        }
        if (modelRejected) continue;
        break;
      }
      throw lastErr || new Error("openai all attempts failed");
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
  if (!response.ok) throw new Error(`openai ${response.status}`);
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
