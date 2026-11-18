import { scrubSecrets } from "./secret.js";

export interface ProbeKeyInput {
  classifier: "gemini" | "openai-compat" | "fake";
  secret: string;
  model: string;
  geminiBaseUrl?: string;
  openaiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProbeKeyResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  error?: string;
}

/**
 * Send a minimal completion probe with a stored API key to verify connectivity
 * and measure round-trip latency. Secrets are scrubbed from any error string.
 */
export async function probeAiKey(input: ProbeKeyInput): Promise<ProbeKeyResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 12_000;
  const secret = input.secret.trim();
  const started = Date.now();

  if (input.classifier === "fake") {
    return { ok: true, model: "fake", latencyMs: Math.max(1, Date.now() - started) };
  }

  if (input.classifier === "gemini") {
    const model = input.model.trim() || "gemini-2.5-flash";
    const baseUrl = (input.geminiBaseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(secret)}`;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 8, temperature: 0 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Math.max(1, Date.now() - started);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const clean = scrubSecrets(detail.slice(0, 180), [secret]).replace(/\s+/g, " ").trim();
        return {
          ok: false,
          model,
          latencyMs,
          error: clean ? `HTTP ${response.status}: ${clean}` : `HTTP ${response.status}`,
        };
      }
      await response.json().catch(() => ({}));
      return { ok: true, model, latencyMs };
    } catch (err) {
      const latencyMs = Math.max(1, Date.now() - started);
      const raw = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        model,
        latencyMs,
        error: scrubSecrets(raw, [secret]).slice(0, 180),
      };
    }
  }

  const model = input.model.trim() || "gpt-4o-mini";
  const baseUrl = (input.openaiBaseUrl || "").replace(/\/$/, "");
  if (!baseUrl) {
    return { ok: false, model, latencyMs: 0, error: "OPENAI_BASE_URL is not set" };
  }
  const endpoint = `${baseUrl}/chat/completions`;
  try {
    const response = await fetchImpl(endpoint, {
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
    const latencyMs = Math.max(1, Date.now() - started);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const clean = scrubSecrets(detail.slice(0, 180), [secret]).replace(/\s+/g, " ").trim();
      return {
        ok: false,
        model,
        latencyMs,
        error: clean ? `HTTP ${response.status}: ${clean}` : `HTTP ${response.status}`,
      };
    }
    await response.json().catch(() => ({}));
    return { ok: true, model, latencyMs };
  } catch (err) {
    const latencyMs = Math.max(1, Date.now() - started);
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      model,
      latencyMs,
      error: scrubSecrets(raw, [secret]).slice(0, 180),
    };
  }
}
