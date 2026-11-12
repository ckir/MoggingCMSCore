import { describe, expect, test } from "vitest";
import { defineAiConfig, type AiConfigInput, type ModelPrice } from "../src/config.js";
import {
  actualCostMicros, apportion, charsPerToken, estimateRequest, fieldTokens, planRequests, type RequestPlan,
} from "../src/estimate.js";

// The fixture price of Task 7's aiConfigFor: a small 8000-token window.
const PRICE: ModelPrice = { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 8000 };
const aiWith = (overrides: Partial<AiConfigInput> = {}) =>
  defineAiConfig({
    provider: { kind: "openrouter" },
    models: { translate: "mock/translate" },
    prices: { "mock/translate": PRICE },
    budgets: { monthlyCapUsd: 1 },
    ...overrides,
  });

/** A string whose fieldTokens (en -> de, 3 chars per token, JSON quotes included) is exactly `n`. */
const ofTokens = (n: number): string => "x".repeat(3 * n - 2);

function plan(
  fields: Array<[string, unknown]>,
  opts: { overrides?: Partial<AiConfigInput>; contextChars?: number; glossaryChars?: number; templateTokens?: number } = {},
) {
  return planRequests({
    ai: aiWith(opts.overrides),
    price: PRICE,
    sourceLocale: "en",
    targetLocale: "de",
    fields: fields.map(([name, wire]) => ({ name, wire })),
    contextChars: opts.contextChars ?? 0,
    glossaryChars: opts.glossaryChars ?? 0,
    templateTokens: opts.templateTokens ?? 100,
  });
}

function requests(r: ReturnType<typeof planRequests>): RequestPlan[] {
  if (!("requests" in r)) throw new Error(`expected requests, got tooLarge ${r.tooLarge}`);
  return r.requests;
}

describe("charsPerToken", () => {
  test("CJK on either side is 1.5, otherwise 3", () => {
    expect(charsPerToken("en", "ja")).toBe(1.5);
    expect(charsPerToken("en", "de")).toBe(3);
    expect(charsPerToken("zh-Hant", "en")).toBe(1.5);
    expect(charsPerToken("en", "ko-KR")).toBe(1.5);
    expect(charsPerToken("fr-CA", "pt-BR")).toBe(3);
  });
});

describe("fieldTokens", () => {
  test("is the JSON length over chars per token, rounded up, without any template", () => {
    expect(fieldTokens(ofTokens(500), "en", "de")).toBe(500);
    expect(fieldTokens("ab", "en", "de")).toBe(2); // "\"ab\"" is 4 chars
    expect(fieldTokens("ab", "en", "ja")).toBe(3); // 4 / 1.5 rounded up
    expect(fieldTokens(["a", "b"], "en", "de")).toBe(3); // ["a","b"] is 9 chars
  });
});

describe("estimateRequest", () => {
  test("spec 8.5 formula with the 512-token output margin", () => {
    const e = estimateRequest({
      sourceLocale: "en", targetLocale: "de", translateChars: 300, contextChars: 600, templateTokens: 100,
      price: { inputUsdPerMtok: 2, outputUsdPerMtok: 10, contextTokens: 200_000 },
    });
    expect(e).toEqual({ inputTokens: 400, outputTokens: 642, costMicros: 10830 });
  });

  test("CJK halves the characters per token", () => {
    const e = estimateRequest({
      sourceLocale: "en", targetLocale: "ja", translateChars: 300, contextChars: 600, templateTokens: 100,
      price: { inputUsdPerMtok: 2, outputUsdPerMtok: 10, contextTokens: 200_000 },
    });
    expect(e.inputTokens).toBe(700);
    expect(e.outputTokens).toBe(260 + 512);
  });
});

describe("actualCostMicros", () => {
  const price: ModelPrice = { inputUsdPerMtok: 2, outputUsdPerMtok: 10, contextTokens: 200_000 };

  test("tokens x price without the safety factor", () => {
    expect(actualCostMicros({ inputTokens: 1000, outputTokens: 500 }, price)).toBe(7000);
  });

  test("the provider-reported cost wins", () => {
    expect(actualCostMicros({ inputTokens: 1000, outputTokens: 500 }, price, 0.0012)).toBe(1200);
  });

  test("an unreported token count counts as 0, never NaN", () => {
    expect(actualCostMicros({ inputTokens: undefined, outputTokens: 500 }, price)).toBe(5000);
    expect(actualCostMicros({ inputTokens: undefined, outputTokens: undefined }, price)).toBe(0);
  });
});

