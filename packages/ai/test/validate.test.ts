import { describe, expect, test } from "vitest";
import { list, number, object, richText, text, type Field } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { prepareField, validateField, type GlossaryEntry, type PreparedField } from "../src/validate.js";
import type { GlossaryMode } from "../src/config.js";

const entry = (over: Partial<GlossaryEntry> & { term: string }): GlossaryEntry => ({
  sourceLocale: "en", targetLocale: "el", translation: null, acceptedForms: [], doNotTranslate: false, note: null, ...over,
});

const BODY_MD = [
  "Hello **world**, see [the docs](https://a.example/docs) and use `foo()` today.",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "A closing paragraph.",
].join("\n");

const bodyField = richText({ localized: true, body: true });
const bodyPrepared = (md = BODY_MD): Extract<PreparedField, { kind: "richText" }> => {
  const p = prepareField("body", bodyField, markdownToTree(md));
  if (p.kind !== "richText") throw new Error("expected richText");
  return p;
};

function check(
  name: string, field: Field, source: unknown, draft: unknown,
  glossary: GlossaryEntry[] = [], glossaryMode: GlossaryMode = "warn",
) {
  return validateField({ prepared: prepareField(name, field, source), field, draft, glossary, glossaryMode });
}
const textCheck = (source: string, draft: string, glossary: GlossaryEntry[] = [], mode: GlossaryMode = "warn") =>
  check("title", text({ localized: true }), source, draft, glossary, mode);

describe("prepareField", () => {
  test("a value kind keeps the value as the wire; rich text wires the sentinelised Markdown", () => {
    const t = prepareField("title", text(), "Hi");
    expect(t).toEqual({ kind: "value", field: "title", source: "Hi", wire: "Hi" });
    const r = bodyPrepared();
    expect(r.wire).toBe(r.prepared.markdown);
    expect(r.prepared.originals).toHaveLength(2);
    expect(r.wire).toContain("⟦MOGGING:0⟧");
  });
});

describe("identity drafts", () => {
  test("an identity draft of every fixture field kind passes with no warnings", () => {
    const cases: Array<[string, Field, unknown]> = [
      ["title", text({ localized: true }), "A plain title"],
      ["tags", list(text(), { localized: true }), ["one", "two"]],
      ["meta", object({ n: number(), t: text() }, { localized: true }), { n: 3, t: "words" }],
    ];
    for (const [name, field, value] of cases) {
      const v = check(name, field, value, structuredClone(value));
      expect(v).toEqual({ ok: true, value, warnings: [], glossaryTermsUsed: [] });
    }
    const r = bodyPrepared();
    const v = validateField({ prepared: r, field: bodyField, draft: r.wire, glossary: [], glossaryMode: "warn" });
    expect(v).toMatchObject({ ok: true, warnings: [], glossaryTermsUsed: [] });
    if (v.ok) expect(v.value).toEqual(r.prepared.source);
  });

  test("a value kind without string leaves passes shape and returns ok", () => {
    expect(check("n", number({ localized: true }), 5, 5)).toEqual({ ok: true, value: 5, warnings: [], glossaryTermsUsed: [] });
  });
});

