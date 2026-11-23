import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { PayloadItem, PortfolioPayload } from "../portfolio/payload";

/**
 * Read-only tools over one member's already-published portfolio payload.
 *
 * The agent can only see what `/p/{slug}` already shows publicly, and it reaches
 * that through these functions rather than through the database. There is no
 * write tool and no network tool, so a prompt injection hidden in a README can
 * change what the agent *says* but cannot make it *do* anything.
 */

const STOP = new Set(
  "a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which who with you your do does did about tell me his her he she they their".split(
    " "
  )
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function haystack(item: PayloadItem) {
  return {
    title: item.title.toLowerCase(),
    skills: item.skills.join(" ").toLowerCase(),
    body: [item.summary, item.description, item.impact ?? "", item.role ?? "", item.kindLabel, item.source]
      .join(" ")
      .toLowerCase(),
  };
}

/** Weighted keyword relevance: title > skills > body. Pure and deterministic. */
export function searchItems(payload: PortfolioPayload, query: string, limit = 5): PayloadItem[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const scored = payload.items
    .map((item) => {
      const h = haystack(item);
      let score = 0;
      for (const t of terms) {
        if (h.title.includes(t)) score += 5;
        if (h.skills.includes(t)) score += 3;
        if (h.body.includes(t)) score += 1;
      }
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

/** Trim an item to what the model needs, with long free text capped. */
export function compactItem(item: PayloadItem) {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return {
    id: item.id,
    title: item.title,
    kind: item.kindLabel,
    source: item.source,
    year: item.year,
    skills: item.skills.slice(0, 10),
    summary: cap(item.summary, 300),
    description: cap(item.description, 900),
    impact: item.impact ? cap(item.impact, 300) : null,
    url: item.url,
  };
}

export type Retrieved = Map<string, PayloadItem>;

export function buildPortfolioTools(payload: PortfolioPayload, retrieved: Retrieved) {
  const remember = (items: PayloadItem[]) => items.forEach((i) => retrieved.set(i.id, i));

  const searchPortfolio = tool(
    async ({ query }) => {
      const hits = searchItems(payload, query);
      remember(hits);
      return JSON.stringify({ results: hits.map(compactItem), note: hits.length ? undefined : "No matching items." });
    },
    {
      name: "search_portfolio",
      description:
        "Search this person's published portfolio items by keywords (technologies, topics, project names). Returns up to 5 items with ids.",
      schema: z.object({ query: z.string().min(1).max(200) }),
    }
  );

  const getItem = tool(
    async ({ id }) => {
      const item = payload.items.find((i) => i.id === id);
      if (!item) return JSON.stringify({ error: "No item with that id." });
      remember([item]);
      return JSON.stringify(compactItem(item));
    },
    {
      name: "get_item",
      description: "Get the full details of one portfolio item by its id.",
      schema: z.object({ id: z.string().min(1).max(100) }),
    }
  );

  const listSections = tool(
    async () =>
      JSON.stringify(
        payload.sections.map((s) => ({
          title: s.title,
          count: s.items.length,
          items: s.items.slice(0, 12).map((i) => ({ id: i.id, title: i.title })),
        }))
      ),
    {
      name: "list_sections",
      description: "List the portfolio's sections and the titles of items in each. Use for broad overview questions.",
      schema: z.object({}),
    }
  );

  const getProfile = tool(
    async () =>
      JSON.stringify({
        name: payload.profile.name,
        headline: payload.profile.headline,
        bio: payload.profile.bio,
        location: payload.profile.location,
        targetRole: payload.profile.targetRole,
        topSkills: payload.skills.slice(0, 20),
        totalItems: payload.counts.items,
      }),
    {
      name: "get_profile",
      description: "Get the person's name, headline, bio, location, and top skills.",
      schema: z.object({}),
    }
  );

  return [searchPortfolio, getItem, listSections, getProfile];
}
