import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, AppConfigInput } from "../src/config.js";
import { loadConfig } from "../src/config.js";

export function testConfig(overrides: AppConfigInput = {}): AppConfig {
  return loadConfig(mergeConfig(testConfigDefaults(), overrides));
}

function testConfigDefaults(): AppConfigInput {
  return {
    auth: { proxyApiKey: "proxy-key" },
    github: {
      oauth: {
        tokenFile: join(tmpdir(), "copilot-claude-api-test-oauth.json")
      }
    },
    server: { logLevel: "silent" }
  };
}

function mergeConfig(base: AppConfigInput, overrides: AppConfigInput): AppConfigInput {
  return {
    ...base,
    ...overrides,
    server: {
      ...base.server,
      ...overrides.server
    },
    auth: {
      ...base.auth,
      ...overrides.auth
    },
    copilot: {
      ...base.copilot,
      ...overrides.copilot
    },
    github: {
      ...base.github,
      ...overrides.github,
      oauth: {
        ...base.github?.oauth,
        ...overrides.github?.oauth
      }
    },
    anthropic: {
      ...base.anthropic,
      ...overrides.anthropic
    },
    models: {
      ...base.models,
      ...overrides.models
    }
  };
}
