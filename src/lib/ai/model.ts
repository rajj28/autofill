import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { env } from "../env";

/**
 * One place that decides which LLM provider runs.
 *
 * Provider selection: LLM_PROVIDER wins when set; otherwise whichever API key
 * exists (OpenAI first). Returns null when nothing is configured, and every
 * caller treats null as "use the offline heuristic", so the product keeps
 * working with no key at all.
 *
 * Clients are built lazily and cached: constructing one per evidence item
 * would rebuild an HTTP agent for every record in a sync.
 */

export type Provider = "openai" | "anthropic";

export function resolveProvider(): Provider | null {
  if (env.LLM_PROVIDER === "openai" && env.OPENAI_API_KEY) return "openai";
  if (env.LLM_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.LLM_PROVIDER) return null; // explicit choice without its key: do not silently switch vendor
  if (env.OPENAI_API_KEY) return "openai";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function modelName(provider: Provider | null = resolveProvider()): string {
  if (provider === "openai") return env.OPENAI_MODEL;
  if (provider === "anthropic") return env.ANTHROPIC_MODEL;
  return "heuristic";
}

const cache = new Map<string, BaseChatModel>();

export async function getChatModel(opts: { temperature?: number } = {}): Promise<BaseChatModel | null> {
  const provider = resolveProvider();
  if (!provider) return null;
  const temperature = opts.temperature ?? 0.2;
  const key = `${provider}:${temperature}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let model: BaseChatModel;
  if (provider === "openai") {
    const { ChatOpenAI } = await import("@langchain/openai");
    model = new ChatOpenAI({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      temperature,
      timeout: env.LLM_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
    });
  } else {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    model = new ChatAnthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL,
      temperature,
      maxRetries: env.LLM_MAX_RETRIES,
      clientOptions: { timeout: env.LLM_TIMEOUT_MS },
    });
  }
  cache.set(key, model);
  return model;
}