describe("apportion", () => {
  test("floor shares, remainder on the first element", () => {
    expect(apportion(10, [3, 1])).toEqual([8, 2]);
  });

  test("all-zero shares split evenly", () => {
    expect(apportion(7, [0, 0, 0])).toEqual([3, 2, 2]);
  });

  test("the parts always sum to the total", () => {
    const parts = apportion(1001, [1, 1, 1, 7]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(apportion(5, [])).toEqual([]);
  });
});

describe("planRequests", () => {
  test("three small fields go in one request", () => {
    const r = requests(plan([["title", ofTokens(10)], ["legal", ofTokens(20)], ["tags", ["a", "b"]]]));
    expect(r).toHaveLength(1);
    expect(r[0]!.fields).toEqual(["title", "legal", "tags"]);
    expect(r[0]!.noContext).toBe(false);
    expect(r[0]!.inputTokens).toBe(10 + 20 + 3 + 100);
  });

  test("an oversized field gets its own request without closing the packed one", () => {
    const r = requests(plan(
      [["title", ofTokens(10)], ["body", ofTokens(1200)], ["legal", ofTokens(10)], ["tags", ofTokens(10)]],
      { overrides: { perFieldTokenLimit: 1000 } },
    ));
    expect(r.map((q) => q.fields)).toEqual([["title", "legal", "tags"], ["body"]]);
    expect(r[1]!.inputTokens).toBe(1200 + 100);
  });

  test("a new request starts when the next field would not fit", () => {
    // Alone: 2500 + 100 + (3250 + 512) = 6362 <= 8000. Together: 5000 + 100 + (6500 + 512) = 12112 > 8000.
    const r = requests(plan([["a", ofTokens(2500)], ["b", ofTokens(2500)], ["c", ofTokens(10)]]));
    expect(r.map((q) => q.fields)).toEqual([["a"], ["b", "c"]]);
  });

  test("a field that fits only without context is sent alone without context, keeping the glossary", () => {
    // contextChars 6000 -> 2000 tokens; glossaryChars 300 -> 100 tokens.
    // With context: 2500 + 2100 + 3762 = 8362 > 8000. Without: 2500 + (100 + 100) + 3762 = 6462 <= 8000.
    const r = requests(plan([["title", ofTokens(10)], ["body", ofTokens(2500)]], { contextChars: 6000, glossaryChars: 300 }));
    expect(r.map((q) => q.fields)).toEqual([["title"], ["body"]]);
    expect(r[0]!.noContext).toBe(false);
    expect(r[0]!.inputTokens).toBe(10 + 2000 + 100);
    expect(r[1]!.noContext).toBe(true);
    expect(r[1]!.inputTokens).toBe(2500 + 100 + 100);
    expect(r[1]!.maxOutputTokens).toBe(8000 - 2700);
  });

  test("tooLarge only for a field that cannot fit alone even without context", () => {
    // Without context: 5000 + 100 + (6500 + 512) = 12112 > 8000.
    expect(plan([["title", ofTokens(10)], ["body", ofTokens(5000)]], { contextChars: 6000, glossaryChars: 300 }))
      .toEqual({ tooLarge: "body" });
  });

  test("the template is counted exactly once per request", () => {
    const fields: Array<[string, unknown]> = [["title", ofTokens(10)], ["legal", ofTokens(20)]];
    const r = requests(plan(fields, { contextChars: 30, templateTokens: 90 }));
    const fixed = Math.ceil(30 / 3) + 90;
    expect(r).toHaveLength(1);
    expect(r[0]!.inputTokens).toBe(
      fieldTokens(fields[0]![1], "en", "de") + fieldTokens(fields[1]![1], "en", "de") + fixed,
    );
  });

  test("the ceiling sent is the configured maximum bounded by the window, not the packing reserve", () => {
    const r = requests(plan([["body", ofTokens(500)]], { templateTokens: 100 }));
    expect(r[0]!.inputTokens).toBe(600);
    expect(r[0]!.maxOutputTokens).toBe(7400); // 8000 - 600, below the default 12000
    const capped = requests(plan([["body", ofTokens(500)]], { templateTokens: 100, overrides: { maxOutputTokens: 4000 } }));
    expect(capped[0]!.maxOutputTokens).toBe(4000);
  });
});
