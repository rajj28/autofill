import type { DiscoveredItem } from "../sources/types";
import { curateHeuristic, type CurationResult } from "./heuristic";
import { runCurationGraph, toCurationResult, type StructuredModel } from "./graph";
import { getChatModel, modelName, resolveProvider } from "../ai/model";
import { env } from "../env";
import { logger } from "../logger";

/** Adapt a LangChain chat model to the small surface the graph needs. */
async function structuredModel(): Promise<StructuredModel | null> {
  const chat = await getChatModel({ temperature: 0.2 });
  if (!chat) return null;
  return {
    async structured(schema, messages) {
      // withStructuredOutput uses the provider's native tool/JSON-schema mode and
      // validates against the zod schema, so malformed output throws here instead
      // of leaking half-parsed JSON downstream.
      const runnable = chat.withStructuredOutput(schema as never);
      return (await runnable.invoke(messages)) as never;
    },
  };
}

/**
 * Curate one item. Always resolves: any LLM failure (timeout, quota, malformed
 * output) degrades to the heuristic curator so a sync never stalls on a provider.
 */
export async function curateItem(item: DiscoveredItem, targetRole?: string): Promise<CurationResult> {
  const fallback = curateHeuristic(item, targetRole);
  if (!resolveProvider()) return fallback;

  try {
    const model = await structuredModel();
    if (!model) return fallback;
    const { draft, revisions } = await runCurationGraph(model, item, targetRole, {
      verify: env.CURATION_VERIFY === "true",
    });
    logger.info("ai_curation_done", { sourceType: item.sourceType, revisions, uncertain: draft.uncertainFields.length });
    return toCurationResult(draft, modelName());
  } catch (error) {
    logger.warn("ai_curation_failed_using_heuristic", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return fallback;
  }
}
