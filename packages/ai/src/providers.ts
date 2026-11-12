import type { LanguageModel } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ValidationError } from "@mogging/core";
import { priceFor, type AiConfig, type ModelPrice } from "./config.js";

const DEFAULT_API_KEY_ENV = "OPENROUTER_API_KEY";

/**
 * The model that translates `collection` (its override, else the default), with its price. OpenRouter models are
 * built with usage accounting on, the only way the provider reports `cost`; a missing key variable throws.
 */
export function resolveModel(ai: AiConfig, collection: string): { model: LanguageModel; modelId: string; price: ModelPrice } {
  const { modelId, price } = priceFor(ai, collection);
  if (ai.provider.kind === "custom") {
    const model = Object.hasOwn(ai.provider.models, modelId) ? ai.provider.models[modelId] : undefined;
    if (!model) throw new ValidationError(`model "${modelId}" is missing from provider.models`);
    return { model, modelId, price };
  }
  const apiKeyEnv = ai.provider.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey === "") throw new ValidationError(`${apiKeyEnv} is not set`);
  return { model: createOpenRouter({ apiKey })(modelId, { usage: { include: true } }), modelId, price };
}
