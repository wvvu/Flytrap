import type { Config } from "../config.js";

export interface PoolKey {
  id: string;
  secret: string;
}

export interface AiPoolSnapshot {
  models: string[];
  keys: PoolKey[];
}

/** Keys and models from the process environment. The panel never receives the secret. */
export function fallbackAiPool(config: Config): AiPoolSnapshot {
  if (config.classifier === "gemini") {
    return {
      models: [config.geminiModel || "gemini-2.5-flash"],
      keys: config.geminiApiKeys.map((secret, index) => ({ id: `env:${index}`, secret })),
    };
  }
  if (config.classifier === "openai-compat") {
    return {
      models: config.openaiModel ? [config.openaiModel] : [],
      keys: config.openaiApiKey ? [{ id: "env:0", secret: config.openaiApiKey }] : [],
    };
  }
  return { models: [], keys: [] };
}
