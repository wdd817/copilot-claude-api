import { describe, expect, it } from "vitest";
import { CopilotTokenManager } from "../src/adapters/copilot-token.js";
import type { GithubTokenProvider } from "../src/auth/github-token.js";
import { testConfig } from "./helpers.js";

const githubTokenProvider: GithubTokenProvider = {
  async getToken() {
    return "github-token";
  },
  invalidate() {}
};

describe("CopilotTokenManager", () => {
  it("fetches and caches Copilot access tokens", async () => {
    let fetchCalls = 0;
    const manager = new CopilotTokenManager(
      testConfig(),
      githubTokenProvider,
      async (_input, init) => {
        fetchCalls += 1;
        expect((init?.headers as Record<string, string>).authorization).toBe(
          "Bearer github-token"
        );
        return new Response(
          JSON.stringify({
            token: `copilot-token-${fetchCalls}`,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_in: 1800,
            endpoints: { api: "https://copilot.test/" }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    const first = await manager.getToken();
    const second = await manager.getToken();

    expect(first).toEqual({ token: "copilot-token-1", apiBase: "https://copilot.test" });
    expect(second).toEqual(first);
    expect(fetchCalls).toBe(1);
  });

  it("can force refresh cached tokens", async () => {
    let fetchCalls = 0;
    const manager = new CopilotTokenManager(
      testConfig(),
      githubTokenProvider,
      async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            token: `copilot-token-${fetchCalls}`,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_in: 1800
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    await manager.getToken();
    const refreshed = await manager.getToken({ forceRefresh: true });

    expect(refreshed.token).toBe("copilot-token-2");
  });

  it("retries with token auth scheme when bearer is rejected", async () => {
    const authHeaders: string[] = [];
    const manager = new CopilotTokenManager(
      testConfig(),
      githubTokenProvider,
      async (_input, init) => {
        const authorization = (init?.headers as Record<string, string>).authorization;
        authHeaders.push(authorization);

        if (authorization.startsWith("Bearer ")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }

        return new Response(
          JSON.stringify({
            token: "copilot-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_in: 1800
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    const token = await manager.getToken();

    expect(token.token).toBe("copilot-token");
    expect(authHeaders).toEqual(["Bearer github-token", "token github-token"]);
  });

  it("includes upstream error details when token exchange fails", async () => {
    const manager = new CopilotTokenManager(
      testConfig(),
      githubTokenProvider,
      async () =>
        new Response(
          JSON.stringify({
            message: "Resource not accessible by integration",
            documentation_url: "https://docs.github.com/rest"
          }),
          { status: 403, headers: { "content-type": "application/json" } }
        )
    );

    await expect(manager.getToken()).rejects.toThrow(
      "Failed to fetch Copilot token: HTTP 403 - Resource not accessible by integration"
    );
  });
});
