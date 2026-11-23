import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { env, githubAppConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";
import { readOAuthState } from "@/lib/oauth-state";
import { exchangeUserCode, userCanAccessInstallation } from "@/lib/site/github-app";

/**
 * Setup URL of the GitHub App. GitHub redirects here after install with
 * `installation_id`, `code` (user authorization) and our `state`.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const back = (query: string) => NextResponse.redirect(`${env.APP_URL}/app/sources?${query}#website`);

  const state = q.get("state");
  const code = q.get("code");
  const installationId = Number.parseInt(q.get("installation_id") || "", 10);
  if (!githubAppConfigured || !state || !code || !Number.isInteger(installationId)) {
    return back("error=github_app");
  }

  try {
    const userId = readOAuthState(state, "github-app");
    const userToken = await exchangeUserCode(code);
    const access = await userCanAccessInstallation(userToken, installationId);
    if (!access.ok) {
      logger.warn("github_app_installation_not_owned", { userId, installationId });
      return back("error=github_app");
    }

    await prisma.githubInstallation.upsert({
      where: { userId },
      create: { userId, installationId, accountLogin: access.accountLogin },
      update: { installationId, accountLogin: access.accountLogin },
    });
    logger.info("github_app_installed", { userId, installationId });
    return back("connected=github-app");
  } catch (error) {
    logger.error("github_app_callback_failed", { error: error instanceof Error ? error.message : "unknown" });
    return back("error=github_app");
  }
}
