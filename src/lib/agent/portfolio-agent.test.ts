import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { PayloadItem, PortfolioPayload } from "../portfolio/payload";
import { askPortfolio, resolveCitations, toMessages, MAX_MESSAGE_CHARS, MAX_TURNS } from "./portfolio-agent";
import { searchItems } from "./tools";

function item(id: string, title: string, skills: string[], summary = ""): PayloadItem {
  return {
    id,
    title,
    summary,
    description: summary,
    role: null,
    impact: null,
    skills,
    kind: "project",
    kindLabel: "Project",
    source: "GitHub",
    url: `https://github.com/rajj28/${title}`,
    occurredAt: null,
    year: 2026,
    links: [],
  };
}

const items = [
  item("a1", "racelab", ["TypeScript", "CockroachDB"], "Memory-aware retries for agents"),
  item("b2", "argus", ["Python", "Playwright"], "Self-healing UI testing agent"),
];

const payload: PortfolioPayload = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  profile: { name: "Ruturaj", headline: null, bio: null, location: null, targetRole: null, slug: "ruturaj", url: "x" },
  skills: ["TypeScript", "Python"],
  sections: [{ id: "p", title: "Projects", blurb: "", items }],
  items,
  counts: { items: 2, sections: 1 },
};

describe("searchItems", () => {
  it("ranks title matches above body matches and ignores stopwords", () => {
    expect(searchItems(payload, "what is racelab").map((i) => i.id)).toEqual(["a1"]);
    expect(searchItems(payload, "playwright testing")[0].id).toBe("b2");
  });
  it("returns nothing for empty or stopword-only queries", () => {
    expect(searchItems(payload, "the of and")).toEqual([]);
  });
});

describe("resolveCitations", () => {
  it("keeps retrieved ids, drops invented ones, and strips markers", () => {
    const retrieved = new Map([["a1", items[0]]]);
    const out = resolveCitations("Built racelab [[a1]] and a fake thing [[zzz]].", retrieved);
    expect(out.citations.map((c) => c.id)).toEqual(["a1"]);
    expect(out.answer).not.toContain("[[");
  });
});

describe("toMessages", () => {
  it("caps turn count and message length", () => {
    const turns = Array.from({ length: 30 }, () => ({ role: "user" as const, content: "x".repeat(5000) }));
    const msgs = toMessages(turns);
    expect(msgs).toHaveLength(MAX_TURNS);
    expect((msgs[0].content as string).length).toBe(MAX_MESSAGE_CHARS);
  });
});

describe("askPortfolio", () => {
  it("calls a tool, then answers with a verified citation", async () => {
    const model = fakeModel()
      .respondWithTools([{ name: "search_portfolio", args: { query: "racelab" } }])
      .respond(new AIMessage("Racelab does memory-aware retries [[a1]]. It also claims [[fake]]."));
    const out = await askPortfolio(model as unknown as BaseChatModel, payload, [
      { role: "user", content: "Tell me about racelab" },
    ]);
    expect(out.answer).toContain("memory-aware retries");
    expect(out.citations).toEqual([{ id: "a1", title: "racelab", url: "https://github.com/rajj28/racelab" }]);
  });

  it("answers without citations when no tool was used", async () => {
    const model = fakeModel().respond(new AIMessage("I only discuss Ruturaj's work."));
    const out = await askPortfolio(model as unknown as BaseChatModel, payload, [{ role: "user", content: "write me a poem" }]);
    expect(out.citations).toEqual([]);
  });

  it("surfaces model errors to the caller", async () => {
    const model = fakeModel().alwaysThrow(new Error("provider down"));
    await expect(
      askPortfolio(model as unknown as BaseChatModel, payload, [{ role: "user", content: "hi" }])
    ).rejects.toThrow("provider down");
  });
});