describe("shape (rule 1)", () => {
  const meta = object({ n: number(), t: text() }, { localized: true });
  const tags = list(text(), { localized: true });

  test("a changed non-text leaf is a rejection", () => {
    const v = check("meta", meta, { n: 3, t: "a" }, { n: 4, t: "b" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rejections).toEqual(["meta: $.n: non-text value changed"]);
  });

  test("a list with one item fewer is a rejection", () => {
    const v = check("tags", tags, ["a", "b"], ["x"]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rejections).toEqual(["tags: $: list length 1 expected 2"]);
  });

  test("a wrong-typed draft is a rejection and rules 2 to 4 are skipped", () => {
    const v = check("title", text(), "Hello {name}", 42, [entry({ term: "Hello", doNotTranslate: true })]);
    expect(v).toEqual({ ok: false, rejections: ["title: $: expected text"], warnings: [] });
  });

  test("rule 0 is still reported beside a shape rejection", () => {
    const v = check("tags", tags, ["a", "b"], ["x\u0000"]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rejections).toEqual(["tags: contains U+0000", "tags: $: list length 1 expected 2"]);
  });

  test("a rich text draft that is not a string is a rejection", () => {
    const r = bodyPrepared();
    const v = validateField({ prepared: r, field: bodyField, draft: { type: "root" }, glossary: [], glossaryMode: "warn" });
    expect(v).toEqual({ ok: false, rejections: ["body: expected a Markdown string"], warnings: [] });
  });
});

describe("rich text through the sentinel pass", () => {
  const run = (r: ReturnType<typeof bodyPrepared>, draft: string, glossary: GlossaryEntry[] = []) =>
    validateField({ prepared: r, field: bodyField, draft, glossary, glossaryMode: "warn" });

  test("rich text with a dropped sentinel is rejected with restore SENTINEL_MISSING", () => {
    const r = bodyPrepared();
    const v = run(r, r.wire.replace("⟦MOGGING:0⟧", "dropped"));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.rejections).toHaveLength(1);
      expect(v.rejections[0]).toMatch(/^body: restore SENTINEL_MISSING: .*missing: 0/);
    }
  });

  test("rich text with a rewritten link target is rejected with restore LINK_TARGETS", () => {
    const r = bodyPrepared();
    const v = run(r, r.wire.replace("https://a.example/docs", "https://evil.example/"));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rejections[0]).toMatch(/^body: restore LINK_TARGETS: /);
  });

  test("a translated prose draft with sentinels and link target intact restores the original nodes", () => {
    const r = bodyPrepared();
    const draft = r.wire.replace("Hello", "Geia").replace("A closing paragraph.", "Mia teleftaia paragrafos.");
    const v = run(r, draft);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const json = JSON.stringify(v.value);
      expect(json).toContain("const x = 1;");
      expect(json).toContain("foo()");
      expect(json).toContain("Geia");
    }
  });

  test("a rich text draft with an extra or missing placeholder is rejected", () => {
    const r = bodyPrepared("Dear {name}, welcome.\n\n```ts\nx\n```");
    expect(run(r, r.wire).ok).toBe(true);
    const missing = run(r, r.wire.replace("{name}", "kyrie"));
    expect(missing.ok).toBe(false);
    const extra = run(r, r.wire.replace("welcome", "welcome {other}"));
    expect(extra.ok).toBe(false);
    if (!missing.ok) expect(missing.rejections[0]).toMatch(/^body: (restore PLACEHOLDER|placeholder mismatch)/);
    if (!extra.ok) expect(extra.rejections[0]).toMatch(/^body: (restore PLACEHOLDER|placeholder mismatch)/);
  });

  test("rules 3 and 4 run on the draft Markdown string for rich text", () => {
    const r = bodyPrepared("The Mogging CMS is a catalogue tool.\n\n```ts\nx\n```");
    const gl = [entry({ term: "Mogging", doNotTranslate: true }), entry({ term: "tool", translation: "ergaleio" })];
    const good = run(r, r.wire.replace("is a catalogue tool", "einai ergaleio"), gl);
    expect(good).toMatchObject({ ok: true, warnings: [], glossaryTermsUsed: ["tool"] });
    const bad = run(r, r.wire.replace("Mogging", "Moggingx").replace("tool", "ergo"), gl);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.rejections).toEqual(['body: do-not-translate term "Mogging" missing']);
      expect(bad.warnings).toEqual(['glossary: "tool" expected "ergaleio"']);
    }
  });
});

describe("placeholders (rule 2)", () => {
  test("a missing {name} placeholder is rejected", () => {
    const v = textCheck("Hello {name}, you have {count} items", "Geia, exeis {count} items");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rejections).toEqual(["title: placeholder mismatch: source [{count}, {name}] draft [{count}]"]);
  });

  test("an extra {name} is rejected", () => {
    const v = textCheck("Hello", "Geia {name}");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rejections).toEqual(["title: placeholder mismatch: source [] draft [{name}]"]);
  });

  test("a duplicated placeholder is a multiset difference", () => {
    expect(textCheck("{a} and {a}", "{a}").ok).toBe(false);
  });

  test("the same placeholders in a different order pass", () => {
    expect(textCheck("{a} then {b}", "{b} meta {a}").ok).toBe(true);
  });

  test("placeholders are compared across all string leaves of a list", () => {
    const f = list(text(), { localized: true });
    expect(check("tags", f, ["{a}", "x"], ["x", "{a}"]).ok).toBe(true);
    expect(check("tags", f, ["{a}", "x"], ["{a}", "{b}"]).ok).toBe(false);
  });

  test("braces that are not identifiers are not placeholders", () => {
    expect(textCheck("a { b } {1} {}", "x").ok).toBe(true);
  });
});

