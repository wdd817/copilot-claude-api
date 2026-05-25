import type { AppConfig } from "../config.js";

export function mapModelForCopilot(config: AppConfig, requestedModel: string): string {
  if (!config.modelAllowlist.has(requestedModel)) {
    throw new ModelNotAllowedError(requestedModel);
  }

  return config.modelMap.get(requestedModel) ?? requestedModel;
}

export class ModelNotAllowedError extends Error {
  constructor(public readonly model: string) {
    super(`Model is not allowed: ${model}`);
    this.name = "ModelNotAllowedError";
  }
}
