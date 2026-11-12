import { describe, expect, test } from "vitest";
import { list, number, richText, text } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import {
  PROMPT_VERSION, buildPrompt, contextValues, maxTemplateTokens, templateTokens, type PromptRequest,
} from "../src/prompt.js";

const req: PromptRequest = {
  sourceLocale: "en",
  targetLocale: "de",
  collection: "posts",
  translate: { title: "UNIQUE-SOURCE-TITLE-7731", tags: ["UNIQUE-TAG-4410"] },
  siblings: { legal: "UNIQUE-SIBLING-2290" },
  shared: { brand: "UNIQUE-SHARED-9915" },
  glossary: [{ term: "UNIQUE-TERM-6602", translation: "Begriff", doNotTranslate: false }],
};

describe("buildPrompt", () => {
  for (const variant of ["standard", "strict"] as const) {
    test(`${variant}: no content ever reaches the system prompt`, () => {
      const { system } = buildPrompt(variant, req);
      for (const v of ["UNIQUE-SOURCE-TITLE-7731", "UNIQUE-TAG-4410", "UNIQUE-SIBLING-2290", "UNIQUE-SHARED-9915", "UNIQUE-TERM-6602"]) {
        expect(system).not.toContain(v);
      }
    });

    test(`${variant}: locales are filled and no placeholder is left`, () => {
      const { system } = buildPrompt(variant, req);
      expect(system).toContain("en");
      expect(system).toContain("de");
      expect(system).not.toMatch(/\{\{|\}\}/);
    });

    test(`${variant}: the user message is the delimited data block`, () => {
      const { user } = buildPrompt(variant, req);
      expect(user.startsWith("<<<DATA\n")).toBe(true);
      expect(user.endsWith("\nDATA>>>")).toBe(true);
      const body = user.slice("<<<DATA\n".length, -"\nDATA>>>".length);
      expect(body).toBe(
        JSON.stringify({ translate: req.translate, siblings: req.siblings, shared: req.shared, glossary: req.glossary }, null, 1),
      );
    });
  }

  test("promptVersion names the version and the variant", () => {
    expect(PROMPT_VERSION).toBe("translate.v1");
    expect(buildPrompt("standard", req).promptVersion).toBe("translate.v1.standard");
    expect(buildPrompt("strict", req).promptVersion).toBe("translate.v1.strict");
  });

  test("the standard template carries the rules", () => {
    const { system } = buildPrompt("standard", req);
    for (const s of ["⟦MOGGING:", "glossaryTermsUsed", "<<<DATA", "DATA>>>", "{name}"]) expect(system).toContain(s);
  });

  test("the strict template adds a checklist and forbids added formatting", () => {
    const standard = buildPrompt("standard", req).system;
    const strict = buildPrompt("strict", req).system;
    expect(strict.length).toBeGreaterThan(standard.length);
    expect(strict).toMatch(/^1\. /m);
    expect(strict).toContain("backtick");
  });
});

describe("templateTokens", () => {
  test("is a real measurement of each template", () => {
    expect(templateTokens("standard")).toBeGreaterThan(50);
    expect(templateTokens("strict")).toBeGreaterThan(templateTokens("standard"));
  });

  test("maxTemplateTokens covers both variants", () => {
    expect(maxTemplateTokens()).toBe(Math.max(templateTokens("standard"), templateTokens("strict")));
  });

  test("covers the filled system prompt", () => {
    expect(templateTokens("strict") * 3).toBeGreaterThanOrEqual(buildPrompt("strict", req).system.length);
  });
});

describe("contextValues", () => {
  const fields = {
    title: text({ localized: true }),
    body: richText({ localized: true }),
    price: number({ localized: true }),
    tags: list(text(), { localized: true }),
    brand: text(),
  };

  test("rich text is sentinelized Markdown, code never reaches the model", () => {
    const body = markdownToTree("Hello world\n\n```js\nconst secretCode = 1;\n```\n");
    const out = contextValues(fields, { title: "T", body, price: 3, tags: ["a"], brand: "B" }, 10_000);
    expect(typeof out["body"]).toBe("string");
    expect(out["body"]).toContain("⟦MOGGING:0⟧");
    expect(out["body"]).toContain("Hello world");
    expect(out["body"]).not.toContain("secretCode");
    expect(out).toEqual({ title: "T", body: out["body"], tags: ["a"], brand: "B" });
  });

  test("a number field is omitted", () => {
    const out = contextValues(fields, { title: "T", price: 3 }, 10_000);
    expect(out).toEqual({ title: "T" });
  });

  test("a rich-text value that already holds a sentinel token is omitted, not thrown", () => {
    const body = markdownToTree("Already ⟦MOGGING:3⟧ here\n");
    expect(contextValues(fields, { title: "T", body }, 10_000)).toEqual({ title: "T" });
  });

  test("a value that does not fit is truncated with the suffix and later values are dropped", () => {
    const limit = 60;
    const out = contextValues(fields, { title: "short", tags: ["x".repeat(200)], brand: "dropped" }, limit);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(limit);
    expect(out["title"]).toBe("short");
    expect(typeof out["tags"]).toBe("string");
    expect(String(out["tags"]).endsWith(" […]")).toBe(true);
    expect(out).not.toHaveProperty("brand");

    const text1 = contextValues(fields, { title: "y".repeat(500) }, 40);
    expect(JSON.stringify(text1).length).toBeLessThanOrEqual(40);
    expect(String(text1["title"])).toMatch(/^y+ \[…\]$/);
    // The truncation is tight: one more character would not fit.
    const prefix = String(text1["title"]).slice(0, -" […]".length);
    expect(JSON.stringify({ title: `${prefix}y […]` }).length).toBeGreaterThan(40);
  });
});
