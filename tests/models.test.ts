import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { testConfig } from "./helpers.js";

describe("models endpoint", () => {
  it("requires proxy auth", async () => {
    const app = await buildApp({ config: testConfig() });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      type: "error",
      error: { type: "authentication_error" }
    });
  });

  it("returns Claude Code friendly model IDs", async () => {
    const app = await buildApp({ config: testConfig() });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": "proxy-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "claude-opus-4-6",
          type: "model",
          display_name: "Claude Opus 4.6"
        }),
        expect.objectContaining({
          id: "claude-sonnet-4-6",
          type: "model",
          display_name: "Claude Sonnet 4.6"
        }),
        expect.objectContaining({
          id: "claude-haiku-4-5-20251001",
          type: "model",
          display_name: "Claude Haiku 4.5"
        })
      ]),
      has_more: false
    });
  });
});
