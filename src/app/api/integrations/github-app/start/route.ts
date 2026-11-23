import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { createOAuthState } from "@/lib/oauth-state";
import { env, githubAppConfigured } from "@/lib/env";

/** Send the member to install the platform's GitHub App on their site repo. */
export async function GET() {
  const user = await requireUser();
  if (!githubAppConfigured) {
    return NextResponse.json({ error: "The GitHub App is not configured on this server." }, { status: 400 });
  }
  const url = new URL(`https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG!)}/installations/new`);
  url.searchParams.set("state", createOAuthState(user.id, "github-app"));
  return NextResponse.redirect(url);
}
