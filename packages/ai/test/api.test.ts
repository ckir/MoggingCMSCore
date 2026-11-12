import { expect, test } from "vitest";
import * as api from "../src/index.js";
import * as pkg from "@mogging/ai";
import type {
  AiConfig, AiConfigInput, AiCtx, Estimate, GlossaryMode, ModelPrice, ProviderConfig, RequestPlan,
} from "../src/index.js";

// THE CONTRACT: the complete runtime surface of @mogging/ai. Every task that adds an export updates this
// list in the same commit.
const FUNCTIONS = ["defineAiConfig", "usdToMicros", "priceFor", "glossaryModeFor", "estimateRequest", "planRequests"];
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
  const estimate: Estimate = api.estimateRequest({
    sourceLocale: "en", targetLocale: "de", translateChars: 3, contextChars: 0, templateTokens: 0, price,
  });
  const planned = api.planRequests({
    ai: cfg, price, sourceLocale: "en", targetLocale: "de", fields: [{ name: "t", wire: "x" }],
    contextChars: 0, glossaryChars: 0, templateTokens: 0,
  });
  const plans: RequestPlan[] = "requests" in planned ? planned.requests : [];
  expect([estimate.inputTokens, plans.map((p) => p.fields)]).toEqual([1, [["t"]]]);
});
