import type { LanguageModel } from "ai";
import { ValidationError, type Ctx } from "@mogging/core";

export type ModelPrice = { inputUsdPerMtok: number; outputUsdPerMtok: number; contextTokens: number };
export type ProviderConfig =
  | { kind: "openrouter"; apiKeyEnv?: string }                 // default "OPENROUTER_API_KEY"
  | { kind: "custom"; models: Record<string, LanguageModel> }; // keyed by model id
export type GlossaryMode = "warn" | "strict";
export type AiConfig = {
  provider: ProviderConfig;
  models: { translate: string; summarizeChange?: string };     // summarizeChange is reserved, unused in v0.1
  prices: Record<string, ModelPrice>;
  budgets: { monthlyCapUsd: number; collections?: Record<string, number> };
  collections?: Record<string, { translate?: string; glossary?: GlossaryMode }>;
  glossary: GlossaryMode;
  perFieldTokenLimit: number;
  maxOutputTokens: number;
  contextCharLimit: number;
  providerTimeoutSeconds: number;
  leaseSeconds: number;
  maxAttempts: number;
  temperature: number;
};
type Defaulted =
  | "glossary" | "perFieldTokenLimit" | "maxOutputTokens" | "contextCharLimit" | "providerTimeoutSeconds"
  | "leaseSeconds" | "maxAttempts" | "temperature";
export type AiConfigInput = Omit<AiConfig, Defaulted> & Partial<Pick<AiConfig, Defaulted>>;
export type AiCtx = Ctx & { ai: AiConfig };

const MIN_CONTEXT_TOKENS = 1024;

function positiveInteger(key: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0) throw new ValidationError(`${key} must be a positive integer, got ${v}`);
}

/** Validates and completes an AI configuration. Throws ValidationError naming the offending key. */
export function defineAiConfig(c: AiConfigInput): AiConfig {
  const cfg: AiConfig = {
    ...c,
    // Shallow copies only: provider.models holds LanguageModel objects that must stay intact.
    provider: c.provider.kind === "custom" ? { kind: "custom", models: { ...c.provider.models } } : { ...c.provider },
    models: { ...c.models },
    prices: { ...c.prices },
    budgets: { ...c.budgets, ...(c.budgets.collections ? { collections: { ...c.budgets.collections } } : {}) },
    glossary: c.glossary ?? "warn",
    perFieldTokenLimit: c.perFieldTokenLimit ?? 6000,
    maxOutputTokens: c.maxOutputTokens ?? 12000,
    contextCharLimit: c.contextCharLimit ?? 20000,
    providerTimeoutSeconds: c.providerTimeoutSeconds ?? 120,
    leaseSeconds: c.leaseSeconds ?? 300,
    maxAttempts: c.maxAttempts ?? 3,
    temperature: c.temperature ?? 0.1,
  };

  if (typeof cfg.models.translate !== "string" || cfg.models.translate === "") {
    throw new ValidationError("models.translate is required");
  }

  const named = new Map<string, string>(); // model id -> the config key that names it
  named.set(cfg.models.translate, "models.translate");
  if (cfg.models.summarizeChange !== undefined) named.set(cfg.models.summarizeChange, "models.summarizeChange");
  for (const [collection, o] of Object.entries(cfg.collections ?? {})) {
    if (o.translate !== undefined && !named.has(o.translate)) named.set(o.translate, `collections.${collection}.translate`);
  }
  for (const [id, key] of named) {
    if (!Object.hasOwn(cfg.prices, id)) throw new ValidationError(`${key} names model "${id}" which has no entry in prices`);
  }
  if (cfg.provider.kind === "custom") {
    for (const [id, key] of named) {
      if (!Object.hasOwn(cfg.provider.models, id)) {
        throw new ValidationError(`${key} names model "${id}" which is missing from provider.models`);
      }
    }
  }

  for (const [id, p] of Object.entries(cfg.prices)) {
    if (!(p.inputUsdPerMtok >= 0)) throw new ValidationError(`prices["${id}"].inputUsdPerMtok must not be negative`);
    if (!(p.outputUsdPerMtok >= 0)) throw new ValidationError(`prices["${id}"].outputUsdPerMtok must not be negative`);
    if (!(p.contextTokens >= MIN_CONTEXT_TOKENS)) {
      throw new ValidationError(`prices["${id}"].contextTokens must be at least ${MIN_CONTEXT_TOKENS}`);
    }
  }

  // A cap of 0 is the pause switch of spec 8.2: nothing is claimed in that scope.
  if (!(cfg.budgets.monthlyCapUsd >= 0)) throw new ValidationError("budgets.monthlyCapUsd must not be negative");
  for (const [collection, cap] of Object.entries(cfg.budgets.collections ?? {})) {
    if (!(cap >= 0)) throw new ValidationError(`budgets.collections.${collection} must not be negative`);
  }

  if (!(cfg.leaseSeconds > cfg.providerTimeoutSeconds)) {
    throw new ValidationError(
      `leaseSeconds (${cfg.leaseSeconds}) must be greater than providerTimeoutSeconds (${cfg.providerTimeoutSeconds})`,
    );
  }
  if (!(cfg.temperature >= 0 && cfg.temperature <= 1)) {
    throw new ValidationError(`temperature must be within [0, 1], got ${cfg.temperature}`);
  }
  positiveInteger("perFieldTokenLimit", cfg.perFieldTokenLimit);
  positiveInteger("maxOutputTokens", cfg.maxOutputTokens);
  positiveInteger("contextCharLimit", cfg.contextCharLimit);
  positiveInteger("maxAttempts", cfg.maxAttempts);
  return cfg;
}

/** Whole micro-dollars (rounded). */
export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** The model and price that translate `collection`: its override, else the default. */
export function priceFor(ai: AiConfig, collection: string): { modelId: string; price: ModelPrice } {
  const modelId = ai.collections?.[collection]?.translate ?? ai.models.translate;
  const price = ai.prices[modelId];
  if (!price) throw new ValidationError(`model "${modelId}" has no entry in prices`);
  return { modelId, price };
}

export function glossaryModeFor(ai: AiConfig, collection: string): GlossaryMode {
  return ai.collections?.[collection]?.glossary ?? ai.glossary;
}
