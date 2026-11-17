import { describe, expect, test } from "vitest";
import { ValidationError } from "@mogging/core";
import { readAstroFrontMatter, readStarlightFile, splitPage } from "../../src/starlight/frontMatter.js";
import { docs, layout } from "./fixtures.js";

const fm = (yaml: string, body = "") => `---\n${yaml}\n---\n${body}`;
const split = (yaml: string, body = "", mode: "md" | "mdx" = "md") =>
  splitPage(layout, docs, readStarlightFile(fm(yaml, body)), mode);

describe("readStarlightFile: safety", () => {
  test.each([
    ["top level", "__proto__:\n  polluted: 1"],
    ["quoted", '"__proto__": 1'],
    ["nested", "a:\n  b:\n    __proto__: 1"],
    ["inside a list item", "a:\n  - b: 1\n  - __proto__: 2"],
    ["constructor", "a:\n  constructor: 1"],
    ["prototype", "prototype: 1"],
    ["an alias key resolving to the name", "a: &k __proto__\n*k : 1"],
    ["a flow mapping", "a: { __proto__: { polluted: true } }"],
  ])("a forbidden key (%s) is a ValidationError and pollutes nothing", (_label, yaml) => {
    expect(() => readStarlightFile(fm(yaml))).toThrow(ValidationError);
    expect(() => readStarlightFile(fm(yaml))).toThrow(/forbidden key/);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("an unknown tag is a ValidationError", () => {
    expect(() => readStarlightFile(fm("a: !x 1"))).toThrow(ValidationError);
  });

  test.each([
    ["a duplicate key", "a: 1\na: 2"],
    ["unterminated flow", "a: [1, 2"],
    ["a non-mapping root", "- a\n- b"],
    ["a scalar root", "just text"],
  ])("%s is a ValidationError naming front matter", (_label, yaml) => {
    expect(() => readStarlightFile(fm(yaml))).toThrow(ValidationError);
    expect(() => readStarlightFile(fm(yaml))).toThrow(/front matter/);
  });

  test("an alias and a << merge resolve before mapping", () => {
    const file = readStarlightFile(fm("base: &b { x: 1 }\nc: *b\nd:\n  <<: *b\n  y: 2"));
    expect(file.data).toEqual({ base: { x: 1 }, c: { x: 1 }, d: { x: 1, y: 2 } });
  });

  test("a nested alias bomb is a ValidationError, not a ReferenceError", () => {
    let yaml = 'l0: &l0 ["x","x","x","x","x","x","x","x","x"]\n';
    for (let i = 1; i < 10; i++) yaml += `l${i}: &l${i} [${Array(9).fill(`*l${i - 1}`).join(",")}]\n`;
    let err: unknown;
    try { readStarlightFile(fm(yaml.trimEnd())); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/front matter/);
  });

  test("a +++ file is refused naming TOML", () => {
    expect(() => readStarlightFile("+++\ntitle = 'x'\n+++\nbody")).toThrow(ValidationError);
    expect(() => readStarlightFile("+++\ntitle = 'x'\n+++\nbody")).toThrow(/front matter.*TOML/);
  });

  test("blank lines before --- are refused naming the limit", () => {
    expect(() => readStarlightFile("\n\n---\ntitle: x\n---\nbody")).toThrow(/front matter: blank lines before the opening ---/);
  });

  test("an opening or closing fence Astro reads differently is refused", () => {
    const different = /different front-matter block/;
    expect(() => readStarlightFile("--- \ntitle: x\n---\nbody")).toThrow(different);
    expect(() => readStarlightFile("---\ntitle: x\n---x\nbody\n---\n")).toThrow(different);
    expect(() => readStarlightFile("---\ntitle: x\n--- \nbody\n---\n")).toThrow(different);
  });

  test("the Astro comparison runs on normalized text: BOM and CRLF input diverge the same way", () => {
    const different = /different front-matter block/;
    expect(() => readStarlightFile("\uFEFF---\r\ntitle: x\r\n---x\r\nbody\r\n---\r\n")).toThrow(different);
    expect(() => readStarlightFile("\uFEFF--- \r\ntitle: x\r\n---\r\nbody")).toThrow(different);
    expect(() => readStarlightFile("\uFEFF\r\n\r\n---\r\ntitle: x\r\n---\r\nbody")).toThrow(/blank lines before the opening ---/);
    expect(() => readStarlightFile("\uFEFF+++\r\ntitle = 'x'\r\n+++\r\nbody")).toThrow(/TOML/);
    // The clean BOM + CRLF file is not a divergence.
    expect(readStarlightFile("\uFEFF---\r\ntitle: x\r\n---\r\nbody").data).toEqual({ title: "x" });
  });

  test("a missing closing fence is a front matter error", () => {
    expect(() => readStarlightFile("---\ntitle: x\nbody")).toThrow(/front matter: missing closing ---/);
  });

  test("a slug key is a per-file error", () => {
    expect(() => readStarlightFile(fm("slug: other"))).toThrow(ValidationError);
    expect(() => readStarlightFile(fm("title: x\nslug: other"))).toThrow(/slug override/);
  });

  test("a body field name in front matter keeps the existing error", () => {
    const file = readStarlightFile(fm("body: text"));
    expect(() => splitPage(layout, docs, file, "md")).toThrow(ValidationError);
    expect(() => splitPage(layout, docs, file, "md")).toThrow(
      "body: the body field comes from the Markdown body, not front matter",
    );
  });
});

describe("readStarlightFile: shape", () => {
  test("strips a BOM, converts CRLF and normalizes to NFC", () => {
    const file = readStarlightFile("\uFEFF---\r\ntitle: Cafe\u0301\r\n---\r\nBody Cafe\u0301\r\nline");
    expect(file.frontMatter).toBe("title: Caf\u00e9");
    expect(file.data).toEqual({ title: "Caf\u00e9" });
    expect(file.body).toBe("Body Caf\u00e9\nline");
    expect(file.doc).not.toBeNull();
  });

  test("a file without front matter has null front matter, null doc and the whole text as body", () => {
    const file = readStarlightFile("# Hi\n\nSome text\n---\nmore\n");
    expect(file).toEqual({ frontMatter: null, doc: null, data: {}, body: "# Hi\n\nSome text\n---\nmore\n" });
  });

  test("an empty front matter block is an empty mapping", () => {
    const file = readStarlightFile("---\n---\nbody");
    expect(file.frontMatter).toBe("");
    expect(file.data).toEqual({});
    expect(file.body).toBe("body");
  });

  test("a closing fence at the end of the file is accepted", () => {
    const file = readStarlightFile("---\ntitle: x\n---");
    expect(file.data).toEqual({ title: "x" });
    expect(file.body).toBe("");
  });

  test("a date-like value is a string under Mogging's core schema", () => {
    expect(readStarlightFile(fm("lastUpdated: 2024-01-01")).data).toEqual({ lastUpdated: "2024-01-01" });
  });
});

describe("readAstroFrontMatter", () => {
  test("keeps a plain date as a Date and a quoted one as a string", () => {
    const out = readAstroFrontMatter("a: 2024-01-01\nb: \"2024-01-01\"");
    expect(out.a).toBeInstanceOf(Date);
    expect((out.a as Date).toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(out.b).toBe("2024-01-01");
  });

  test("null and an empty block give an empty mapping", () => {
    expect(readAstroFrontMatter(null)).toEqual({});
    expect(readAstroFrontMatter("")).toEqual({});
  });

  test("merges and refuses unsafe input as a ValidationError", () => {
    expect(readAstroFrontMatter("base: &b { x: 1 }\nd:\n  <<: *b\n  y: 2").d).toEqual({ x: 1, y: 2 });
    expect(() => readAstroFrontMatter("__proto__: 1")).toThrow(ValidationError);
    expect(() => readAstroFrontMatter("a: [")).toThrow(ValidationError);
    expect(() => readAstroFrontMatter("- a")).toThrow(/must be a mapping/);
  });
});

describe("splitPage", () => {
  test("maps the sidebar paths to shared and localized fields", () => {
    const out = split('sidebar:\n  order: 2\n  label: Intro\n  badge: New\n  attrs: { class: x }');
    expect(out.shared).toEqual({ sidebarOrder: 2, sidebarAttrs: { class: "x" } });
    expect(out.localized).toEqual({ sidebarLabel: "Intro", sidebarBadge: { text: "New" } });
    expect(out.remainder).toEqual({});
    expect(out.toggles).toEqual({});
    expect(out.warnings).toEqual([]);
    expect(Object.hasOwn(out.shared, "extra")).toBe(false);
  });

  test("a badge given as an object stays an object", () => {
    const out = split("sidebar:\n  badge: { text: New, variant: tip }");
    expect(out.localized).toEqual({ sidebarBadge: { text: "New", variant: "tip" } });
  });

  test("prev: false and prev: true set the toggle in toggles and in shared", () => {
    const off = split("prev: false");
    expect(off.toggles).toEqual({ prevToggle: false });
    expect(off.shared).toEqual({ prevToggle: false });
    expect(Object.hasOwn(off.localized, "prev")).toBe(false);
    const on = split("prev: true");
    expect(on.toggles).toEqual({ prevToggle: true });
    expect(on.shared).toEqual({ prevToggle: true });
    expect(Object.hasOwn(on.localized, "prev")).toBe(false);
    const none = split("title: x");
    expect(none.toggles).toEqual({});
    expect(Object.hasOwn(none.shared, "prevToggle")).toBe(false);
  });

  test("prev given as a string or a mapping is the localized label/link value", () => {
    expect(split("prev: Back").localized).toEqual({ prev: { label: "Back" } });
    expect(split("next: Onward").localized).toEqual({ next: { label: "Onward" } });
    expect(split("prev: { link: /a }").localized).toEqual({ prev: { link: "/a" } });
    expect(split("prev: { link: /a, label: A }").localized).toEqual({ prev: { link: "/a", label: "A" } });
  });

  test("prev: {} and prev: null give neither a toggle nor a value", () => {
    for (const y of ["prev: {}", "prev: null", "prev:"]) {
      const out = split(y);
      expect(out.toggles).toEqual({});
      expect(out.shared).toEqual({});
      expect(out.localized).toEqual({});
      expect(out.remainder).toEqual({});
    }
  });

  test("prev: 3 and a list are per-file errors naming the path", () => {
    expect(() => split("prev: 3")).toThrow(ValidationError);
    expect(() => split("prev: 3")).toThrow(/prev/);
    expect(() => split("next: [a]")).toThrow(/next/);
  });

  test("unmapped keys land in the passthrough and in the remainder", () => {
    const out = split("title: T\nowner: team-a\nseo:\n  noindex: true");
    expect(out.shared).toEqual({ extra: { owner: "team-a", seo: { noindex: true } } });
    expect(out.remainder).toEqual({ owner: "team-a", seo: { noindex: true } });
    expect(out.localized).toEqual({ title: "T" });
  });

  test("a file with no unmapped key has no extra at all", () => {
    const out = split("title: T\ntemplate: splash");
    expect(Object.hasOwn(out.shared, "extra")).toBe(false);
    expect(out.remainder).toEqual({});
    expect(out.shared).toEqual({ template: "splash" });
  });

  test("a path whose parent is not a mapping stays in the remainder", () => {
    const out = split("sidebar: text\ntitle: T");
    expect(out.remainder).toEqual({ sidebar: "text" });
    expect(out.shared).toEqual({ extra: { sidebar: "text" } });
  });

  test("a parent that keeps another key stays in the remainder with only that key", () => {
    const out = split("sidebar:\n  order: 1\n  collapsed: true");
    expect(out.shared).toEqual({ sidebarOrder: 1, extra: { sidebar: { collapsed: true } } });
    expect(out.remainder).toEqual({ sidebar: { collapsed: true } });
  });

  test("hero.actions[0].attrs is dropped with the D5 warning", () => {
    const out = split(
      "hero:\n  title: H\n  actions:\n    - text: Go\n      link: /go\n      attrs: { target: _blank }\n    - text: Two",
    );
    expect(out.localized).toEqual({ hero: { title: "H", actions: [{ text: "Go", link: "/go" }, { text: "Two" }] } });
    expect(out.warnings).toEqual(["hero.actions[0].attrs: not part of the field; dropped (the English file keeps it)"]);
  });

  test("an undeclared key nested in an object is dropped with its dotted path", () => {
    const out = split("hero:\n  image:\n    alt: A\n    file: ../a.png\n    extra: 1");
    expect(out.localized).toEqual({ hero: { image: { alt: "A", file: "../a.png" } } });
    expect(out.warnings).toEqual(["hero.image.extra: not part of the field; dropped (the English file keeps it)"]);
  });

  test("a plain and a quoted date both give the string", () => {
    expect(split("lastUpdated: 2024-01-01").shared).toEqual({ lastUpdated: "2024-01-01" });
    expect(split('lastUpdated: "2024-01-01"').shared).toEqual({ lastUpdated: "2024-01-01" });
  });

  test("a value that does not fit its field is a per-file error naming the path", () => {
    expect(() => split("template: 3")).toThrow(/template/);
    expect(() => split("sidebar:\n  order: high")).toThrow(/sidebar\.order/);
  });

  test("a top-level null is absent", () => {
    const out = split("title: T\ndescription: null\nsidebar:\n  order:");
    expect(out.localized).toEqual({ title: "T" });
    expect(out.shared).toEqual({});
    expect(out.remainder).toEqual({});
  });

  test("an empty or whitespace-only body gives no body field", () => {
    expect(Object.hasOwn(split("title: T", "").localized, "body")).toBe(false);
    expect(Object.hasOwn(split("title: T", "  \n\n").localized, "body")).toBe(false);
  });

  test("a body gives the richText tree in the file's mode", () => {
    const md = split("title: T", "Hello *world*\n");
    expect(md.localized.body).toMatchObject({ type: "root", version: 1, mode: "md" });
    expect((md.localized.body as { children: unknown[] }).children.length).toBeGreaterThan(0);
    const mdx = split("title: T", "Hello\n", "mdx");
    expect(mdx.localized.body).toMatchObject({ type: "root", version: 1, mode: "mdx" });
  });

  test("a file with only a body maps the body", () => {
    const out = splitPage(layout, docs, readStarlightFile("# Hi\n"), "md");
    expect(Object.keys(out.localized)).toEqual(["body"]);
    expect(out.shared).toEqual({});
  });

  test("values are normalized (NFC) and NUL is refused", () => {
    expect(split("title: Cafe\u0301").localized).toEqual({ title: "Caf\u00e9" });
    expect(() => split('title: "a\\0b"')).toThrow(ValidationError);
  });

  test("the file's data is not mutated by splitPage", () => {
    const file = readStarlightFile(fm("sidebar:\n  order: 1\nowner: x"));
    const before = structuredClone(file.data);
    splitPage(layout, docs, file, "md");
    expect(file.data).toEqual(before);
  });

  test("names that match Object.prototype members are plain keys", () => {
    const out = split("toString: 1\nhasOwnProperty: 2");
    expect(out.remainder).toEqual({ toString: 1, hasOwnProperty: 2 });
  });
});
