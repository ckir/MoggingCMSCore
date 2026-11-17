import { describe, expect, test } from "vitest";
import {
  boolean, defineCollection, defineConfig, json, list, number, object, reference, richText, slug, text,
} from "@mogging/core";
import type { Field, MoggingConfig } from "@mogging/core";
import { defineStarlightLayout } from "../../src/index.js";
import type { StarlightLayoutInput } from "../../src/index.js";
import { deriveSlug } from "../../src/starlight/slugs.js";
import { localeOfDir } from "../../src/starlight/layout.js";
import { withTestDb } from "../db.js";
import { config, countingSql, docs, extraConnection, layout, layoutInput, layoutOwn, project, readTree } from "./fixtures.js";

describe("deriveSlug", () => {
  test.each([
    ["Getting-Started.md", "getting-started"],
    ["guides/Hello World.md", "guides/hello-world"],
    ["guides/index.md", "guides/index"],
    ["index.md", "index"],
    ["a_b/c.d.md", "a_b/cd"],
    ["Über/naïve.mdx", "über/naïve"],
  ])("%s -> %s", (rel, expected) => {
    expect(deriveSlug(rel)).toBe(expected);
  });

  test("an NFD file name yields the NFC slug", () => {
    expect(deriveSlug("U\u0308ber.md")).toBe("\u00fcber");
  });

  test("a segment that slugifies to nothing is refused", () => {
    expect(() => deriveSlug("!!.md")).toThrow(/empty slug segment/);
    expect(() => deriveSlug("!!.md")).toThrow(expect.objectContaining({ name: "ValidationError" }));
    expect(() => deriveSlug("a/!!/b.md")).toThrow(/empty slug segment/);
  });
});

/** A config over one `docs` collection built from `fields` (plus a body, unless `fields` has one). */
function cfgOf(fields: Record<string, Field>, locales = { source: "en", chains: { de: ["en"], "zh-CN": ["en"] } }): MoggingConfig {
  return defineConfig({
    collections: [defineCollection("docs", { slug: slug(), body: richText({ localized: true, body: true }), ...fields })],
    locales,
  });
}

/** Asserts `defineStarlightLayout` throws a ValidationError whose message matches `re`. */
function refuses(input: StarlightLayoutInput, cfg: MoggingConfig, re: RegExp): void {
  let err: unknown;
  try { defineStarlightLayout(input, cfg); } catch (e) { err = e; }
  expect(err, "expected a ValidationError").toBeInstanceOf(Error);
  expect((err as Error).name).toBe("ValidationError");
  expect((err as Error).message).toMatch(re);
}

