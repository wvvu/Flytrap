import { Writable } from "node:stream";
import pino, { type Logger } from "pino";

export interface AppLog {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
  trace(obj: object, msg?: string): void;
}

const REDACT_PATHS = [
  "password",
  "apiPassword",
  "sessionSecret",
  "authorization",
  "cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "secret",
  "apiKey",
  "openaiApiKey",
  "geminiApiKeys",
  "TELEGRAM_BOT_TOKEN",
  "NOTIFY_WEBHOOK_BEARER",
  "API_PASSWORD",
  "SESSION_SECRET",
];

const RECENT_LIMIT = 200;
const recentLines: string[] = [];

export function recentLogs(): string[] {
  return recentLines.slice();
}

export function createLogger(level: string, capture = false): Logger {
  const options = {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (!capture) return pino(options);
  const captureStream = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString("utf8").trim();
      if (text) {
        for (const line of text.split(/\n/)) {
          if (!line) continue;
          recentLines.push(line.slice(0, 500));
        }
        while (recentLines.length > RECENT_LIMIT) recentLines.shift();
      }
      callback();
    },
  });
  return pino(options, pino.multistream([
    { stream: pino.destination(1) },
    { stream: captureStream },
  ]));
}
