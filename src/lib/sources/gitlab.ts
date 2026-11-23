import { env } from "../env";
import type { ConnectionCredentials, DiscoveredItem, SourceAdapter } from "./types";

/**
 * Two credential shapes share this adapter:
 *  - OAuth (the normal path): { accessToken, refreshToken, expiresAt }, issued
 *    through the platform's single GitLab application. Tokens last 2 hours, so
 *    `refresh` runs before every sync.
 *  - Personal access token (advanced): { accessToken } only.
 */

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function gitlabHeaders(credentials: ConnectionCredentials): Record<string, string> {
  return credentials.refreshToken
    ? { Authorization: `Bearer ${credentials.accessToken}` }
    : { "PRIVATE-TOKEN": credentials.accessToken };
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; created_at?: number; error?: string };

/** Turn a GitLab token response into the credentials we store. */
export function credentialsFromTokenResponse(json: TokenResponse): ConnectionCredentials {
  if (!json.access_token || !json.refresh_token) {
    throw new Error(`GitLab rejected the token request: ${json.error || "no tokens returned"}`);
  }
  const createdMs = (json.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: String(createdMs + (json.expires_in ?? 7200) * 1000),
  };
}

export async function requestGitlabToken(params: Record<string, string>): Promise<ConnectionCredentials> {
  const res = await fetch("https://gitlab.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITLAB_CLIENT_ID,
      client_secret: env.GITLAB_CLIENT_SECRET,
      ...params,
    }),
  });
  return credentialsFromTokenResponse((await res.json()) as TokenResponse);
}

export const gitlabAdapter: SourceAdapter = {
  type: "gitlab",
  async refresh(credentials) {
    if (!credentials.refreshToken) return null; // PAT: nothing to refresh
    const expiresAt = Number(credentials.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_SKEW_MS) return null;
    // GitLab rotates the refresh token on every use, so the result MUST be persisted.
    return requestGitlabToken({ grant_type: "refresh_token", refresh_token: credentials.refreshToken });
  },
  async identity(ctx) {
    const res = await fetch("https://gitlab.com/api/v4/user", {
      headers: gitlabHeaders(ctx.credentials),
    });
    if (!res.ok) throw new Error(`GitLab identity failed (${res.status})`);
    const me = (await res.json()) as { id: number; username: string; web_url: string };
    return {
      externalUserId: String(me.id),
      displayName: me.username,
      profileUrl: me.web_url,
    };
  },
  async fetch(ctx) {
    const res = await fetch(
      "https://gitlab.com/api/v4/projects?owned=true&simple=false&order_by=last_activity_at&per_page=40",
      { headers: gitlabHeaders(ctx.credentials) }
    );
    if (!res.ok) throw new Error(`GitLab projects failed (${res.status})`);
    const projects = (await res.json()) as Array<{
      id: number;
      name_with_namespace: string;
      description: string | null;
      web_url: string;
      star_count: number;
      forks_count: number;
      last_activity_at: string;
      created_at: string;
      topics?: string[];
      visibility: string;
    }>;

    const items: DiscoveredItem[] = [];
    for (const project of projects) {
      if (project.visibility !== "public") continue;
      items.push({
        sourceType: "gitlab",
        kind: "project",
        externalId: String(project.id),
        url: project.web_url,
        title: project.name_with_namespace,
        summary: project.description || undefined,
        occurredAt: new Date(project.last_activity_at),
        payload: {
          description: project.description,
          stars: project.star_count,
          forks: project.forks_count || 0,
          topics: project.topics || [],
          createdAt: project.created_at,
          visibility: project.visibility,
        },
      });
    }
    return items;
  },
};
