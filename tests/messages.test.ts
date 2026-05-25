import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { CopilotTokenProvider } from "../src/adapters/copilot-token.js";
import { CopilotTokenError } from "../src/adapters/copilot-token.js";
import { testConfig } from "./helpers.js";

describe("messages proxy", () => {
  it("maps model and rewrites upstream authorization", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        return { token: "copilot-token", apiBase: "https://copilot.test" };
      },
      invalidate() {}
    };

    const app = await buildApp({
      config: testConfig({
        models: {
          copilotMap: {
            "claude-haiku-4.5": "claude-upstream-haiku"
          }
        }
      }),
      tokenProvider,
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ model: "claude-upstream-haiku" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "proxy-key",
        authorization: "Bearer client-token",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "custom-beta"
      },
      payload: {
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32,
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://copilot.test/v1/messages");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe(
      "Bearer copilot-token"
    );
    expect((calls[0].init?.headers as Record<string, string>)["anthropic-beta"]).toBe(
      "custom-beta"
    );
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe("claude-upstream-haiku");
  });

  it("learns unsupported beta headers, persists them, and retries transparently", async () => {
    const denylistFile = await tempDenylistFile();
    const calls: Array<{ init?: RequestInit }> = [];
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        return { token: "copilot-token", apiBase: "https://copilot.test" };
      },
      invalidate() {}
    };

    const app = await buildApp({
      config: testConfig({
        anthropic: { betaDenylistFile: denylistFile }
      }),
      tokenProvider,
      fetchFn: async (_input, init) => {
        calls.push({ init });
        const beta = (init?.headers as Record<string, string>)["anthropic-beta"];
        if (beta?.includes("advisor-tool-2026-03-01")) {
          return new Response("unsupported beta header(s): advisor-tool-2026-03-01", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "proxy-key",
        "anthropic-beta": "advisor-tool-2026-03-01"
      },
      payload: {
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16
      }
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    expect((calls[0].init?.headers as Record<string, string>)["anthropic-beta"]).toBe(
      "advisor-tool-2026-03-01"
    );
    expect((calls[1].init?.headers as Record<string, string>)["anthropic-beta"]).toBeUndefined();

    const denylist = JSON.parse(await readFile(denylistFile, "utf8")) as {
      unsupportedBetas: Array<{ beta: string; expiresAt: string }>;
    };
    expect(denylist.unsupportedBetas).toHaveLength(1);
    expect(denylist.unsupportedBetas[0].beta).toBe("advisor-tool-2026-03-01");
    expect(new Date(denylist.unsupportedBetas[0].expiresAt).getTime()).toBeGreaterThan(
      Date.now()
    );
  });

  it("filters persisted unsupported beta headers after restart", async () => {
    const denylistFile = await tempDenylistFile();
    await writeFile(
      denylistFile,
      JSON.stringify({
        version: 1,
        unsupportedBetas: [
          {
            beta: "advisor-tool-2026-03-01",
            addedAt: "2026-05-22T00:00:00.000Z",
            lastSeenAt: "2026-05-22T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            reason: "unsupported beta header(s): advisor-tool-2026-03-01"
          }
        ]
      }),
      "utf8"
    );

    const calls: Array<{ init?: RequestInit }> = [];
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        return { token: "copilot-token", apiBase: "https://copilot.test" };
      },
      invalidate() {}
    };

    const app = await buildApp({
      config: testConfig({
        anthropic: { betaDenylistFile: denylistFile }
      }),
      tokenProvider,
      fetchFn: async (_input, init) => {
        calls.push({ init });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "proxy-key",
        "anthropic-beta": "advisor-tool-2026-03-01,claude-code-20250219"
      },
      payload: {
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16
      }
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect((calls[0].init?.headers as Record<string, string>)["anthropic-beta"]).toBe(
      "claude-code-20250219"
    );
  });

  it("expires persisted unsupported beta headers after one month", async () => {
    const denylistFile = await tempDenylistFile();
    await writeFile(
      denylistFile,
      JSON.stringify({
        version: 1,
        unsupportedBetas: [
          {
            beta: "advisor-tool-2026-03-01",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-02-01T00:00:00.000Z",
            reason: "unsupported beta header(s): advisor-tool-2026-03-01"
          }
        ]
      }),
      "utf8"
    );

    const calls: Array<{ init?: RequestInit }> = [];
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        return { token: "copilot-token", apiBase: "https://copilot.test" };
      },
      invalidate() {}
    };

    const app = await buildApp({
      config: testConfig({
        anthropic: { betaDenylistFile: denylistFile }
      }),
      tokenProvider,
      fetchFn: async (_input, init) => {
        calls.push({ init });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "proxy-key",
        "anthropic-beta": "advisor-tool-2026-03-01"
      },
      payload: {
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16
      }
    });

    expect(response.statusCode).toBe(200);
    expect((calls[0].init?.headers as Record<string, string>)["anthropic-beta"]).toBe(
      "advisor-tool-2026-03-01"
    );

    const denylist = JSON.parse(await readFile(denylistFile, "utf8")) as {
      unsupportedBetas: unknown[];
    };
    expect(denylist.unsupportedBetas).toHaveLength(0);
  });

  it("refreshes Copilot token once on upstream auth failure", async () => {
    let tokenCalls = 0;
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        tokenCalls += 1;
        return {
          token: tokenCalls === 1 ? "expired-token" : "fresh-token",
          apiBase: "https://copilot.test"
        };
      },
      invalidate() {}
    };
    const authHeaders: string[] = [];

    const app = await buildApp({
      config: testConfig(),
      tokenProvider,
      fetchFn: async (_input, init) => {
        const authorization = (init?.headers as Record<string, string>).authorization;
        authHeaders.push(authorization);
        return new Response(JSON.stringify({ ok: authorization.includes("fresh") }), {
          status: authorization.includes("fresh") ? 200 : 401,
          headers: { "content-type": "application/json" }
        });
      }
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
    expect(authHeaders).toEqual(["Bearer expired-token", "Bearer fresh-token"]);
  });

  it("maps Claude Code model IDs to Copilot model IDs", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        return { token: "copilot-token", apiBase: "https://copilot.test" };
      },
      invalidate() {}
    };

    const app = await buildApp({
      config: testConfig(),
      tokenProvider,
      fetchFn: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "proxy-key" },
      payload: {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16
      }
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamBody?.model).toBe("claude-opus-4.6");
  });

  it("returns upstream text error bodies", async () => {
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        return { token: "copilot-token", apiBase: "https://copilot.test" };
      },
      invalidate() {}
    };

    const app = await buildApp({
      config: testConfig(),
      tokenProvider,
      fetchFn: async () =>
        new Response("model is not supported for this request", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" }
        })
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "proxy-key" },
      payload: {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "model is not supported for this request"
      }
    });
  });

  it("maps Copilot token exchange 404 to authentication error", async () => {
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        throw new CopilotTokenError(404, "Failed to fetch Copilot token: HTTP 404");
      },
      invalidate() {}
    };

    const app = await buildApp({
      config: testConfig(),
      tokenProvider
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

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Failed to fetch Copilot token: HTTP 404"
      }
    });
  });

  it("aggregates upstream SSE into a non-stream Anthropic message", async () => {
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        return { token: "copilot-token", apiBase: "https://copilot.test" };
      },
      invalidate() {}
    };

    const app = await buildApp({
      config: testConfig(),
      tokenProvider,
      fetchFn: async () =>
        new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-haiku-4.5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":8,"output_tokens":0}}}',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
            'event: message_stop\ndata: {"type":"message_stop"}',
            ""
          ].join("\n\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          }
        )
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "proxy-key" },
      payload: {
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello there" }],
      model: "claude-haiku-4.5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 8,
        output_tokens: 3
      }
    });
  });

  it("passes upstream SSE through for stream requests", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","content":[],"model":"claude-haiku-4.5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      ""
    ].join("\n\n");
    let upstreamBody: Record<string, unknown> | undefined;
    const tokenProvider: CopilotTokenProvider = {
      async getToken() {
        return { token: "copilot-token", apiBase: "https://copilot.test" };
      },
      invalidate() {}
    };

    const app = await buildApp({
      config: testConfig(),
      tokenProvider,
      fetchFn: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "proxy-key" },
      payload: {
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
        stream: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(sse);
    expect(upstreamBody?.stream).toBe(true);
  });
});

async function tempDenylistFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copilot-claude-api-test-"));
  return join(dir, "anthropic-beta-denylist.json");
}
