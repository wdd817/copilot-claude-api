import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const defaultModelAllowlist = [
  "claude-opus-4-6",
  "claude-opus-4.6",
  "opus",
  "best",
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
  "sonnet",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4.5",
  "haiku"
];

const defaultCopilotModelMap = {
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4.6": "claude-opus-4.6",
  opus: "claude-opus-4.6",
  best: "claude-opus-4.6",
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4.6": "claude-sonnet-4.6",
  sonnet: "claude-sonnet-4.6",
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
  "claude-haiku-4.5": "claude-haiku-4.5",
  haiku: "claude-haiku-4.5"
} satisfies Record<string, string>;

const stringOrStringListSchema = z.union([z.string(), z.array(z.string())]);
const nullablePathSchema = z.string().nullable().optional();

const configSchema = z.object({
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.coerce.number().int().positive().default(51843),
      logLevel: z.string().default("info"),
      requestTimeoutMs: z.coerce.number().int().positive().default(120000),
      maxRequestBodySize: z.string().default("32mb")
    })
    .default({}),
  auth: z
    .object({
      proxyApiKey: z.string().min(1).default("change-me")
    })
    .default({}),
  copilot: z
    .object({
      apiBase: z.string().url().default("https://api.business.githubcopilot.com"),
      tokenRefreshSkewMs: z.coerce.number().int().nonnegative().default(120000)
    })
    .default({}),
  github: z
    .object({
      apiBase: z.string().url().default("https://api.github.com"),
      authBase: z.string().url().default("https://github.com"),
      oauth: z
        .object({
          tokenFile: nullablePathSchema,
          clientId: z.string().min(1).default("Iv1.b507a08c87ecfe98"),
          scopes: stringOrStringListSchema.default(["read:user"]),
          refreshSkewMs: z.coerce.number().int().nonnegative().default(300000)
        })
        .default({})
    })
    .default({}),
  anthropic: z
    .object({
      betaDenylistFile: nullablePathSchema
    })
    .default({}),
  models: z
    .object({
      default: z.string().min(1).default("claude-opus-4-6"),
      allowlist: stringOrStringListSchema.default(defaultModelAllowlist),
      copilotMap: z
        .union([z.record(z.string()), z.string()])
        .default(defaultCopilotModelMap)
    })
    .default({})
});

export type AppConfigInput = z.input<typeof configSchema>;

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
  proxyApiKey: string;
  copilotApiBase: string;
  githubApiBase: string;
  githubAuthBase: string;
  copilotOAuthTokenFile: string;
  anthropicBetaDenylistFile: string;
  copilotOAuthClientId: string;
  copilotOAuthScopes: string;
  githubOAuthTokenRefreshSkewMs: number;
  defaultModel: string;
  modelAllowlist: Set<string>;
  modelMap: Map<string, string>;
  requestTimeoutMs: number;
  maxRequestBodySize: string;
  copilotTokenRefreshSkewMs: number;
}

export function loadConfigFile(filePath = defaultConfigFilePath()): AppConfig {
  const rawConfig = readFileSync(filePath, "utf8");
  const parsedConfig = parseYaml(rawConfig) as unknown;

  if (parsedConfig !== null && (typeof parsedConfig !== "object" || Array.isArray(parsedConfig))) {
    throw new Error(`Config file must contain a YAML object: ${filePath}`);
  }

  return loadConfig((parsedConfig ?? {}) as AppConfigInput);
}

export function loadConfig(config: AppConfigInput = {}): AppConfig {
  const parsed = configSchema.parse(config);
  const allowlist = parseStringSet(parsed.models.allowlist);
  const modelMap = parseModelMap(parsed.models.copilotMap);

  if (!allowlist.has(parsed.models.default)) {
    allowlist.add(parsed.models.default);
  }

  for (const model of allowlist) {
    if (!modelMap.has(model)) {
      modelMap.set(model, model);
    }
  }

  return {
    host: parsed.server.host,
    port: parsed.server.port,
    logLevel: parsed.server.logLevel,
    proxyApiKey: parsed.auth.proxyApiKey,
    copilotApiBase: trimTrailingSlash(parsed.copilot.apiBase),
    githubApiBase: trimTrailingSlash(parsed.github.apiBase),
    githubAuthBase: trimTrailingSlash(parsed.github.authBase),
    copilotOAuthTokenFile:
      firstNonEmpty(parsed.github.oauth.tokenFile) ?? defaultOAuthTokenFile(),
    anthropicBetaDenylistFile:
      firstNonEmpty(parsed.anthropic.betaDenylistFile) ?? defaultAnthropicBetaDenylistFile(),
    copilotOAuthClientId: parsed.github.oauth.clientId.trim(),
    copilotOAuthScopes: normalizeOAuthScopes(parsed.github.oauth.scopes),
    githubOAuthTokenRefreshSkewMs: parsed.github.oauth.refreshSkewMs,
    defaultModel: parsed.models.default,
    modelAllowlist: allowlist,
    modelMap,
    requestTimeoutMs: parsed.server.requestTimeoutMs,
    maxRequestBodySize: parsed.server.maxRequestBodySize,
    copilotTokenRefreshSkewMs: parsed.copilot.tokenRefreshSkewMs
  };
}

function defaultConfigFilePath(): string {
  return resolve(firstNonEmpty(process.env.COPILOT_CLAUDE_CONFIG_FILE, process.env.CONFIG_FILE) ?? "config.yaml");
}

function parseStringSet(value: string | string[]): Set<string> {
  return new Set(parseStringList(value));
}

function parseStringList(value: string | string[]): string[] {
  const items = Array.isArray(value) ? value : value.split(",");

  return items.map((item) => item.trim()).filter(Boolean);
}

function parseModelMap(value: string | Record<string, string>): Map<string, string> {
  if (typeof value === "string") {
    return parseModelMapString(value);
  }

  const map = new Map<string, string>();
  for (const [rawExternal, rawUpstream] of Object.entries(value)) {
    const external = rawExternal.trim();
    const upstream = rawUpstream.trim();
    if (external && upstream) {
      map.set(external, upstream);
    }
  }

  return map;
}

function parseModelMapString(value: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const rawPair of value.split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;

    const separator = pair.indexOf(":");
    if (separator === -1) {
      map.set(pair, pair);
      continue;
    }

    const external = pair.slice(0, separator).trim();
    const upstream = pair.slice(separator + 1).trim();
    if (external && upstream) {
      map.set(external, upstream);
    }
  }

  return map;
}

function normalizeOAuthScopes(value: string | string[]): string {
  return Array.isArray(value) ? parseStringList(value).join(" ") : value.trim();
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0) ?? undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function defaultOAuthTokenFile(): string {
  return join(process.cwd(), "data", "github-oauth.json");
}

function defaultAnthropicBetaDenylistFile(): string {
  return join(process.cwd(), "data", "anthropic-beta-denylist.json");
}
