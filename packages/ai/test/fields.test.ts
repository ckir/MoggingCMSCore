import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  boolean, dateTime, json, list, number, object, reference, richText, slug, text, type Field,
} from "@mogging/core";
import { contextValues } from "../src/prompt.js";
import {
  checkShape, isTranslatable, outputSchema, stringLeaves, withFixedLeaves, wireField, wireValue,
} from "../src/fields.js";

// Mirrors the posts fixture at packages/core/test/fixtures.ts:8-15.
const posts = {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
  legal: text({ localized: true, fallback: ["en"] }),
  price: number({ localized: true, fallback: "none" }),
  tags: list(text(), { localized: true }),
};

describe("isTranslatable", () => {
  test("fixture fields", () => {
    expect(isTranslatable(posts.title)).toBe(true);
    expect(isTranslatable(posts.body)).toBe(true);
    expect(isTranslatable(posts.legal)).toBe(true);
    expect(isTranslatable(posts.tags)).toBe(true);
    expect(isTranslatable(posts.price)).toBe(false);
    expect(isTranslatable(posts.slug)).toBe(false);
  });

  test("list and object leaves", () => {
    expect(isTranslatable(list(number(), { localized: true }))).toBe(false);
    expect(isTranslatable(object({ n: number() }, { localized: true }))).toBe(false);
    expect(isTranslatable(list(richText(), { localized: true }))).toBe(false);
    expect(isTranslatable(object({ t: text() }))).toBe(false);
    expect(isTranslatable(object({ n: number(), t: text() }, { localized: true }))).toBe(true);
  });

  test("a rich text leaf anywhere below disqualifies, even beside a text leaf", () => {
    expect(isTranslatable(object({ t: text(), r: richText() }, { localized: true }))).toBe(false);
    expect(isTranslatable(list(object({ t: text(), r: list(richText()) }), { localized: true }))).toBe(false);
    expect(isTranslatable(list(object({ t: text() }), { localized: true }))).toBe(true);
  });

  test("shared text and rich text are not translatable; other localized kinds are not", () => {
    expect(isTranslatable(text())).toBe(false);
    expect(isTranslatable(richText())).toBe(false);
    expect(isTranslatable(boolean({ localized: true }))).toBe(false);
    expect(isTranslatable(dateTime({ localized: true }))).toBe(false);
    expect(isTranslatable(reference("posts", { localized: true }))).toBe(false);
    expect(isTranslatable(list(object({}), { localized: true }))).toBe(false);
  });
});

describe("outputSchema", () => {
  const schema = outputSchema({ title: text(), tags: list(text()) });

  test("accepts a conforming result", () => {
    const v = { fields: { title: "x", tags: ["a"] }, glossaryTermsUsed: [] };
    expect(schema.parse(v)).toEqual(v);
  });

  test("rejects a list field given as a string", () => {
    expect(schema.safeParse({ fields: { tags: "a" }, glossaryTermsUsed: [] }).success).toBe(false);
  });

  test("rejects missing glossaryTermsUsed and missing fields", () => {
    expect(schema.safeParse({ fields: { title: "x", tags: [] } }).success).toBe(false);
    expect(schema.safeParse({ fields: { title: "x" }, glossaryTermsUsed: [] }).success).toBe(false);
  });

  test("nested object keys are optional and nested values and list items may be null", () => {
    const s = outputSchema({ o: object({ n: number(), t: text() }), l: list(text()) });
    expect(s.safeParse({ fields: { o: { t: "x" }, l: ["a", null] }, glossaryTermsUsed: [] }).success).toBe(true);
    expect(s.safeParse({ fields: { o: { n: null, t: null }, l: [] }, glossaryTermsUsed: [] }).success).toBe(true);
    expect(s.safeParse({ fields: { o: {}, l: [null] }, glossaryTermsUsed: [] }).success).toBe(true);
    // top-level field values stay mandatory and non-null
    expect(s.safeParse({ fields: { o: { t: "x" } }, glossaryTermsUsed: [] }).success).toBe(false);
    expect(s.safeParse({ fields: { o: null, l: [] }, glossaryTermsUsed: [] }).success).toBe(false);
    // present values keep their type
    expect(s.safeParse({ fields: { o: { n: "1" }, l: [] }, glossaryTermsUsed: [] }).success).toBe(false);
  });

  test("maps every kind and strips unknown keys", () => {
    const s = outputSchema({
      r: richText(), n: number(), b: boolean(), d: dateTime(), ref: reference("posts"),
      o: object({ t: text(), items: list(number()) }),
    });
    const ok = {
      fields: { r: "# h", n: 1, b: true, d: "2026-01-01T00:00:00Z", ref: "id", o: { t: "x", items: [1] }, extra: 1 },
      glossaryTermsUsed: ["a"],
    };
    expect(s.parse(ok).fields).toEqual({
      r: "# h", n: 1, b: true, d: "2026-01-01T00:00:00Z", ref: "id", o: { t: "x", items: [1] },
    });
    expect(s.safeParse({ ...ok, fields: { ...ok.fields, n: "1" } }).success).toBe(false);
    expect(s.safeParse({ ...ok, fields: { ...ok.fields, b: "true" } }).success).toBe(false);
    expect(s.safeParse({ ...ok, fields: { ...ok.fields, o: { t: "x", items: ["1"] } } }).success).toBe(false);
    expect(s.safeParse({ ...ok, glossaryTermsUsed: [1] }).success).toBe(false);
  });
});

