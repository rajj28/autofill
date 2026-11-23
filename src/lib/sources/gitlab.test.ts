import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialsFromTokenResponse, gitlabAdapter, gitlabHeaders } from "./gitlab";
import { normalizePrivateKey } from "../site/github-app";

afterEach(() => vi.restoreAllMocks());

describe("gitlab credentials", () => {
  it("uses Bearer for OAuth credentials and PRIVATE-TOKEN for a pasted token", () => {
    expect(gitlabHeaders({ accessToken: "a", refreshToken: "r" })).toEqual({ Authorization: "Bearer a" });
    expect(gitlabHeaders({ accessToken: "pat" })).toEqual({ "PRIVATE-TOKEN": "pat" });
  });

  it("computes expiry from created_at + expires_in", () => {
    const creds = credentialsFromTokenResponse({
      access_token: "a",
      refresh_token: "r",
      expires_in: 7200,
      created_at: 1_000,
    });
    expect(creds.expiresAt).toBe(String(1_000_000 + 7_200_000));
  });

  it("rejects a response without a refresh token, with wording the engine treats as reconnect", () => {
    expect(() => credentialsFromTokenResponse({ error: "invalid_grant" })).toThrow(/rejected/);
  });
});

describe("gitlab refresh", () => {
  it("does nothing for a personal access token", async () => {
    expect(await gitlabAdapter.refresh!({ accessToken: "pat" })).toBeNull();
  });

  it("does nothing while the token is comfortably valid", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await gitlabAdapter.refresh!({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: String(Date.now() + 60 * 60 * 1000),
    });
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and returns the rotated refresh token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-a", refresh_token: "new-r", expires_in: 7200 }))
    );
    const out = await gitlabAdapter.refresh!({
      accessToken: "old",
      refreshToken: "old-r",
      expiresAt: String(Date.now() + 1000),
    });
    expect(out?.accessToken).toBe("new-a");
    expect(out?.refreshToken).toBe("new-r");
  });
});

describe("github app private key", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
  it("accepts PEM, escaped-newline PEM, and base64 PEM", () => {
    expect(normalizePrivateKey(pem)).toBe(pem);
    expect(normalizePrivateKey(pem.replace(/\n/g, "\\n"))).toBe(pem);
    expect(normalizePrivateKey(Buffer.from(pem).toString("base64"))).toBe(pem);
  });
  it("rejects garbage", () => {
    expect(() => normalizePrivateKey("not a key")).toThrow();
  });
});
