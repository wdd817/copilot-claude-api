import Fastify, { type FastifyInstance } from "fastify";
import { AnthropicBetaDenylistStore } from "./anthropic-beta-denylist.js";
import type { AppConfig } from "./config.js";
import { CopilotTokenManager, type CopilotTokenProvider } from "./adapters/copilot-token.js";
import { GithubOAuthTokenManager, type GithubTokenProvider } from "./auth/github-token.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerModelRoutes } from "./routes/models.js";

export interface BuildAppOptions {
  config: AppConfig;
  tokenProvider?: CopilotTokenProvider;
  githubTokenProvider?: GithubTokenProvider;
  anthropicBetaDenylistStore?: AnthropicBetaDenylistStore;
  fetchFn?: typeof fetch;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-api-key",
          "request.headers.authorization",
          "request.headers.x-api-key"
        ],
        censor: "[redacted]"
      }
    },
    bodyLimit: parseBodyLimit(options.config.maxRequestBodySize)
  });

  const githubTokenProvider =
    options.githubTokenProvider ??
    new GithubOAuthTokenManager(options.config, options.fetchFn);
  const tokenProvider =
    options.tokenProvider ??
    new CopilotTokenManager(options.config, githubTokenProvider, options.fetchFn);
  const anthropicBetaDenylistStore =
    options.anthropicBetaDenylistStore ??
    new AnthropicBetaDenylistStore(options.config.anthropicBetaDenylistFile);

  await registerHealthRoutes(app);
  await registerModelRoutes(app, { config: options.config });
  await registerMessageRoutes(app, {
    config: options.config,
    tokenProvider,
    anthropicBetaDenylistStore,
    fetchFn: options.fetchFn
  });

  return app;
}

function parseBodyLimit(value: string): number {
  const match = value.trim().match(/^(\d+)(b|kb|mb)?$/i);
  if (!match) {
    throw new Error(`Invalid MAX_REQUEST_BODY_SIZE: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  if (unit === "kb") return amount * 1024;
  if (unit === "mb") return amount * 1024 * 1024;
  return amount;
}