describe("do-not-translate (rule 3)", () => {
  const dnt = [entry({ term: "Mogging", doNotTranslate: true })];

  test("a do-not-translate term that disappears is rejected", () => {
    const v = textCheck("Use Mogging today", "Xrisimopoiiste to Moggin", dnt);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rejections).toEqual(['title: do-not-translate term "Mogging" missing']);
  });

  test("one that is kept passes", () => {
    expect(textCheck("Use Mogging today", "Xrisimopoiiste to Mogging simera", dnt).ok).toBe(true);
  });

  test("it is case-sensitive", () => {
    expect(textCheck("Use Mogging today", "xrisimopoiiste to mogging", dnt).ok).toBe(false);
  });

  test("the draft must contain it as many times as the source", () => {
    expect(textCheck("Mogging and Mogging", "Mogging kai ena", dnt).ok).toBe(false);
    expect(textCheck("Mogging and Mogging", "Mogging kai Mogging kai Mogging", dnt).ok).toBe(true);
  });

  test("a term absent from the source is not required in the draft", () => {
    expect(textCheck("Nothing here", "Tipota edo", dnt)).toMatchObject({ ok: true, warnings: [] });
  });

  test("a term only found as part of a longer word does not count in either text", () => {
    expect(textCheck("Moggingly speaking", "kati allo", dnt).ok).toBe(true);
    expect(textCheck("Use Mogging", "Moggingly", dnt).ok).toBe(false);
    expect(textCheck("The XMogging brand", "kati allo", dnt).ok).toBe(true); // preceded by a letter
    expect(textCheck("Use Mogging", "Xrisi XMogging", dnt).ok).toBe(false);
  });

  test("term matching is literal: C++ and Node.js", () => {
    const g = [entry({ term: "C++", doNotTranslate: true }), entry({ term: "Node.js", doNotTranslate: true })];
    expect(textCheck("We write C++ and Node.js.", "Grafoume C++ kai Node.js.", g).ok).toBe(true);
    const lost = textCheck("We write C++ and Node.js.", "Grafoume C kai Node.js.", g);
    expect(lost.ok).toBe(false);
    if (!lost.ok) expect(lost.rejections).toEqual(['title: do-not-translate term "C++" missing']);
    const dot = textCheck("We write Node.js.", "Grafoume NodeXjs.", g);
    expect(dot.ok).toBe(false); // the dot is not a wildcard
  });

  test("an empty term is ignored", () => {
    expect(textCheck("abc", "def", [entry({ term: "", doNotTranslate: true })]).ok).toBe(true);
  });

  test("list leaves are joined for matching", () => {
    const f = list(text(), { localized: true });
    expect(check("tags", f, ["Mogging", "x"], ["y", "z"], dnt).ok).toBe(false);
    expect(check("tags", f, ["Mogging", "x"], ["y", "Mogging"], dnt).ok).toBe(true);
  });
});

