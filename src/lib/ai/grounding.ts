/**
 * Deterministic grounding check.
 *
 * The product promise is "no invented numbers". An LLM verifier is useful but
 * it is itself an LLM, so the hard guarantee comes from this pure function:
 * every number, percentage, and URL in generated prose must appear in the facts
 * the model was given. Anything that does not is reported, never trusted.
 */

const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?(?:\s?(?:%|k|K|M|B|x|×))?/g;
const URL_RE = /https?:\/\/[^\s)"'<>]+/g;

function normaliseNumber(raw: string): string {
  return raw.replace(/[\s,]/g, "").toLowerCase();
}

/** Single digits ("3 steps", "2 modes") carry no checkable claim. */
function isTrivial(token: string): boolean {
  const n = normaliseNumber(token);
  if (/^\d$/.test(n)) return true;
  return false;
}

export function extractClaims(text: string): { numbers: string[]; urls: string[] } {
  const urls = [...new Set(text.match(URL_RE) ?? [])].map((u) => u.replace(/[.,;]+$/, ""));
  // Strip URLs first so digits inside them are not double-counted as numeric claims.
  const withoutUrls = text.replace(URL_RE, " ");
  const numbers = [...new Set((withoutUrls.match(NUMBER_RE) ?? []).filter((t) => !isTrivial(t)))];
  return { numbers, urls };
}

export type GroundingReport = {
  ungroundedNumbers: string[];
  ungroundedUrls: string[];
  ok: boolean;
};

export function checkGrounding(generated: string, facts: string): GroundingReport {
  const claims = extractClaims(generated);
  const factsLower = facts.toLowerCase();
  // Whole-token comparison on the numeric core: "40" must not be "grounded" by
  // "1400", while "70%" may be grounded by a fact that says 70.
  const core = (t: string) => normaliseNumber(t).replace(/(%|k|m|b|x|×)$/, "");
  const factNumbers = new Set((facts.match(NUMBER_RE) ?? []).map(core));

  const ungroundedNumbers = claims.numbers.filter((n) => !factNumbers.has(core(n)));
  const ungroundedUrls = claims.urls.filter((u) => !factsLower.includes(u.toLowerCase().replace(/\/$/, "")));

  return {
    ungroundedNumbers,
    ungroundedUrls,
    ok: ungroundedNumbers.length === 0 && ungroundedUrls.length === 0,
  };
}
