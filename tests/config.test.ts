import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadConfigFile } from "../src/config.js";

describe("config", () => {
  it("loads model lists and maps from YAML objects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-claude-api-config-"));
    const file = join(dir, "config.yaml");
    await writeFile(
      file,
      [
        "auth:",
        "  proxyApiKey: proxy-key",
        "models:",
        "  default: claude-haiku-4.5",
        "  allowlist:",
        "    - claude-haiku-4.5",
        "  copilotMap:",
        "    claude-haiku-4.5: claude-upstream-haiku",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfigFile(file);

    expect(config.proxyApiKey).toBe("proxy-key");
    expect([...config.modelAllowlist]).toEqual(["claude-haiku-4.5"]);
    expect(config.modelMap.get("claude-haiku-4.5")).toBe("claude-upstream-haiku");
  });

  it("still accepts comma-delimited model config for focused tests", () => {
    const config = loadConfig({
      models: {
        allowlist: "custom-model",
        copilotMap: "custom-model:upstream-model"
      }
    });

    expect(config.modelAllowlist.has("custom-model")).toBe(true);
    expect(config.modelMap.get("custom-model")).toBe("upstream-model");
  });

  it("stores Anthropic beta denylist in the runtime data directory by default", () => {
    const config = loadConfig();

    expect(config.anthropicBetaDenylistFile).toBe(
      join(process.cwd(), "data", "anthropic-beta-denylist.json")
    );
  });

  it("stores GitHub OAuth token in the runtime data directory by default", () => {
    const config = loadConfig();

    expect(config.copilotOAuthTokenFile).toBe(join(process.cwd(), "data", "github-oauth.json"));
  });
});
