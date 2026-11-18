import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { readEffectiveAiPool } from "../db/repos/settings.js";
import { createGeminiClassifier } from "./gemini.js";
import { createOpenAiClassifier } from "./openai-compat.js";
import { fallbackAiPool } from "./pool.js";
import { buildUserMessage, readPrompt, type ClassifyFacts } from "./prompt.js";
import { scrubSecrets } from "./secret.js";

export interface ProbeKeyInput {
  id?: string;
  secret?: string;
  model?: string;
}

export interface ProbeKeyResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  label?: string;
  error?: string;
}

const PROBE_FACTS: ClassifyFacts = {
  spf: "pass",
  dkim: "pass",
  dmarc: "pass",
  rdns: "match",
  envelopeFrom: "noreply@example.com",
  envelopeTo: ["check@example.com"],
  from: "Service <noreply@example.com>",
  subject: "登录验证码 123456",
  messageId: "probe@example.com",
  text: "验证码 123456，5 分钟内有效。",
  urls: [],
  history: [],
  missingHistory: [],
  attachments: [],
};

export async function probeAiKey(
  db: Db,
  config: Config,
  input: ProbeKeyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeKeyResult> {
  const started = Date.now();
  if (config.classifier === "fake") {
    return {
      ok: true,
      provider: "fake",
      model: "fake",
      latencyMs: 0,
      label: "gray",
    };
  }

  const pool = readEffectiveAiPool(db, fallbackAiPool(config));
  const fallbackKeys = fallbackAiPool(config).keys;
  const allKnown = new Map<string, string>();
  for (const item of pool.keys) allKnown.set(item.id, item.secret);
  for (const item of fallbackKeys) allKnown.set(item.id, item.secret);

  let secret = input.secret?.trim() ?? "";
  if (!secret && input.id) {
    secret = allKnown.get(input.id) ?? "";
  }
  if (!secret && pool.keys[0]) {
    secret = pool.keys[0].secret;
  }

  const defaultModel = config.classifier === "gemini" ? config.geminiModel : (config.openaiModel ?? "");
  const model = (input.model?.trim() || pool.models[0] || defaultModel).trim();

  if (!secret) {
    return {
      ok: false,
      provider: config.classifier,
      model: model || "unset",
      latencyMs: 0,
      error: "未找到可用密钥",
    };
  }
  if (!model) {
    return {
      ok: false,
      provider: config.classifier,
      model: "unset",
      latencyMs: 0,
      error: "未配置模型型号",
    };
  }

  const secrets = [...new Set([secret, ...allKnown.values()])];
  try {
    const systemPrompt = readPrompt(config.promptsDir, "classify-v1", db);
    const userMessage = buildUserMessage(PROBE_FACTS);
    const classifier =
      config.classifier === "gemini"
        ? createGeminiClassifier({
            apiKeys: [secret],
            models: [model],
            baseUrl: config.geminiBaseUrl,
            fetchImpl,
            timeoutMs: 15_000,
          })
        : createOpenAiClassifier({
            baseUrl: config.openaiBaseUrl ?? "",
            apiKey: secret,
            model,
            fetchImpl,
            timeoutMs: 15_000,
          });

    const result = await classifier.classify({
      promptId: "classify-v1",
      systemPrompt,
      userMessage,
      facts: PROBE_FACTS,
    });
    return {
      ok: true,
      provider: config.classifier,
      model,
      latencyMs: Math.max(1, Date.now() - started),
      label: result.label,
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      provider: config.classifier,
      model,
      latencyMs: Math.max(1, Date.now() - started),
      error: scrubSecrets(rawMsg, secrets).slice(0, 200),
    };
  }
}