describe("defineStarlightLayout: the fixture layout", () => {
  test("defaults, locale folders and the declared surface", () => {
    expect(layout.kind).toBe("starlight");
    expect(layout.collection).toBe("docs");
    expect(layout.docsDir).toBe("src/content/docs");
    expect(layout.sourceDir).toBeNull();
    expect(layout.localeDirs).toEqual({ de: "de", "zh-CN": "zh-cn" });
    expect(layout.otherLocaleDirs).toEqual(["fr"]);
    expect(layout.passthrough).toBe("extra");
    expect(layout.fileRefs).toEqual(["hero.image.file", "hero.image.dark", "hero.image.light"]);
    expect(layout.requiredWhenSource).toEqual(["hero"]);
  });

  test("explicit entries plus one implicit plain entry per remaining field, sorted by path", () => {
    const keys = layout.entries.map((e) => e.path.join("."));
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      "banner", "description", "draft", "editUrl", "head", "hero", "lastUpdated", "next", "pagefind", "prev",
      "sidebar.attrs", "sidebar.badge", "sidebar.hidden", "sidebar.label", "sidebar.order", "tableOfContents",
      "template", "title",
    ]);
    const by = (p: string) => layout.entries.find((e) => e.path.join(".") === p);
    expect(by("title")).toEqual({ kind: "plain", path: ["title"], field: "title", localized: true, stringAs: null });
    expect(by("hero")).toEqual({ kind: "plain", path: ["hero"], field: "hero", localized: true, stringAs: null });
    expect(by("draft")).toEqual({ kind: "plain", path: ["draft"], field: "draft", localized: false, stringAs: null });
    expect(by("sidebar.badge")).toEqual({
      kind: "plain", path: ["sidebar", "badge"], field: "sidebarBadge", localized: true, stringAs: "text",
    });
    expect(by("sidebar.attrs")).toEqual({
      kind: "plain", path: ["sidebar", "attrs"], field: "sidebarAttrs", localized: false, stringAs: null,
    });
    expect(by("prev")).toEqual({ kind: "union", path: ["prev"], toggle: "prevToggle", value: "prev", stringAs: "label" });
  });

  test("the slug, body and passthrough fields are not entries (extra is the passthrough)", () => {
    const fields = layout.entries.flatMap((e) => (e.kind === "plain" ? [e.field] : [e.toggle, e.value]));
    for (const f of ["slug", "body", "extra"]) expect(fields).not.toContain(f);
    expect(layout.entries.some((e) => e.path[0] === "extra")).toBe(false);
  });

  test("every declared field is mapped exactly once", () => {
    const fields = layout.entries.flatMap((e) => (e.kind === "plain" ? [e.field] : [e.toggle, e.value]));
    expect(new Set(fields).size).toBe(fields.length);
    expect(fields.sort()).toEqual(Object.keys(docs.fields).filter((f) => !["slug", "body", "extra"].includes(f)).sort());
  });

  test("the own-folder mode keeps everything but the source folder", () => {
    expect(layoutOwn.sourceDir).toBe("en");
    expect(layoutOwn.localeDirs).toEqual(layout.localeDirs);
    expect(layoutOwn.entries).toEqual(layout.entries);
  });

  test("the result is deeply frozen", () => {
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout.entries)).toBe(true);
    expect(Object.isFrozen(layout.entries[0])).toBe(true);
    expect(Object.isFrozen(layout.entries[0]!.path)).toBe(true);
    expect(Object.isFrozen(layout.localeDirs)).toBe(true);
    expect(Object.isFrozen(layout.otherLocaleDirs)).toBe(true);
    expect(Object.isFrozen(layout.fileRefs)).toBe(true);
    expect(Object.isFrozen(layout.requiredWhenSource)).toBe(true);
  });

  test("the input is not mutated or aliased", () => {
    expect(layoutInput.otherLocaleDirs).toEqual(["fr"]);
    expect(Object.isFrozen(layoutInput)).toBe(false);
    expect(layout.otherLocaleDirs).not.toBe(layoutInput.otherLocaleDirs);
  });

  test("an explicit docsDir and localeDirs override are honoured", () => {
    const l = defineStarlightLayout({ ...layoutInput, docsDir: "site/docs", localeDirs: { "zh-CN": "zh-hans" } }, config);
    expect(l.docsDir).toBe("site/docs");
    expect(l.localeDirs).toEqual({ de: "de", "zh-CN": "zh-hans" });
  });
});

describe("localeOfDir", () => {
  test("maps a locale folder to its locale and everything else to null", () => {
    expect(localeOfDir(layout, "de")).toBe("de");
    expect(localeOfDir(layout, "zh-cn")).toBe("zh-CN");
    expect(localeOfDir(layout, "zh-CN")).toBeNull();
    expect(localeOfDir(layout, "fr")).toBeNull();
    expect(localeOfDir(layout, "guides")).toBeNull();
    expect(localeOfDir(layoutOwn, "en")).toBeNull();
  });

  test("prototype-named folders are not locale folders (D12)", () => {
    for (const d of ["constructor", "__proto__", "prototype", "toString", "hasOwnProperty"]) {
      expect(localeOfDir(layout, d)).toBeNull();
    }
  });
});

