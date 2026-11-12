import { describe, expect, test } from "vitest";
import type { LanguageModel } from "ai";
import { ValidationError } from "@mogging/core";
import {
  defineAiConfig, glossaryModeFor, priceFor, usdToMicros, type AiConfigInput, type ModelPrice,
} from "../src/index.js";

const P: ModelPrice = { inputUsdPerMtok: 1, outputUsdPerMtok: 3, contextTokens: 128_000 };
const P2: ModelPrice = { inputUsdPerMtok: 5, outputUsdPerMtok: 15, contextTokens: 200_000 };

function base(over: Partial<AiConfigInput> = {}): AiConfigInput {
  return {
    provider: { kind: "openrouter" },
    models: { translate: "vendor/main" },
    prices: { "vendor/main": P },
    budgets: { monthlyCapUsd: 10 },
    ...over,
  };
}

function rejects(input: AiConfigInput, key: string): void {
  let err: unknown;
  try { defineAiConfig(input); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).toContain(key);
}

describe("defineAiConfig defaults", () => {
  test("applies every default", () => {
    const c = defineAiConfig(base());
    expect(c.glossary).toBe("warn");
    expect(c.perFieldTokenLimit).toBe(6000);
    expect(c.maxOutputTokens).toBe(12000);
    expect(c.contextCharLimit).toBe(20000);
    expect(c.providerTimeoutSeconds).toBe(120);
    expect(c.leaseSeconds).toBe(300);
    expect(c.maxAttempts).toBe(3);
    expect(c.temperature).toBe(0.1);
  });

  test("explicit values override the defaults", () => {
    const c = defineAiConfig(base({
      glossary: "strict", perFieldTokenLimit: 100, maxOutputTokens: 200, contextCharLimit: 300,
      providerTimeoutSeconds: 10, leaseSeconds: 20, maxAttempts: 5, temperature: 0.7,
    }));
    expect([c.glossary, c.perFieldTokenLimit, c.maxOutputTokens, c.contextCharLimit, c.providerTimeoutSeconds,
      c.leaseSeconds, c.maxAttempts, c.temperature]).toEqual(["strict", 100, 200, 300, 10, 20, 5, 0.7]);
  });

  test("keeps the required parts and does not mutate the input", () => {
    const input = base();
    const c = defineAiConfig(input);
    expect(c.provider).toEqual({ kind: "openrouter" });
    expect(c.models.translate).toBe("vendor/main");
    expect(c.prices["vendor/main"]).toEqual(P);
    expect(c.budgets.monthlyCapUsd).toBe(10);
    expect("glossary" in input).toBe(false);
  });

  test("custom provider keeps its LanguageModel objects by reference", () => {
    const model = { specificationVersion: "v3", modelId: "vendor/main" } as unknown as LanguageModel;
    const c = defineAiConfig(base({ provider: { kind: "custom", models: { "vendor/main": model } } }));
    expect(c.provider.kind).toBe("custom");
    if (c.provider.kind === "custom") expect(c.provider.models["vendor/main"]).toBe(model);
  });
});

