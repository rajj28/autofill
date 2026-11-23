import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { createOAuthState } from "@/lib/oauth-state";
import { env, gitlabOAuthConfigured } from "@/lib/env";

export async function GET() {
  const user = await requireUser();
  if (!gitlabOAuthConfigured) {
    return NextResponse.json({ error: "GitLab OAuth is not configured on this server." }, { status: 400 });
  }
  const url = new URL("https://gitlab.com/oauth/authorize");
  url.searchParams.set("client_id", env.GITLAB_CLIENT_ID!);
  url.searchParams.set("redirect_uri", `${env.APP_URL}/api/integrations/gitlab/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read_api");
  url.searchParams.set("state", createOAuthState(user.id, "gitlab"));
  return NextResponse.redirect(url);
}
