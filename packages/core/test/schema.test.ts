import { expect, test } from "vitest";
import {
  boolean, chainFor, defineCollection, defineConfig, list, normalizeLocale, number,
  object, reference, richText, slug, text, ValidationError, MoggingError, ConflictError,
  NotPublishableError, StaleReleaseError, NotFoundError,
} from "../src/index.js";
import type { Field } from "../src/index.js";

const posts = defineCollection("posts", {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
  legal: text({ localized: true, fallback: ["en"] }),
  price: number({ localized: true, fallback: "none" }),
  tags: list(text(), { localized: true }),
});
const locales = { source: "en", chains: { "de-CH": ["de", "en"], de: ["en"] } };

test("normalizeLocale canonicalizes case", () => {
  expect(normalizeLocale("de-ch")).toBe("de-CH");
  expect(normalizeLocale("DE-CH")).toBe("de-CH");
  expect(normalizeLocale("zh-hant-tw")).toBe("zh-Hant-TW");
  expect(() => normalizeLocale("de_CH")).toThrow(ValidationError);
});

test("normalizeLocale rejects malformed input", () => {
  for (const bad of ["", "d", "de-", "-de", "de--CH", "de CH", "1e"]) {
    expect(() => normalizeLocale(bad), bad).toThrow(ValidationError);
  }
});

test("chainFor applies locale chain, field override and none", () => {
  const cfg = defineConfig({ collections: [posts], locales });
  expect(chainFor(cfg, "de-CH", "posts", "body")).toEqual(["de-CH", "de", "en"]);
  expect(chainFor(cfg, "de-CH", "posts", "legal")).toEqual(["de-CH", "en"]);   // legal: fallback ["en"]
  expect(chainFor(cfg, "de-CH", "posts", "price")).toEqual(["de-CH"]);        // price: fallback "none"
});

test("chainFor normalizes its locale argument and stored config", () => {
  const cfg = defineConfig({
    collections: [posts],
    locales: { source: "EN", chains: { "de-ch": ["DE", "en"], DE: ["EN"] } },
  });
  expect(cfg.locales.source).toBe("en");
  expect(chainFor(cfg, "DE-ch", "posts", "title")).toEqual(["de-CH", "de", "en"]);
  expect(chainFor(cfg, "en", "posts", "title")).toEqual(["en"]);
});

test("chainFor throws NotFoundError for unknown collection or field", () => {
  const cfg = defineConfig({ collections: [posts], locales });
  expect(() => chainFor(cfg, "de", "nope", "title")).toThrow(NotFoundError);
  expect(() => chainFor(cfg, "de", "posts", "nope")).toThrow(NotFoundError);
});

test("defineConfig rejects a collection without exactly one body field", () => {
  const none = defineCollection("a", { slug: slug(), title: text() });
  expect(() => defineConfig({ collections: [none], locales })).toThrow(ValidationError);
  const two = defineCollection("b", {
    one: richText({ body: true }),
    two: richText({ body: true }),
  });
  expect(() => defineConfig({ collections: [two], locales })).toThrow(ValidationError);
});

test("defineConfig rejects a localized slug", () => {
  const bad = defineCollection("c", {
    slug: { ...slug(), localized: true } as Field,
    body: richText({ body: true }),
  });
  expect(() => defineConfig({ collections: [bad], locales })).toThrow(ValidationError);
});

test("defineConfig rejects zero collections", () => {
  expect(() => defineConfig({ collections: [], locales })).toThrow(ValidationError);
});

test("defineConfig rejects a chain referencing an undeclared locale", () => {
  expect(() =>
    defineConfig({ collections: [posts], locales: { source: "en", chains: { de: ["fr"] } } }),
  ).toThrow(ValidationError);
});

test("builders produce the expected kinds and slug is shared", () => {
  expect(slug()).toMatchObject({ kind: "slug", localized: false });
  expect(boolean().kind).toBe("boolean");
  expect(reference("posts").kind).toBe("reference");
  expect(object({ a: text() }).kind).toBe("object");
});

test("errors carry codes and extend MoggingError", () => {
  for (const E of [ValidationError, ConflictError, NotPublishableError, StaleReleaseError, NotFoundError]) {
    const e = new E("x");
    expect(e).toBeInstanceOf(MoggingError);
    expect(typeof e.code).toBe("string");
  }
});
