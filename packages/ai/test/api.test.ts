import { expect, test } from "vitest";
import * as api from "../src/index.js";
import * as pkg from "@mogging/ai";
import type { AiConfig, AiConfigInput, AiCtx, GlossaryMode, ModelPrice, ProviderConfig } from "../src/index.js";

// THE CONTRACT: the complete runtime surface of @mogging/ai. Every task that adds an export updates this
// list in the same commit.
const FUNCTIONS = ["defineAiConfig", "usdToMicros", "priceFor", "glossaryModeFor"];
const EXPECTED = [...FUNCTIONS].sort();

for (const [label, mod] of [["relative", api], ["package self-reference", pkg]] as const) {
  test(`${label}: every function is exported as a function`, () => {
    for (const name of FUNCTIONS) expect(typeof (mod as Record<string, unknown>)[name], name).toBe("function");
  });

  test(`${label}: the runtime surface is exactly the contract`, () => {
    expect(Object.keys(mod).sort()).toEqual(EXPECTED);
  });
}

test("the listed types are importable and usable", () => {
  const price: ModelPrice = { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 8192 };
  const provider: ProviderConfig = { kind: "openrouter" };
  const mode: GlossaryMode = "warn";
  const input: AiConfigInput = {
    provider, models: { translate: "m" }, prices: { m: price }, budgets: { monthlyCapUsd: 1 },
  };
  const cfg: AiConfig = api.defineAiConfig(input);
  const shape: Pick<AiCtx, "ai"> = { ai: cfg };
  expect([shape.ai.glossary, mode]).toEqual(["warn", "warn"]);
});
