import type { Notifier, NotifyInput } from "./types.js";

const LABEL_CN: Record<string, string> = {
  legit: "正常",
  spam: "垃圾",
  phish: "钓鱼",
  malware: "恶意",
  "unsolicited-admin": "推广",
  gray: "待看",
};

export interface BarkPayload {
  title: string;
  subtitle?: string;
  body: string;
  url: string;
  group?: string;
  copy?: string;
  level?: "timeSensitive";
}

export function isBarkUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return host === "api.day.app" || host.endsWith(".day.app");
  } catch {
    return false;
  }
}

function cleanOtpCopy(code: string): string {
  const text = code.trim();
  if (/^\d+(?:[\s-]\d+)+$/.test(text)) return text.replace(/[\s-]+/g, "");
  return text;
}

function normalizeBarkEndpoint(raw: string): { endpoint: string; hasGroupParam: boolean } {
  const parsed = new URL(raw);
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return {
    endpoint: parsed.toString(),
    hasGroupParam: parsed.searchParams.has("group"),
  };
}

export function barkPayload(input: NotifyInput, options: { defaultGroup?: string } = {}): BarkPayload {
  const subject = (input.subject ?? "").trim() || "(无主题)";
  const otp = typeof input.otp === "string" ? input.otp.trim() : "";
  let title: string;
  if (otp) {
    title = `[验证码 ${otp}] ${subject}`;
  } else if (input.label && input.label !== "legit") {
    title = `[${LABEL_CN[input.label] ?? input.label}] ${subject}`;
  } else {
    title = subject;
  }

  const body = (input.summary || subject).trim().slice(0, 1500);
  const payload: BarkPayload = {
    title: title.slice(0, 200),
    body,
    url: input.panelUrl,
  };
  const from = (input.from ?? "").trim();
  if (from) payload.subtitle = from.slice(0, 160);
  if (options.defaultGroup) payload.group = options.defaultGroup;
  if (otp) payload.copy = cleanOtpCopy(otp);
  if (input.label === "phish" || input.label === "malware") {
    payload.level = "timeSensitive";
  }
  return payload;
}

export function createBarkNotifier(options: {
  url: string;
  bearer?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Notifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    id: "bark",
    async notify(input: NotifyInput) {
      try {
        const { endpoint, hasGroupParam } = normalizeBarkEndpoint(options.url);
        const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
        if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(barkPayload(input, hasGroupParam ? {} : { defaultGroup: "Flytrap" })),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`bark ${response.status}`);
      } catch (err) {
        if (err instanceof Error && /^bark \d+$/.test(err.message)) {
          throw err;
        }
        throw new Error("bark request failed");
      }
    },
  };
}