describe("defineAiConfig validation", () => {
  test("models.translate is required", () => {
    rejects(base({ models: {} as unknown as AiConfigInput["models"] }), "models.translate");
    rejects(base({ models: { translate: "" } }), "models.translate");
  });

  test("models.translate needs a price", () => {
    rejects(base({ models: { translate: "vendor/other" } }), "vendor/other");
  });

  test("models.summarizeChange needs a price when named", () => {
    rejects(base({ models: { translate: "vendor/main", summarizeChange: "vendor/sum" } }), "vendor/sum");
    expect(() => defineAiConfig(base({
      models: { translate: "vendor/main", summarizeChange: "vendor/sum" },
      prices: { "vendor/main": P, "vendor/sum": P2 },
    }))).not.toThrow();
  });

  test("a collection translate model needs a price", () => {
    rejects(base({ collections: { posts: { translate: "vendor/posts" } } }), "vendor/posts");
  });

  test("custom provider must hold every named model", () => {
    const m = {} as unknown as LanguageModel;
    rejects(base({ provider: { kind: "custom", models: {} } }), "vendor/main");
    rejects(base({
      provider: { kind: "custom", models: { "vendor/main": m } },
      collections: { posts: { translate: "vendor/posts" } },
      prices: { "vendor/main": P, "vendor/posts": P2 },
    }), "vendor/posts");
    rejects(base({
      provider: { kind: "custom", models: { "vendor/main": m } },
      models: { translate: "vendor/main", summarizeChange: "vendor/sum" },
      prices: { "vendor/main": P, "vendor/sum": P2 },
    }), "vendor/sum");
  });

  test("monthlyCapUsd must not be negative, and 0 is the pause switch", () => {
    rejects(base({ budgets: { monthlyCapUsd: -1 } }), "monthlyCapUsd");
    expect(defineAiConfig(base({ budgets: { monthlyCapUsd: 0 } })).budgets.monthlyCapUsd).toBe(0);
  });

  test("a collection budget must not be negative, and 0 is accepted", () => {
    rejects(base({ budgets: { monthlyCapUsd: 1, collections: { posts: -0.01 } } }), "budgets.collections.posts");
    expect(() => defineAiConfig(base({ budgets: { monthlyCapUsd: 1, collections: { posts: 0 } } }))).not.toThrow();
  });

  test("leaseSeconds must exceed providerTimeoutSeconds", () => {
    rejects(base({ leaseSeconds: 120, providerTimeoutSeconds: 120 }), "leaseSeconds");
    rejects(base({ leaseSeconds: 100 }), "leaseSeconds");
    expect(() => defineAiConfig(base({ leaseSeconds: 121 }))).not.toThrow();
  });

  test("temperature must be within [0, 1]", () => {
    rejects(base({ temperature: -0.1 }), "temperature");
    rejects(base({ temperature: 1.1 }), "temperature");
    rejects(base({ temperature: Number.NaN }), "temperature");
    expect(defineAiConfig(base({ temperature: 0 })).temperature).toBe(0);
    expect(defineAiConfig(base({ temperature: 1 })).temperature).toBe(1);
  });

  for (const key of ["perFieldTokenLimit", "maxOutputTokens", "contextCharLimit", "maxAttempts"] as const) {
    test(`${key} must be a positive integer`, () => {
      rejects(base({ [key]: 0 }), key);
      rejects(base({ [key]: -1 }), key);
      rejects(base({ [key]: 1.5 }), key);
      rejects(base({ [key]: Number.NaN }), key);
      expect(defineAiConfig(base({ [key]: 1 }))[key]).toBe(1);
    });
  }

  test("a price contextTokens below 1024 is rejected, 1024 accepted", () => {
    rejects(base({ prices: { "vendor/main": { ...P, contextTokens: 1023 } } }), "contextTokens");
    expect(() => defineAiConfig(base({ prices: { "vendor/main": { ...P, contextTokens: 1024 } } }))).not.toThrow();
  });

  test("a negative price component is rejected, naming the key", () => {
    rejects(base({ prices: { "vendor/main": { ...P, inputUsdPerMtok: -1 } } }), "inputUsdPerMtok");
    rejects(base({ prices: { "vendor/main": { ...P, outputUsdPerMtok: -1 } } }), "outputUsdPerMtok");
    expect(() => defineAiConfig(base({
      prices: { "vendor/main": { ...P, inputUsdPerMtok: 0, outputUsdPerMtok: 0 } },
    }))).not.toThrow();
  });

  test("an invalid price on an unreferenced model is still rejected", () => {
    rejects(base({ prices: { "vendor/main": P, "vendor/unused": { ...P, contextTokens: 10 } } }), "vendor/unused");
  });
});

describe("usdToMicros", () => {
  test("rounds to whole micro-dollars", () => {
    expect(usdToMicros(0.0000015)).toBe(2);
    expect(usdToMicros(0)).toBe(0);
    expect(usdToMicros(1)).toBe(1_000_000);
    expect(usdToMicros(0.0000004)).toBe(0);
  });
});

describe("priceFor and glossaryModeFor", () => {
  const cfg = defineAiConfig(base({
    prices: { "vendor/main": P, "vendor/posts": P2 },
    collections: { posts: { translate: "vendor/posts", glossary: "strict" }, pages: {} },
  }));

  test("priceFor returns the collection override, else the default", () => {
    expect(priceFor(cfg, "posts")).toEqual({ modelId: "vendor/posts", price: P2 });
    expect(priceFor(cfg, "pages")).toEqual({ modelId: "vendor/main", price: P });
    expect(priceFor(cfg, "unknown")).toEqual({ modelId: "vendor/main", price: P });
  });

  test("glossaryModeFor returns the collection override, else the config mode", () => {
    expect(glossaryModeFor(cfg, "posts")).toBe("strict");
    expect(glossaryModeFor(cfg, "pages")).toBe("warn");
    expect(glossaryModeFor(cfg, "unknown")).toBe("warn");
    expect(glossaryModeFor(defineAiConfig(base({ glossary: "strict" })), "unknown")).toBe("strict");
  });
});