describe("stringLeaves", () => {
  test("a bare string is the root leaf", () => {
    expect(stringLeaves("hi")).toEqual([{ path: "$", text: "hi" }]);
  });

  test("lists index their leaves", () => {
    expect(stringLeaves(["a", "b", "c"])).toEqual([
      { path: "$[0]", text: "a" }, { path: "$[1]", text: "b" }, { path: "$[2]", text: "c" },
    ]);
  });

  test("nested object in document order, skipping non-string leaves", () => {
    const v = { title: "T", n: 3, ok: true, nothing: null, items: [{ label: "L0", k: 1 }, { label: "L1" }], last: "Z" };
    expect(stringLeaves(v)).toEqual([
      { path: "$.title", text: "T" },
      { path: "$.items[0].label", text: "L0" },
      { path: "$.items[1].label", text: "L1" },
      { path: "$.last", text: "Z" },
    ]);
  });

  test("skips null and undefined leaves", () => {
    expect(stringLeaves(["a", null, undefined, "b"])).toEqual([
      { path: "$[0]", text: "a" }, { path: "$[3]", text: "b" },
    ]);
    expect(stringLeaves({ a: null, b: "x" })).toEqual([{ path: "$.b", text: "x" }]);
  });

  test("honours a starting path", () => {
    expect(stringLeaves({ a: "x" }, "$.f")).toEqual([{ path: "$.f.a", text: "x" }]);
  });
});

