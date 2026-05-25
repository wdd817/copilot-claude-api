import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { getProxyCredential, isAuthorizedProxyRequest } from "../auth/proxy-auth.js";
import { anthropicError } from "../errors.js";

export interface ModelRouteOptions {
  config: AppConfig;
}

interface AnthropicModel {
  id: string;
  type: "model";
  display_name: string;
  created_at: string;
}

export async function registerModelRoutes(
  app: FastifyInstance,
  options: ModelRouteOptions
): Promise<void> {
  app.get("/v1/models", async (request, reply) => {
    if (!isAuthorizedProxyRequest(request, options.config.proxyApiKey)) {
      return reply
        .code(401)
        .send(
          anthropicError(
            "authentication_error",
            getProxyCredential(request) ? "Invalid API key" : "Missing API key"
          )
        );
    }

    const models = listModels(options.config);
    return {
      data: models,
      has_more: false,
      first_id: models[0]?.id ?? null,
      last_id: models.at(-1)?.id ?? null
    };
  });
}

function listModels(config: AppConfig): AnthropicModel[] {
  return [...config.modelAllowlist]
    .filter((model) => isPreferredExternalModel(model))
    .map((model) => ({
      id: model,
      type: "model",
      display_name: displayName(model),
      created_at: "2026-05-22T00:00:00Z"
    }));
}

function isPreferredExternalModel(model: string): boolean {
  return !model.includes(".") && !["opus", "sonnet", "haiku", "best"].includes(model);
}

function displayName(model: string): string {
  if (model === "claude-opus-4-7") return "Claude Opus 4.7";
  if (model === "claude-opus-4-6") return "Claude Opus 4.6";
  if (model === "claude-sonnet-4-6") return "Claude Sonnet 4.6";
  if (model === "claude-haiku-4-5-20251001") return "Claude Haiku 4.5";

  return model
    .replace(/^claude-/, "Claude ")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