describe("defineStarlightLayout: refusals", () => {
  const base = layoutInput;

  test("unknown collection", () => {
    refuses({ ...base, collection: "nope" }, config, /unknown collection "nope"/);
  });

  test("a slug-kind field not named slug (D10)", () => {
    // Built as a plain object: defineConfig now refuses this shape itself, and this test pins the layout's own check.
    const cfg: MoggingConfig = {
      collections: [defineCollection("docs", {
        path: slug(), extra: json(), body: richText({ localized: true, body: true }),
      })],
      locales: { source: "en", chains: { de: ["en"] } },
    };
    refuses({ collection: "docs", passthrough: "extra" }, cfg, /slug field must be named "slug"/);
  });

  test("passthrough must be a shared json field", () => {
    refuses({ ...base, passthrough: "nope" }, config, /passthrough "nope".*json/);
    refuses({ ...base, passthrough: "title" }, config, /passthrough "title".*json/);
    refuses({ ...base, passthrough: "slug" }, config, /passthrough "slug".*json/);
  });

  test("a field mapped twice", () => {
    refuses({ ...base, paths: [...base.paths!, { path: "weight", field: "sidebarOrder" }] }, config, /field "sidebarOrder".*twice/);
    refuses({
      ...base,
      paths: [...base.paths!, { path: "weight", union: { toggle: "prevToggle", value: "banner", stringAs: "content" } }],
    }, config, /field "prevToggle".*twice/);
  });

  test("a path mapped twice", () => {
    refuses({ ...base, paths: [...base.paths!, { path: "sidebar.order", field: "template" }] }, config, /path "sidebar.order".*twice/);
    // An explicit path colliding with another field's implicit (own-name) path.
    refuses({ ...base, paths: [...base.paths!, { path: "hero", field: "template" }] }, config, /path "hero".*twice/);
  });

  test("a path that is a prefix of another", () => {
    refuses({
      collection: "docs", passthrough: "extra",
      paths: [{ path: "sidebar", field: "template" }, { path: "sidebar.order", field: "sidebarOrder" }],
    }, config, /"sidebar".*prefix.*"sidebar.order"|"sidebar.order".*"sidebar"/);
    refuses({
      collection: "docs", passthrough: "extra",
      paths: [{ path: "sidebar.order", field: "sidebarOrder" }, { path: "sidebar", field: "template" }],
    }, config, /prefix/);
  });

  test("a union toggle that is not a shared boolean", () => {
    const u = (toggle: string) => ({ ...base, paths: [{ path: "prev", union: { toggle, value: "prev", stringAs: "label" } }] });
    refuses(u("sidebarOrder"), config, /toggle "sidebarOrder".*shared boolean/);
    refuses(u("nope"), config, /toggle "nope".*shared boolean/);
    const cfg = cfgOf({
      t: boolean({ localized: true }), prev: object({ label: text() }, { localized: true }), extra: json(),
    });
    refuses({ collection: "docs", passthrough: "extra", paths: [{ path: "prev", union: { toggle: "t", value: "prev", stringAs: "label" } }] },
      cfg, /toggle "t".*shared boolean/);
  });

  test("a union value that is not a localized object with a text stringAs key", () => {
    const u = (value: string, stringAs = "label") => ({
      ...base, paths: [{ path: "prev", union: { toggle: "prevToggle", value, stringAs } }],
    });
    refuses(u("template"), config, /value "template".*localized object/);
    refuses(u("hero"), config, /stringAs "label".*text/); // localized object, no `label` key
    refuses(u("nope"), config, /value "nope".*localized object/);
    const cfg = cfgOf({
      pt: boolean(), p: object({ label: text() }), extra: json(),
    });
    refuses({ collection: "docs", passthrough: "extra", paths: [{ path: "prev", union: { toggle: "pt", value: "p", stringAs: "label" } }] },
      cfg, /value "p".*localized object/);
  });

  test("stringAs naming a non-text sub-field, or on a field that is not an object", () => {
    refuses({ ...base, paths: [{ path: "sidebar.badge", field: "sidebarBadge", stringAs: "nope" }] }, config, /stringAs "nope"/);
    const cfg = cfgOf({ b: object({ n: number() }, { localized: true }), extra: json() });
    refuses({ collection: "docs", passthrough: "extra", paths: [{ path: "b", field: "b", stringAs: "n" }] }, cfg, /stringAs "n".*text/);
    refuses({ ...base, paths: [{ path: "sidebar.label", field: "sidebarLabel", stringAs: "x" }] }, config, /stringAs "x".*object/);
  });

  test("a path segment __proto__, constructor or prototype", () => {
    for (const seg of ["__proto__", "constructor", "prototype"]) {
      refuses({ ...base, paths: [{ path: `a.${seg}`, field: "template" }] }, config, new RegExp(`segment "${seg}"`));
      refuses({ ...base, paths: [{ path: seg, field: "template" }] }, config, new RegExp(`segment "${seg}"`));
    }
  });

  test("an implicit field whose name is a forbidden segment", () => {
    const cfg = cfgOf({ constructor: text(), extra: json() });
    refuses({ collection: "docs", passthrough: "extra" }, cfg, /segment "constructor"/);
  });

  test("a malformed path (empty, empty segment)", () => {
    refuses({ ...base, paths: [{ path: "", field: "template" }] }, config, /path ""/);
    refuses({ ...base, paths: [{ path: "a..b", field: "template" }] }, config, /path "a..b"/);
  });

  test("a path or field named slug", () => {
    refuses({ ...base, paths: [{ path: "slug", field: "template" }] }, config, /path "slug"/);
    refuses({ ...base, paths: [{ path: "alias", field: "slug" }] }, config, /field "slug"/);
  });

  test("an explicit entry for the body, the passthrough or an unknown field", () => {
    refuses({ ...base, paths: [{ path: "x", field: "body" }] }, config, /field "body"/);
    refuses({ ...base, paths: [{ path: "x", field: "extra" }] }, config, /field "extra"/);
    refuses({ ...base, paths: [{ path: "x", field: "nope" }] }, config, /unknown field "nope"/);
    refuses({ ...base, paths: [{ path: "x", field: "constructor" }] }, config, /unknown field "constructor"/);
  });

  test("a reference field anywhere in the collection (D2)", () => {
    const top = cfgOf({ author: reference("docs"), extra: json() });
    refuses({ collection: "docs", passthrough: "extra" }, top, /reference field "author"/);
    const nested = cfgOf({ box: object({ r: reference("docs") }), extra: json() });
    refuses({ collection: "docs", passthrough: "extra" }, nested, /reference field "box\.r"/);
    const inList = cfgOf({ rs: list(reference("docs")), extra: json() });
    refuses({ collection: "docs", passthrough: "extra" }, inList, /reference field "rs\[\]"/);
  });

  test("a locale folder that is not its own slugified form", () => {
    refuses({ ...base, localeDirs: { "zh-CN": "zh-CN" } }, config, /folder "zh-CN".*"zh-cn"/);
    refuses({ ...base, localeDirs: { de: "d e" } }, config, /folder "d e"/);
    refuses({ ...base, localeDirs: { de: "" } }, config, /folder ""/);
    refuses({ ...base, localeDirs: { de: "a/b" } }, config, /folder "a\/b"/);
  });

  test("a localeDirs key that is not a declared target locale", () => {
    refuses({ ...base, localeDirs: { fr: "fr" } }, config, /locale "fr".*not a declared/);
    refuses({ ...base, localeDirs: { en: "en" } }, config, /locale "en".*source/);
  });

  test("two locales on one folder", () => {
    refuses({ ...base, localeDirs: { de: "zh-cn" } }, config, /folder "zh-cn".*"zh-CN".*"de"|folder "zh-cn".*"de".*"zh-CN"/);
  });

  test("a folder in both localeDirs and otherLocaleDirs", () => {
    refuses({ ...base, otherLocaleDirs: ["fr", "de"] }, config, /folder "de".*both/);
  });

  test("the source folder is not a locale or other folder", () => {
    refuses({ ...base, sourceDir: "de" }, config, /folder "de"/);
    refuses({ ...base, sourceDir: "fr" }, config, /folder "fr"/);
    refuses({ ...base, sourceDir: "En" }, config, /folder "En"/);
  });

  test("docsDir absolute or containing ..", () => {
    refuses({ ...base, docsDir: "/abs/docs" }, config, /docsDir "\/abs\/docs".*relative/);
    refuses({ ...base, docsDir: "C:/docs" }, config, /docsDir "C:\/docs".*relative/);
    refuses({ ...base, docsDir: "../docs" }, config, /docsDir "\.\.\/docs"/);
    refuses({ ...base, docsDir: "a/../../docs" }, config, /docsDir/);
    refuses({ ...base, docsDir: "" }, config, /docsDir ""/);
    refuses({ ...base, docsDir: "a\\b" }, config, /docsDir "a\\b"/);
  });

  test("a fileRefs path whose first segment is not a localized field", () => {
    refuses({ ...base, fileRefs: ["nope.x"] }, config, /fileRefs "nope\.x".*localized field/);
    refuses({ ...base, fileRefs: ["sidebarAttrs"] }, config, /fileRefs "sidebarAttrs".*localized field/);
    refuses({ ...base, fileRefs: ["template"] }, config, /fileRefs "template".*localized field/);
  });

  test("a fileRefs path whose leaf is not text", () => {
    refuses({ ...base, fileRefs: ["hero.image"] }, config, /fileRefs "hero\.image".*text/);
    const cfg = cfgOf({ g: object({ n: number() }, { localized: true }), extra: json() });
    refuses({ collection: "docs", passthrough: "extra", fileRefs: ["g.n"] }, cfg, /fileRefs "g\.n".*text/);
    refuses({ ...base, fileRefs: ["hero.image.nope"] }, config, /fileRefs "hero\.image\.nope"/);
  });

  test("a fileRefs path that crosses a list", () => {
    refuses({ ...base, fileRefs: ["hero.actions.link"] }, config, /fileRefs "hero\.actions\.link".*list/);
    refuses({ ...base, fileRefs: ["hero.actions"] }, config, /fileRefs "hero\.actions"/);
  });

  test("requiredWhenSource naming a shared field, or an unknown one", () => {
    refuses({ ...base, requiredWhenSource: ["template"] }, config, /requiredWhenSource "template".*localized/);
    refuses({ ...base, requiredWhenSource: ["nope"] }, config, /requiredWhenSource "nope"/);
  });
});

describe("fixture helpers", () => {
  test("project and readTree round-trip a file tree with POSIX paths", () => {
    const root = project({ "a/b.md": "x", "c.md": "y" });
    expect(readTree(root)).toEqual({ "a/b.md": "x", "c.md": "y" });
  });

  test("extraConnection shares the per-test schema and countingSql counts its queries", async () => {
    await withTestDb(async (sql) => {
      await sql`create table probe (n int)`;
      await sql`insert into probe values (1)`;
      const extra = await extraConnection(sql);
      const counting = await countingSql(sql);
      try {
        expect(await extra`select n from probe`).toHaveLength(1);
        expect(counting.count()).toBe(0);
        await counting.sql`select n from probe`;
        await counting.sql`select n from probe`;
        expect(counting.count()).toBe(2);
        counting.reset();
        expect(counting.count()).toBe(0);
      } finally {
        await extra.end();
        await counting.sql.end();
      }
    });
  });
});
