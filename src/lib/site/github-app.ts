import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { prisma } from "../db";
import { decryptSecret } from "../crypto";
import { env } from "../env";

/**
 * GitHub App access for writing to a member's site repo.
 *
 * The operator registers ONE GitHub App. A member installs it on a single
 * repository with a click; we then mint short-lived (1 hour) installation
 * tokens on demand. No member ever creates, pastes, or stores a token, and the
 * grant is scoped to the repositories they picked during install.
 */

/** Accepts a PEM with real newlines, "\n" escapes (typical in env files), or base64. */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("BEGIN")) return trimmed.replace(/\\n/g, "\n");
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (decoded.includes("BEGIN")) return decoded;
  throw new Error("GITHUB_APP_PRIVATE_KEY is neither a PEM nor a base64-encoded PEM.");
}

/** Mint a fresh installation access token. */
export async function installationToken(installationId: number): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error("GitHub App is not configured.");
  const auth = createAppAuth({
    appId: env.GITHUB_APP_ID,
    privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
    installationId,
  });
  const { token } = await auth({ type: "installation" });
  return token;
}

/**
 * Exchange the `code` GitHub appends to the setup redirect for a user token.
 * Requires "Request user authorization (OAuth) during installation" on the App.
 */
export async function exchangeUserCode(code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(json.error || "GitHub did not return a user token.");
  return json.access_token;
}

/**
 * Prove the signed-in GitHub user can actually see this installation.
 *
 * Without this check, `installation_id` in the redirect is attacker-controlled:
 * anyone could submit another account's installation id and then have us write
 * into that account's repositories. Asking GitHub, with the user's own token,
 * which installations they can access closes that hole.
 */
export async function userCanAccessInstallation(
  userToken: string,
  installationId: number
): Promise<{ ok: true; accountLogin: string } | { ok: false }> {
  const octokit = new Octokit({ auth: userToken });
  for await (const page of octokit.paginate.iterator(octokit.rest.apps.listInstallationsForAuthenticatedUser, {
    per_page: 100,
  })) {
    for (const inst of page.data) {
      if (inst.id === installationId && inst.app_id === Number(env.GITHUB_APP_ID)) {
        const account = inst.account as { login?: string; slug?: string } | null;
        return { ok: true, accountLogin: account?.login || account?.slug || "unknown" };
      }
    }
  }
  return { ok: false };
}

/**
 * Resolve the credential used to write to a member's repo: their own pasted
 * token when they chose that path, otherwise a fresh installation token.
 */
export async function resolveRepoToken(userId: string, target: { encryptedToken: string | null }): Promise<string> {
  if (target.encryptedToken) return decryptSecret(target.encryptedToken);
  const install = await prisma.githubInstallation.findUnique({ where: { userId } });
  if (!install) {
    throw new Error("GitHub access was removed. Reinstall the app or connect a token from the Sources page.");
  }
  return installationToken(install.installationId);
}