describe("checkShape", () => {
  const tags = list(text());
  const obj = object({ n: number(), t: text() });

  test("identity drafts pass", () => {
    expect(checkShape(text(), "a", "a")).toEqual([]);
    expect(checkShape(tags, ["a", "b"], ["a", "b"])).toEqual([]);
    expect(checkShape(obj, { n: 1, t: "x" }, { n: 1, t: "x" })).toEqual([]);
  });

  test("translated text and rich text leaves may differ", () => {
    expect(checkShape(text(), "a", "b")).toEqual([]);
    expect(checkShape(obj, { n: 1, t: "y" }, { n: 1, t: "x" })).toEqual([]);
    expect(checkShape(richText(), { any: 1 }, { other: 2 })).toEqual([]);
  });

  test("rejects a list whose length differs (source 2, draft 1)", () => {
    expect(checkShape(tags, ["a", "b"], ["a"])).toEqual(["$: list length 1 expected 2"]);
  });

  test("rejects an object with different keys", () => {
    expect(checkShape(obj, { n: 1, t: "x" }, { n: 1 })).toEqual(["$: object keys differ"]);
    expect(checkShape(obj, { n: 1, t: "x" }, { n: 1, t: "x", u: "y" })).toEqual(["$: object keys differ"]);
  });

  test("rejects a changed non-text leaf", () => {
    expect(checkShape(obj, { n: 1, t: "y" }, { n: 2, t: "x" })).toEqual(["$.n: non-text value changed"]);
  });

  test("rejects a changed leaf of every non-text kind", () => {
    expect(checkShape(number(), 1, 2)).toEqual(["$: non-text value changed"]);
    expect(checkShape(boolean(), true, false)).toEqual(["$: non-text value changed"]);
    expect(checkShape(dateTime(), "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toEqual(["$: non-text value changed"]);
    expect(checkShape(reference("posts"), "a", "b")).toEqual(["$: non-text value changed"]);
    expect(checkShape(slug(), "a", "b")).toEqual(["$: non-text value changed"]);
  });

  test("a slug nested in a localized object is guarded", () => {
    const f = object({ s: slug(), t: text() }, { localized: true });
    expect(checkShape(f, { s: "a", t: "x" }, { s: "b", t: "y" })).toEqual(["$.s: non-text value changed"]);
  });

  test("reports nested paths and every violation", () => {
    const f = list(object({ n: number(), t: text() }));
    const src = [{ n: 1, t: "a" }, { n: 2, t: "b" }];
    const draft = [{ n: 9, t: "A" }, { n: 8, t: "B" }];
    expect(checkShape(f, src, draft)).toEqual(["$[0].n: non-text value changed", "$[1].n: non-text value changed"]);
  });

  test("reports a wrongly shaped draft instead of throwing", () => {
    expect(checkShape(tags, ["a"], "a")).toEqual(["$: expected a list"]);
    expect(checkShape(obj, { n: 1, t: "x" }, ["a"])).toEqual(["$: expected an object"]);
    expect(checkShape(obj, { n: 1, t: "x" }, null)).toEqual(["$: non-text value changed"]);
  });

  test("an object source omitting an optional key passes with an identity draft and rejects an added key", () => {
    expect(checkShape(obj, { t: "x" }, { t: "y" })).toEqual([]);
    expect(checkShape(obj, { t: "x" }, { t: "y", n: 1 })).toEqual(["$: object keys differ"]);
    expect(checkShape(obj, { t: "x" }, { n: 1 })).toEqual(["$: object keys differ"]);
  });

  test("null elements and values must stay null", () => {
    expect(checkShape(tags, ["a", null], ["b", null])).toEqual([]);
    expect(checkShape(tags, ["a", null], ["b", "c"])).toEqual(["$[1]: non-text value changed"]);
    expect(checkShape(tags, ["a", "b"], ["a", null])).toEqual(["$[1]: non-text value changed"]);
    expect(checkShape(obj, { n: null, t: "x" }, { n: null, t: "y" })).toEqual([]);
    expect(checkShape(obj, { n: null, t: "x" }, { n: 1, t: "y" })).toEqual(["$.n: non-text value changed"]);
    expect(checkShape(obj, { n: 1, t: null }, { n: 1, t: "y" })).toEqual(["$.t: non-text value changed"]);
  });

  test("a text leaf must stay a string", () => {
    expect(checkShape(text(), "a", 5)).toEqual(["$: expected text"]);
  });
});

describe("json", () => {
  test("a json leaf is never sent and is compared by value", () => {
    const fields = { sh: object({ t: text(), j: json() }), plain: text() };
    const out = contextValues(fields, { sh: { t: "hi", j: { a: 1 } }, plain: "x" }, 10_000);
    expect(out).toEqual({ plain: "x" });
    expect(isTranslatable(object({ t: text(), j: json() }, { localized: true }))).toBe(false);
    expect(checkShape(json(), { a: 1 }, { a: 1 })).toEqual([]);
    expect(checkShape(json(), { a: 1 }, { a: 2 })).toEqual(["$: non-text value changed"]);
  });
});

describe("translate: false leaves", () => {
  const hero = object({
    title: text(),
    actions: list(object({ text: text(), link: text({ translate: false }) })),
  }, { localized: true });
  const source = { title: "T", actions: [{ text: "Go", link: "/start" }] };

  test("isTranslatable ignores a translate: false leaf", () => {
    expect(isTranslatable(hero)).toBe(true);
    expect(isTranslatable(text({ localized: true, translate: false }))).toBe(false);
    expect(isTranslatable(list(text({ translate: false }), { localized: true }))).toBe(false);
    expect(isTranslatable(object({ a: text({ translate: false }), n: number() }, { localized: true }))).toBe(false);
  });

  test("wireField removes the leaf and every emptied object or list", () => {
    expect(wireField(text({ translate: false }))).toBeNull();
    expect(wireField(object({ a: text({ translate: false }) }))).toBeNull();
    expect(wireField(list(object({ a: text({ translate: false }) })))).toBeNull();
    const w = wireField(hero) as Extract<Field, { kind: "object" }>;
    expect(Object.keys(w.fields)).toEqual(["title", "actions"]);
    const item = (w.fields.actions as Extract<Field, { kind: "list" }>).item as Extract<Field, { kind: "object" }>;
    expect(Object.keys(item.fields)).toEqual(["text"]);
  });

  test("wireValue projects the value onto the wire field", () => {
    expect(wireValue(hero, source)).toEqual({ title: "T", actions: [{ text: "Go" }] });
  });

  test("list items are never dropped: an item with nothing to translate becomes {}, a null stays null", () => {
    expect(wireValue(hero, { title: "T", actions: [{ text: "a", link: "/b" }, { link: "/c" }] }))
      .toEqual({ title: "T", actions: [{ text: "a" }, {}] });
    expect(wireValue(hero, { title: "T", actions: [null, { text: "a", link: "/b" }] }))
      .toEqual({ title: "T", actions: [null, { text: "a" }] });
    expect(wireValue(list(object({ text: text(), link: text({ translate: false }) })), [{ text: "a", link: "/b" }, { link: "/c" }]))
      .toEqual([{ text: "a" }, {}]);
  });

  test("withFixedLeaves copies the leaf back from the source", () => {
    expect(withFixedLeaves(hero, source, { title: "Ü", actions: [{ text: "Los" }] }))
      .toEqual({ title: "Ü", actions: [{ text: "Los", link: "/start" }] });
  });

  test("a null list element stays null and the next item is completed", () => {
    const src = { title: "T", actions: [null, { text: "a", link: "/b" }] };
    expect(withFixedLeaves(hero, src, { title: "x", actions: [null, { text: "b" }] }))
      .toEqual({ title: "x", actions: [null, { text: "b", link: "/b" }] });
  });

  test("an object made only of fixed leaves is absent from the wire and comes back from the source", () => {
    const card = object({
      title: text(), image: object({ alt: text(), file: text({ translate: false }) }),
    }, { localized: true });
    const src = { title: "T", image: { file: "a.png" } };
    expect(wireValue(card, src)).toEqual({ title: "T" });
    expect(withFixedLeaves(card, src, { title: "Ü" })).toEqual({ title: "Ü", image: { file: "a.png" } });
    const both = { title: "T", image: { alt: "A", file: "a.png" } };
    expect(wireValue(card, both)).toEqual({ title: "T", image: { alt: "A" } });
    expect(withFixedLeaves(card, both, { title: "Ü", image: { alt: "B" } }))
      .toEqual({ title: "Ü", image: { alt: "B", file: "a.png" } });
  });

  test("where the draft disagrees with the wire value it is returned unchanged", () => {
    const wrongLength = { title: "x", actions: [{ text: "a" }, { text: "b" }] };
    expect(withFixedLeaves(hero, source, wrongLength)).toEqual(wrongLength);
    const extraKey = { title: "x", actions: [{ text: "a" }], more: "m" };
    expect(withFixedLeaves(hero, source, extraKey)).toEqual(extraKey);
    expect(checkShape(hero, source, withFixedLeaves(hero, source, wrongLength))).toEqual([
      "$.actions: list length 2 expected 1",
    ]);
  });

  test("checkShape rejects a changed translate: false leaf", () => {
    expect(checkShape(hero, source, { title: "Ü", actions: [{ text: "Los", link: "/x" }] }))
      .toContain("$.actions[0].link: non-text value changed");
    expect(checkShape(hero, source, { title: "Ü", actions: [{ text: "Los", link: "/start" }] })).toEqual([]);
  });

  test("outputSchema over the wire field has no translate: false key", () => {
    const schema = outputSchema({ hero: wireField(hero)! });
    expect(schema.safeParse({ fields: { hero: { title: "a", actions: [{ text: "b" }] } }, glossaryTermsUsed: [] }).success).toBe(true);
    expect(JSON.stringify(z.toJSONSchema(schema))).not.toContain("link");
  });
});
