import { notifyPayload, type Notifier, type NotifyInput } from "./types.js";
import { validateWebhookUrl } from "./url-guard.js";

export function createWebhookNotifier(options: {
  url: string;
  bearer?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  blockPrivate?: boolean;
}): Notifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    id: "webhook",
    async notify(input: NotifyInput) {
      try {
        const targetUrl = options.blockPrivate
          ? validateWebhookUrl(options.url, { blockPrivate: true })
          : options.url;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
        const init: RequestInit = {
          method: "POST",
          headers,
          body: JSON.stringify(notifyPayload(input)),
          signal: AbortSignal.timeout(timeoutMs),
        };
        if (options.blockPrivate) init.redirect = "error";
        const response = await fetchImpl(targetUrl, init);
        if (!response.ok) throw new Error(`webhook ${response.status}`);
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.startsWith("webhook ") ||
            err.message === "forbidden webhook url" ||
            err.message === "invalid webhook url")
        ) {
          throw err;
        }
        throw new Error("webhook request failed");
      }
    },
  };
}
