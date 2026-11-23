import { describe, expect, it } from "vitest";
import { checkGrounding } from "../ai/grounding";
import { MAX_REVISIONS, UNVERIFIED_CONFIDENCE_CAP, runCurationGraph, type Draft, type StructuredModel } from "./graph";
import type { DiscoveredItem } from "../sources/types";

const item: DiscoveredItem = {
  sourceType: "github",
  kind: "project",
  externalId: "1",
  title: "racelab",
  summary: "Memory-aware retries for serialization conflicts",
  url: "https://github.com/rajj28/racelab",
  occurredAt: new Date("2026-09-01T00:00:00Z"),
  payload: { stars: 12, language: "TypeScript" },
} as DiscoveredItem;

const base: Draft = {
  recommendation: "add",
  confidence: 90,
  significance: 85,
  roleRelevance: 80,
  whyItMatters: "Handles serialization conflicts in agent workflows.",
  skills: ["TypeScript"],
  potentialImpact: "Shows agent memory design.",
  suggestedTitle: "racelab",
  suggestedDescription: "Memory-aware retries. 12 stars.",
  evidenceNotes: "From GitHub.",
  uncertainFields: [],
};

/** Scripted model: returns queued responses in order and records every call. */
function scripted(responses: unknown[]) {
  const calls: string[] = [];
  const model: StructuredModel = {
    async structured(_schema, messages) {
      calls.push(messages[0].content.slice(0, 20));
      if (!responses.length) throw new Error("script exhausted");
      return responses.shift() as never;
    },
  };
  return { model, calls };
}

describe("grounding", () => {
  it("accepts numbers present in the facts and rejects invented ones", () => {
    expect(checkGrounding("12 stars", '{"stars":12}').ok).toBe(true);
    expect(checkGrounding("40% faster", '{"stars":12}').ungroundedNumbers).toEqual(["40%"]);
  });
  it("does not ground 40 by 1400", () => {
    expect(checkGrounding("40 users", "1400 users").ok).toBe(false);
  });
  it("matches 1,200 with 1200 and 70% with 70", () => {
    expect(checkGrounding("1,200 downloads", "downloads: 1200").ok).toBe(true);
    expect(checkGrounding("70%", "score 70").ok).toBe(true);
  });
  it("flags URLs missing from the facts", () => {
    expect(checkGrounding("see https://evil.example/x", "https://github.com/a/b").ungroundedUrls).toHaveLength(1);
  });
});

describe("curation graph", () => {
  it("passes a clean draft through with one draft call and one verify call", async () => {
    const { model, calls } = scripted([base, { unsupportedClaims: [] }]);
    const out = await runCurationGraph(model, item, undefined, { verify: true });
    expect(calls).toHaveLength(2);
    expect(out.revisions).toBe(0);
    expect(out.draft.confidence).toBe(90);
    expect(out.draft.uncertainFields).toEqual([]);
  });

  it("revises when the draft invents a number, and keeps the clean revision", async () => {
    const bad = { ...base, suggestedDescription: "Cut latency by 63%." };
    const fixed = { ...base, suggestedDescription: "Memory-aware retries." };
    const { model } = scripted([bad, { unsupportedClaims: [] }, fixed, { unsupportedClaims: [] }]);
    const out = await runCurationGraph(model, item, undefined, { verify: true });
    expect(out.revisions).toBe(1);
    expect(out.draft.suggestedDescription).toBe("Memory-aware retries.");
    expect(out.draft.uncertainFields).toEqual([]);
  });

  it("caps confidence and flags uncertainty when the revision is still unsupported", async () => {
    const bad = { ...base, suggestedDescription: "Cut latency by 63%." };
    const { model } = scripted([bad, { unsupportedClaims: [] }, bad, { unsupportedClaims: [] }]);
    const out = await runCurationGraph(model, item, undefined, { verify: true });
    expect(out.revisions).toBe(MAX_REVISIONS);
    expect(out.draft.confidence).toBeLessThanOrEqual(UNVERIFIED_CONFIDENCE_CAP);
    expect(out.draft.uncertainFields.join(" ")).toContain("63%");
  });

  it("treats LLM verifier findings as issues", async () => {
    const { model } = scripted([
      base,
      { unsupportedClaims: ["used at Google"] },
      base,
      { unsupportedClaims: ["used at Google"] },
    ]);
    const out = await runCurationGraph(model, item, undefined, { verify: true });
    expect(out.draft.uncertainFields).toContain("unsupported claim: used at Google");
  });

  it("skips the verifier when disabled", async () => {
    const { model, calls } = scripted([base]);
    await runCurationGraph(model, item, undefined, { verify: false });
    expect(calls).toHaveLength(1);
  });

  it("propagates model errors so curateItem can fall back", async () => {
    const { model } = scripted([]);
    await expect(runCurationGraph(model, item, undefined, { verify: true })).rejects.toThrow();
  });
});
