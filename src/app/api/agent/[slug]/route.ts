import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/ratelimit";
import { getChatModel, resolveProvider } from "@/lib/ai/model";
import { loadPayloadBySlug } from "@/lib/portfolio/payload";
import { askPortfolio, MAX_MESSAGE_CHARS, MAX_TURNS } from "@/lib/agent/portfolio-agent";

/**
 * Public "ask this portfolio" endpoint.
 *
 * Unlike the read-only feed, every request here costs LLM money, so it is NOT
 * CORS-open: only origins in AGENT_ALLOWED_ORIGINS get CORS headers. (CORS is a
 * browser rule, not authentication. The per-IP rate limit and the hard model-call
 * caps inside the agent are what actually bound spend.)
 */

export const maxDuration = 60;

const MAX_BODY_BYTES = 16_000;
const REQUEST_TIMEOUT_MS = 40_000;

const Body = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(MAX_MESSAGE_CHARS),
      })
    )
    .min(1)
    .max(MAX_TURNS),
});

function allowedOrigins() {
  return env.AGENT_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function corsFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const base = { Vary: "Origin" };
  if (origin && allowedOrigins().includes(origin)) {
    return {
      ...base,
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "600",
    };
  }
  return base;
}

function clientIp(request: Request): string {
  // Vercel and most proxies set x-forwarded-for; the first hop is the client.
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] || request.headers.get("x-real-ip") || "unknown").trim();
}

function json(request: Request, body: unknown, status: number, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...corsFor(request), "cache-control": "no-store", ...extra } });
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsFor(request) });
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (env.AGENT_ENABLED !== "true" || !resolveProvider()) {
    return json(request, { error: "The portfolio assistant is not available." }, 503);
  }

  // Browsers always send Origin on cross-origin POSTs. Reject disallowed ones
  // outright so a random site cannot use a visitor's browser to burn our quota.
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins().includes(origin) && origin !== new URL(env.APP_URL).origin) {
    return json(request, { error: "Origin not allowed." }, 403);
  }

  const limit = await rateLimit("agent", clientIp(request), env.AGENT_RATE_LIMIT, env.AGENT_RATE_WINDOW_S);
  if (!limit.ok) {
    return json(request, { error: "Too many questions. Try again shortly." }, 429, {
      "retry-after": String(limit.retryAfterSeconds),
    });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json(request, { error: "Request too large." }, 413);

  let parsed;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(request, { error: "Request too large." }, 413);
    parsed = Body.safeParse(JSON.parse(text));
  } catch {
    return json(request, { error: "Invalid JSON." }, 400);
  }
  if (!parsed.success) return json(request, { error: "Invalid request." }, 400);
  if (parsed.data.messages[parsed.data.messages.length - 1].role !== "user") {
    return json(request, { error: "Last message must be from the user." }, 400);
  }

  const { slug } = await params;
  const payload = await loadPayloadBySlug(slug, env.APP_URL);
  // Same answer for private and missing portfolios, as in the feed endpoint.
  if (!payload || payload.counts.items === 0) return json(request, { error: "Not found" }, 404);

  const started = Date.now();
  try {
    const model = await getChatModel({ temperature: 0.1 });
    if (!model) return json(request, { error: "The portfolio assistant is not available." }, 503);
    const result = await askPortfolio(model, payload, parsed.data.messages, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    logger.info("agent_answered", { slug, ms: Date.now() - started, citations: result.citations.length });
    return json(request, result, 200);
  } catch (error) {
    logger.error("agent_failed", { slug, ms: Date.now() - started, message: error instanceof Error ? error.message : "unknown" });
    return json(request, { error: "The assistant could not answer right now." }, 502);
  }
}
