export interface NotifyInput {
  messageId: string;
  subject: string | null;
  from: string | null;
  label: string;
  confidence: number;
  summary: string;
  otp?: string | null;
  fallback?: boolean;
  panelUrl: string;
}

export interface Notifier {
  id: string;
  notify(input: NotifyInput): Promise<void>;
}

export function notifyPayload(input: NotifyInput): {
  id: string;
  subject: string | null;
  from: string | null;
  label: string;
  confidence: number;
  summary: string;
  otp: string | null;
  url: string;
} {
  return {
    id: input.messageId,
    subject: input.subject,
    from: input.from,
    label: input.label,
    confidence: input.confidence,
    summary: input.summary,
    otp: input.otp ?? null,
    url: input.panelUrl,
  };
}

export function notifyText(input: NotifyInput): string {
  const otp = typeof input.otp === "string" ? input.otp.trim() : "";
  const header =
    input.fallback || input.label === "unclassified"
      ? "[未分类 / AI异常]"
      : `[${input.label}] (${input.confidence.toFixed(2)})`;
  return [
    otp ? `验证码: ${otp}` : "",
    header,
    input.subject ? `Subject: ${input.subject}` : "",
    input.from ? `From: ${input.from}` : "",
    input.summary,
    input.panelUrl,
  ]
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 4000);
}
