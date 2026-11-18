import { scrubSecrets } from "./secret.js";

export interface ProbeKeyInput {
  classifier: "gemini" | "openai-compat" | "fake";
  secret: string;
  allSecrets?: readonly string[];
  model: string;
  geminiBaseUrl?: string;
  openaiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface ProbeKeyResult {
  ok: boolean;
  latencyMs: number;
  provider: string;
  model: string;
  error?: string;
}

/**
 * Send the smallest possible completion request to verify that a stored or candidate
 * API key and model pair can reach the upstream provider. Secrets are scrubbed from errors.
 */
export async function probeAiKey(input: ProbeKeyInput): Promise<ProbeKeyResult> {
  const now = input.now ?? Date.now;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 12_000;
  const started = now();
  const secrets = [input.secret, ...(input.allSecrets ?? [])].filter(Boolean);

  if (input.classifier === "fake") {
    return {
      ok: true,
      latencyMs: Math.max(1, now() - started),
      provider: "fake",
      model: "fake",
    };
  }

  const secret = input.secret.trim();
  const model = input.model.trim();
  if (!secret) {
    return { ok: false, latencyMs: 0, provider: input.classifier, model, error: "missing api key" };
  }
  if (!model) {
    return { ok: false, latencyMs: 0, provider: input.classifier, model: "", error: "missing model" };
  }

  try {
    if (input.classifier === "gemini") {
      const base = (input.geminiBaseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
      const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(secret)}`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 8, temperature: 0 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Math.max(1, now() - started);
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const msg = scrubSecrets(`HTTP ${res.status} ${detail}`.trim(), secrets).slice(0, 220);
        return { ok: false, latencyMs, provider: "gemini", model, error: msg };
      }
      return { ok: true, latencyMs, provider: "gemini", model };
    }

    const base = (input.openaiBaseUrl || "").replace(/\/$/, "");
    if (!base) {
      return { ok: false, latencyMs: 0, provider: "openai-compat", model, error: "OPENAI_BASE_URL not set" };
    }
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        temperature: 0,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.max(1, now() - started);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const msg = scrubSecrets(`HTTP ${res.status} ${detail}`.trim(), secrets).slice(0, 220);
      return { ok: false, latencyMs, provider: "openai-compat", model, error: msg };
    }
    return { ok: true, latencyMs, provider: "openai-compat", model };
  } catch (err) {
    const latencyMs = Math.max(1, now() - started);
    const rawMsg = err instanceof Error ? err.message : String(err);
    const cleanMsg = scrubSecrets(rawMsg, secrets).slice(0, 220);
    return {
      ok: false,
      latencyMs,
      provider: input.classifier,
      model,
      error: cleanMsg || "connection failed",
    };
  }
}
