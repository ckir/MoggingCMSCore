import { defineConfig, json, text, ValidationError } from "@mogging/core";
import { defineStarlightLayout } from "@mogging/markdown";
import { describe, expect, it } from "vitest";
import { docs, layoutInput } from "../../markdown/test/starlight/fixtures.js";
import { starlightPreset } from "../src/preset.js";

const locales = { source: "en", chains: { de: ["en"], "zh-CN": ["en"] } };

/** Validates a preset's layout over a config holding its collection. */
function validate(p: ReturnType<typeof starlightPreset>) {
  return defineStarlightLayout(p.layout, defineConfig({ collections: [p.collection], locales }));
}

describe("starlightPreset", () => {
  it("the preset's collection equals plan 6a's fixture collection", () => {
    expect(starlightPreset().collection).toEqual(docs);
  });

  it("the preset's layout equals plan 6a's fixture layout", () => {
    expect(starlightPreset().layout).toEqual({ ...layoutInput, otherLocaleDirs: [] });
  });

  it("every Starlight front-matter key is mapped", () => {
    const layout = validate(starlightPreset());
    const keys = ["title", "description", "editUrl", "head", "tableOfContents", "template", "hero", "lastUpdated",
      "prev", "next", "sidebar", "banner", "pagefind", "draft"];
    for (const key of keys) {
      expect(layout.entries.some((e) => e.path[0] === key), `front-matter key ${key}`).toBe(true);
    }
  });

  it("the default layout validates", () => {
    const layout = validate(starlightPreset());
    expect(layout.docsDir).toBe("src/content/docs");
    expect(layout.sourceDir).toBeNull();
    expect(layout.localeDirs).toEqual({ de: "de", "zh-CN": "zh-cn" });
    expect(layout.passthrough).toBe("extra");
    expect(layout.requiredWhenSource).toEqual(["hero"]);
    expect(layout.fileRefs).toEqual(["hero.image.file", "hero.image.dark", "hero.image.light"]);
    expect(layout.otherLocaleDirs).toEqual([]);
  });

  it("options reach the layout", () => {
    const p = starlightPreset({
      docsDir: "site/src/content/docs", sourceDir: "en", localeDirs: { "zh-CN": "zh-hans" }, otherLocaleDirs: ["fr"],
    });
    const layout = validate(p);
    expect(layout.docsDir).toBe("site/src/content/docs");
    expect(layout.sourceDir).toBe("en");
    expect(layout.localeDirs).toEqual({ de: "de", "zh-CN": "zh-hans" });
    expect(layout.otherLocaleDirs).toEqual(["fr"]);

    const bare = starlightPreset();
    for (const key of ["docsDir", "sourceDir", "localeDirs"]) expect(Object.hasOwn(bare.layout, key), key).toBe(false);
  });

  it("extra fields are added and may not collide", () => {
    const p = starlightPreset({ extraFields: { difficulty: text() } });
    expect(p.collection.fields.difficulty).toEqual(text());
    expect(p.collection.fields.title).toEqual(docs.fields.title);

    expect(() => starlightPreset({ extraFields: { title: text() } })).toThrowError(ValidationError);
    expect(() => starlightPreset({ extraFields: { title: text() } }))
      .toThrowError('starlightPreset: extra field "title" collides with a preset field');
    expect(() => starlightPreset({ extraFields: { extra: json() } }))
      .toThrowError('starlightPreset: extra field "extra" collides with a preset field');
  });

  it("the collection name option", () => {
    const p = starlightPreset({ collection: "handbook" });
    expect(p.collection.name).toBe("handbook");
    expect(p.layout.collection).toBe("handbook");
  });
});
