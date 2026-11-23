import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { env, gitlabOAuthConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";
import { readOAuthState } from "@/lib/oauth-state";
import { getAdapter } from "@/lib/sources/registry";
import { requestGitlabToken } from "@/lib/sources/gitlab";
import { sealCredentials } from "@/lib/sync/engine";
import { enqueueSourceSync } from "@/lib/queue";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const back = (query: string) => NextResponse.redirect(`${env.APP_URL}/app/sources?${query}`);
  const code = q.get("code");
  const state = q.get("state");
  if (!gitlabOAuthConfigured || !code || !state) return back("error=gitlab_oauth");

  try {
    const userId = readOAuthState(state, "gitlab");
    const credentials = await requestGitlabToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${env.APP_URL}/api/integrations/gitlab/callback`,
    });
    const identity = await getAdapter("gitlab").identity!({ credentials });
    const sealed = sealCredentials(credentials);
    const connection = await prisma.sourceConnection.upsert({
      where: {
        userId_sourceType_externalUserId: { userId, sourceType: "gitlab", externalUserId: identity.externalUserId },
      },
      create: {
        userId,
        sourceType: "gitlab",
        displayName: identity.displayName,
        externalUserId: identity.externalUserId,
        profileUrl: identity.profileUrl,
        encryptedCredentials: sealed,
        status: "connected",
      },
      update: {
        displayName: identity.displayName,
        profileUrl: identity.profileUrl,
        encryptedCredentials: sealed,
        status: "connected",
        lastError: null,
      },
    });
    await enqueueSourceSync(connection.id, "gitlab-oauth");
    return back("connected=gitlab");
  } catch (error) {
    logger.error("gitlab_oauth_failed", { error: error instanceof Error ? error.message : "unknown" });
    return back("error=gitlab_oauth");
  }
}
