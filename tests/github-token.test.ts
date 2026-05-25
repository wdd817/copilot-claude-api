import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GithubOAuthTokenManager } from "../src/auth/github-token.js";
import { testConfig } from "./helpers.js";

const tempDirs: string[] = [];

describe("GithubOAuthTokenManager", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads and validates a stored OAuth token once", async () => {
    const dir = await makeTempDir();
    const tokenFile = join(dir, "github-oauth.json");
    await writeFile(
      tokenFile,
      JSON.stringify({
        accessToken: "stored-token",
        tokenType: "bearer",
        createdAt: new Date().toISOString()
      })
    );

    let validationCalls = 0;
    const manager = new GithubOAuthTokenManager(
      testConfig({ github: { oauth: { tokenFile } } }),
      async (input, init) => {
        validationCalls += 1;
        expect(String(input)).toBe("https://api.github.com/user");
        expect((init?.headers as Record<string, string>).authorization).toBe(
          "Bearer stored-token"
        );
        return new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "github-authentication-token-expiration": "2099-01-01T00:00:00Z"
          }
        });
      },
      { output: { write() {} } }
    );

    await expect(manager.getToken()).resolves.toBe("stored-token");
    await expect(manager.getToken()).resolves.toBe("stored-token");

    expect(validationCalls).toBe(1);
    expect(JSON.parse(await readFile(tokenFile, "utf8")).expiresAt).toBe(
      "2099-01-01T00:00:00.000Z"
    );
  });

  it("runs GitHub device flow and persists the OAuth token when none is stored", async () => {
    const dir = await makeTempDir();
    const tokenFile = join(dir, "github-oauth.json");
    const output: string[] = [];
    const calls: string[] = [];

    const manager = new GithubOAuthTokenManager(
      testConfig({ github: { oauth: { tokenFile } } }),
      async (input) => {
        calls.push(String(input));
        if (String(input).endsWith("/login/device/code")) {
          return new Response(
            JSON.stringify({
              device_code: "device-code",
              user_code: "ABCD-1234",
              verification_uri: "https://github.com/login/device",
              expires_in: 60,
              interval: 0
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            access_token: "oauth-token",
            token_type: "bearer",
            scope: "read:user"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      { output: { write: (message) => output.push(message) } }
    );

    await expect(manager.getToken()).resolves.toBe("oauth-token");

    expect(calls).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token"
    ]);
    expect(output.join("")).toContain("ABCD-1234");
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toMatchObject({
      accessToken: "oauth-token",
      tokenType: "bearer",
      scope: "read:user"
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copilot-claude-api-"));
  tempDirs.push(dir);
  return dir;
}
