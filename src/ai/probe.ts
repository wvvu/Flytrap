import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { readAiThinking, readEffectiveAiPool } from "../db/repos/settings.js";
import { createGeminiClassifier } from "./gemini.js";
import { createOpenAiClassifier } from "./openai-compat.js";
import { fallbackAiPool } from "./pool.js";
import { buildUserMessage, type ClassifyFacts } from "./prompt.js";
import { scrubSecrets } from "./secret.js";

export interface ProbeKeyInput {
  config: Config;
  db: Db;
  keyId?: string;
  secret?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProbeKeyResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  label?: string;
  error?: string;
}

const PROBE_SYSTEM_PROMPT =
  "Return one JSON object only: {\"label\":\"legit\",\"confidence\":0.95,\"summary\":\"连通性探测正常\",\"tags\":[\"probe\"],\"signals\":[]}";

const PROBE_FACTS: ClassifyFacts = {
  spf: "pass",
  dkim: "pass",
  dmarc: "pass",
  rdns: "match",
  envelopeFrom: "probe@example.com",
  envelopeTo: ["inbox@example.com"],
  from: "probe@example.com",
  subject: "Connectivity check",
  messageId: "probe@example.com",
  text: "Verification code 123456.",
  urls: [],
  history: [],
  missingHistory: [],
  attachments: [],
};

export async function probeAiKey(input: ProbeKeyInput): Promise<ProbeKeyResult> {
  const started = Date.now();
  const pool = readEffectiveAiPool(input.db, fallbackAiPool(input.config));
  let secret = input.secret?.trim() ?? "";
  if (!secret && input.keyId) {
    const matched = pool.keys.find((item) => item.id === input.keyId);
    secret = matched?.secret ?? "";
  }
  const fallbackModel =
    input.config.classifier === "gemini"
      ? input.config.geminiModel
      : input.config.openaiModel ?? "";
  const chosenModel = (input.model?.trim() || pool.models[0] || fallbackModel || "fake").trim();

  if (input.config.classifier === "fake") {
    return {
      ok: true,
      provider: "fake",
      model: "fake",
      latencyMs: Math.max(1, Date.now() - started),
      label: "legit",
    };
  }

  if (!secret) {
    return {
      ok: false,
      provider: input.config.classifier,
      model: chosenModel,
      latencyMs: 0,
      error: "未找到对应的密钥",
    };
  }

  const allSecrets = [secret, ...pool.keys.map((k) => k.secret)];
  try {
    const classifier =
      input.config.classifier === "gemini"
        ? createGeminiClassifier({
            apiKeys: [secret],
            models: [chosenModel],
            baseUrl: input.config.geminiBaseUrl,
            thinking: () => readAiThinking(input.db),
            fetchImpl: input.fetchImpl,
            timeoutMs: input.timeoutMs ?? 15_000,
          })
        : createOpenAiClassifier({
            baseUrl: input.config.openaiBaseUrl ?? "",
            apiKey: secret,
            model: chosenModel,
            fetchImpl: input.fetchImpl,
            timeoutMs: input.timeoutMs ?? 15_000,
          });

    const res = await classifier.classify({
      promptId: "probe",
      systemPrompt: PROBE_SYSTEM_PROMPT,
      userMessage: buildUserMessage(PROBE_FACTS),
      facts: PROBE_FACTS,
    });
    return {
      ok: true,
      provider: input.config.classifier,
      model: res.model || chosenModel,
      latencyMs: Math.max(1, Date.now() - started),
      label: res.label,
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const clean = scrubSecrets(rawMsg, allSecrets).slice(0, 220);
    return {
      ok: false,
      provider: input.config.classifier,
      model: chosenModel,
      latencyMs: Math.max(1, Date.now() - started),
      error: clean || "请求失败",
    };
  }
}