describe("glossary (rule 4)", () => {
  const cat = entry({ term: "cat", translation: "gata", acceptedForms: ["gatas", "gates"] });

  test("a glossary miss warns in warn mode and rejects in strict mode", () => {
    const warn = textCheck("The cat sleeps", "I lipari koimatai", [cat], "warn");
    expect(warn).toEqual({ ok: true, value: "I lipari koimatai", warnings: ['glossary: "cat" expected "gata"'], glossaryTermsUsed: [] });
    const strict = textCheck("The cat sleeps", "I lipari koimatai", [cat], "strict");
    expect(strict).toEqual({ ok: false, rejections: ['title: glossary: "cat" expected "gata"'], warnings: [] });
  });

  test("a hit passes and is reported in glossaryTermsUsed", () => {
    expect(textCheck("The cat sleeps", "I gata koimatai", [cat], "strict")).toEqual({
      ok: true, value: "I gata koimatai", warnings: [], glossaryTermsUsed: ["cat"],
    });
  });

  test("an accepted form counts as a hit", () => {
    expect(textCheck("The cat sleeps", "Ton gatas thelo", [cat], "strict")).toMatchObject({
      ok: true, warnings: [], glossaryTermsUsed: ["cat"],
    });
  });

  test("glossary matching is case-insensitive in the source and the draft", () => {
    expect(textCheck("CAT food", "GATA fagito", [cat], "strict")).toMatchObject({ ok: true, glossaryTermsUsed: ["cat"] });
  });

  test("a term absent from the source produces nothing", () => {
    expect(textCheck("The dog sleeps", "O skylos koimatai", [cat], "strict")).toEqual({
      ok: true, value: "O skylos koimatai", warnings: [], glossaryTermsUsed: [],
    });
  });

  test("term matching is bounded: cat does not fire on catalogue", () => {
    expect(textCheck("See the catalogue", "Dite ton katalogo", [cat], "strict")).toEqual({
      ok: true, value: "Dite ton katalogo", warnings: [], glossaryTermsUsed: [],
    });
    expect(textCheck("A bobcat and a 2cat", "Ena zoo", [cat], "strict").ok).toBe(true); // preceded by a letter or digit
    expect(textCheck("See the cat.", "Dite", [cat], "strict").ok).toBe(false);
    expect(textCheck("the cat's toy", "to paixnidi", [cat], "strict").ok).toBe(false);
  });

  test("term C++ matches literally", () => {
    const g = entry({ term: "C++", translation: "C plus plus" });
    expect(textCheck("We use C++ daily", "Xrisimopoioume kati", [g], "strict").ok).toBe(false);
    expect(textCheck("We use C daily", "Xrisimopoioume kati", [g], "strict").ok).toBe(true);
    expect(textCheck("We use C++ daily", "Xrisimopoioume C plus plus", [g], "strict")).toMatchObject({ ok: true, glossaryTermsUsed: ["C++"] });
  });

  test("a bounded match respects Unicode letters", () => {
    const g = entry({ term: "γάτα", translation: "cat" });
    expect(textCheck("η γάτα εδώ", "the dog", [g], "strict").ok).toBe(false);
    expect(textCheck("η γάταμου εδώ", "the dog", [g], "strict").ok).toBe(true);
  });

  test("an entry without a translation (do-not-translate) is not a glossary check", () => {
    const g = entry({ term: "Mogging", doNotTranslate: true });
    expect(textCheck("Mogging", "Mogging", [g], "strict")).toMatchObject({ ok: true, warnings: [], glossaryTermsUsed: [] });
  });

  test("rejections from rules 2, 3 and a strict rule 4 miss are collected together, in rule order", () => {
    const g = [entry({ term: "Mogging", doNotTranslate: true }), cat];
    const v = textCheck("Mogging cat {a}", "Moggin koti", g, "strict");
    expect(v).toEqual({
      ok: false,
      rejections: [
        "title: placeholder mismatch: source [{a}] draft []",
        'title: do-not-translate term "Mogging" missing',
        'title: glossary: "cat" expected "gata"',
      ],
      warnings: [],
    });
  });
});

describe("U+0000 (rule 0)", () => {
  test("a draft containing U+0000 is rejected in a text field", () => {
    const v = textCheck("Hello", "Hel\u0000lo");
    expect(v).toEqual({ ok: false, rejections: ["title: contains U+0000"], warnings: [] });
  });

  test("U+0000 in a nested leaf of an object is rejected", () => {
    const f = object({ n: number(), t: text() }, { localized: true });
    const v = check("meta", f, { n: 1, t: "a" }, { n: 1, t: "a\u0000" });
    expect(v).toEqual({ ok: false, rejections: ["meta: contains U+0000"], warnings: [] });
  });

  test("a rich text draft containing U+0000 is rejected", () => {
    const r = bodyPrepared();
    const v = validateField({ prepared: r, field: bodyField, draft: r.wire.replace("closing", "clos\u0000ing"), glossary: [], glossaryMode: "warn" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rejections).toContain("body: contains U+0000");
  });
});
