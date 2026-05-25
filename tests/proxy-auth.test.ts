import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CopilotTokenProvider } from "../src/adapters/copilot-token.js";
import { testConfig } from "./helpers.js";

const tokenProvider: CopilotTokenProvider = {
  async getToken() {
    return { token: "copilot-token", apiBase: "https://copilot.test" };
  },
  invalidate() {}
};

describe("proxy auth", () => {
  it("rejects requests without proxy credentials", async () => {
    const app = await buildApp({ config: testConfig(), tokenProvider });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-haiku-4.5",
        messages: [],
        max_tokens: 16
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      type: "error",
      error: { type: "authentication_error" }
    });
  });

  it("accepts Anthropic x-api-key credentials", async () => {
    const app = await buildApp({
      config: testConfig(),
      tokenProvider,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: "claude-haiku-4.5",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "proxy-key" },
      payload: {
        model: "claude-haiku-4.5",
        messages: [],
        max_tokens: 16
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().content[0].text).toBe("ok");
  });

  it("accepts bearer credentials", async () => {
    const app = await buildApp({
      config: testConfig(),
      tokenProvider,
      fetchFn: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: "Bearer proxy-key" },
      payload: {
        model: "claude-haiku-4.5",
        messages: [],
        max_tokens: 16
      }
    });

    expect(response.statusCode).toBe(200);
  });
});
