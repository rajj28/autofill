import { z } from "zod";

/**
 * Boot-time environment validation.
 *
 * The point is to fail on startup with a readable message instead of failing on
 * the first request with a stack trace from deep inside Prisma or node:crypto.
 * Production is strict; development fills in the docker-compose defaults so a
 * fresh clone still runs with an empty .env.
 */

const isProd = process.env.NODE_ENV === "production";

// A 32-byte key encoded as base64url is 43 chars. We accept anything >= 32
// characters so an operator can paste a long passphrase, but we refuse the
// placeholder strings that ship in .env.example.
const PLACEHOLDERS = [
  "replace-with-a-long-random-string",
  "replace-me",
  "changeme",
  "secret",
  "dev-only-insecure-key",
];

const strongSecret = (label: string) =>
  z
    .string()
    .min(32, `${label} must be at least 32 characters. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
    .refine((v) => !PLACEHOLDERS.includes(v.trim().toLowerCase()), {
      message: `${label} is still set to a placeholder value. Generate a real secret.`,
    });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  // "queue" (default): BullMQ + a separate worker process. "inline": no Redis or
  // worker, syncs and site publishes run inside the request. Use inline on
  // serverless hosts such as Vercel, where a long-running worker cannot exist.
  SYNC_MODE: z.enum(["queue", "inline"]).default("queue"),

  AUTH_SECRET: isProd ? strongSecret("AUTH_SECRET") : z.string().default("dev-secret-not-for-production-use-only"),
  APP_ENCRYPTION_KEY: isProd
    ? strongSecret("APP_ENCRYPTION_KEY")
    : z.string().default("dev-encryption-key-not-for-production"),
  CRON_SECRET: isProd ? strongSecret("CRON_SECRET") : z.string().default("dev-cron-secret-not-for-production"),

  APP_URL: z.string().url("APP_URL must be an absolute URL, e.g. https://example.com").default("http://localhost:3000"),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  // GitHub App: lets members grant write access to one repo with a click
  // instead of creating a personal access token. Register it once as the operator.
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  // PEM, either with literal newlines, "\n" escapes, or base64-encoded.
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),

  GITLAB_CLIENT_ID: z.string().optional(),
  GITLAB_CLIENT_SECRET: z.string().optional(),

  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  // LinkedIn versions its API by month. Pin it so a LinkedIn-side change never
  // silently alters request semantics; bump deliberately.
  LINKEDIN_API_VERSION: z.string().regex(/^\d{6}$/, "LINKEDIN_API_VERSION must be YYYYMM.").default("202608"),

  // ---- LLM (all optional; without a key the heuristic curator runs) ----
  LLM_PROVIDER: z.enum(["openai", "anthropic"]).optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  // Second-pass LLM check that every claim is supported by the source facts.
  CURATION_VERIFY: z.enum(["true", "false"]).default("true"),

  // Public "ask my portfolio" agent.
  AGENT_ENABLED: z.enum(["true", "false"]).default("true"),
  AGENT_RATE_LIMIT: z.coerce.number().int().positive().default(12),
  AGENT_RATE_WINDOW_S: z.coerce.number().int().positive().default(300),
  // Comma-separated origins allowed to call the agent from a browser.
  AGENT_ALLOWED_ORIGINS: z.string().default("https://ruturaj.is-a.dev,http://localhost:5173"),

  SYNC_CONCURRENCY: z.coerce.number().int().positive().max(64).default(4),
  QUEUE_ENQUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  CRON_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(200),

  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  AUTH_RATE_WINDOW_S: z.coerce.number().int().positive().default(300),
});

// Empty strings in a .env file should read as "unset", not as a value. Without
// this, `GITHUB_CLIENT_ID=""` would make the OAuth button appear and then fail.
function compact(source: NodeJS.ProcessEnv) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

const parsed = schema.safeParse(compact(process.env));

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${details}\n`);
}

export const env = parsed.data;

export const githubOAuthConfigured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
/** True only when an operator set REDIS_URL, not when the localhost default applies. */
export const redisConfigured = Boolean(process.env.REDIS_URL?.trim());
export const inlineSync = env.SYNC_MODE === "inline";
export const gitlabOAuthConfigured = Boolean(env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET);
export const githubAppConfigured = Boolean(
  env.GITHUB_APP_ID &&
    env.GITHUB_APP_SLUG &&
    env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET &&
    env.GITHUB_APP_PRIVATE_KEY
);
export const linkedinOAuthConfigured = Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);
