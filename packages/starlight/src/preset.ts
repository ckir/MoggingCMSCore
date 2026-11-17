import {
  boolean, defineCollection, json, list, number, object, richText, slug, text, ValidationError,
} from "@mogging/core";
import type { Collection, Field } from "@mogging/core";
import type { StarlightLayoutInput } from "@mogging/markdown";

/** Options of `starlightPreset`; every one is optional. */
export type StarlightPresetOptions = {
  /** Name of the docs collection; default `"docs"`. */
  collection?: string;
  /** Docs folder relative to the project root; left out of the layout when undefined (the layout default is `src/content/docs`). */
  docsDir?: string;
  /** Folder of the source locale, or `null` for the root-locale mode; left out of the layout when undefined (root-locale mode). */
  sourceDir?: string | null;
  /** Folder overrides by target locale; left out of the layout when undefined. */
  localeDirs?: Record<string, string>;
  /** Top-level folders that are Starlight locales Mogging does not manage; default `[]`. */
  otherLocaleDirs?: string[];
  /** The adopter's own front-matter keys (Starlight's `docsSchema({ extend })`), added after the preset fields. */
  extraFields?: Record<string, Field>;
};

/** The result of `starlightPreset`: a docs collection and the Starlight layout input that maps it. */
export type StarlightPreset = { collection: Collection; layout: StarlightLayoutInput };

/**
 * The fields of the Starlight docs collection: the front-matter keys of Starlight's docs schema (spec 5.8) as
 * localized and shared fields, the `extra` passthrough for every key no field maps, and the Markdown `body`.
 * Called per preset so that no two presets share a field object.
 */
function presetFields(): Record<string, Field> {
  return {
    slug: slug(),
    title: text({ localized: true, required: true }),
    description: text({ localized: true }),
    template: text(), draft: boolean(), pagefind: boolean(),
    sidebarOrder: number(), sidebarHidden: boolean(), sidebarAttrs: json(),
    sidebarLabel: text({ localized: true }),
    sidebarBadge: object({ text: text(), variant: text({ translate: false }), class: text({ translate: false }) }, { localized: true }),
    prevToggle: boolean(), prev: object({ label: text(), link: text({ translate: false }) }, { localized: true }),
    nextToggle: boolean(), next: object({ label: text(), link: text({ translate: false }) }, { localized: true }),
    hero: object({
      title: text(), tagline: text(),
      image: object({ alt: text(), file: text({ translate: false }), dark: text({ translate: false }),
                      light: text({ translate: false }), html: text({ translate: false }) }),
      actions: list(object({ text: text(), link: text({ translate: false }), variant: text({ translate: false }),
                             icon: text({ translate: false }) })),
    }, { localized: true }),
    banner: object({ content: text() }, { localized: true }),
    editUrl: json(), lastUpdated: json(), tableOfContents: json(), head: json(),
    extra: json(),
    body: richText({ localized: true, body: true }),
  };
}

/**
 * Builds the Starlight docs collection and the layout input that maps it to Starlight's front matter. Pass both to
 * `defineConfig` (the collection) and `starlight` (the layout) in `mogging.config.ts`.
 *
 * The preset encodes the mapping of spec 5.8 (front-matter keys to fields: `sidebar.*`, the `prev`/`next` toggles
 * and the `hero`, `banner` and `head` shapes) and of spec 5.9 (the `extra` passthrough, the `hero.image` file
 * references and the `hero` that a source file must carry).
 *
 * @param options - Collection name, folder layout and the adopter's extra front-matter fields; all optional.
 * @returns The `collection` and the `layout` input, a fresh pair on every call.
 * @throws {ValidationError} When an `extraFields` name equals a preset field name (`starlightPreset: extra field "<name>" collides with a preset field`).
 */
export function starlightPreset(options: StarlightPresetOptions = {}): StarlightPreset {
  const name = options.collection ?? "docs";
  const fields = presetFields();
  for (const key of Object.keys(options.extraFields ?? {})) {
    if (Object.hasOwn(fields, key)) throw new ValidationError(`starlightPreset: extra field "${key}" collides with a preset field`);
  }
  const collection = defineCollection(name, { ...fields, ...Object.fromEntries(Object.entries(options.extraFields ?? {})) });
  const layout: StarlightLayoutInput = {
    collection: name, passthrough: "extra", otherLocaleDirs: options.otherLocaleDirs ?? [],
    paths: [
      { path: "sidebar.order", field: "sidebarOrder" }, { path: "sidebar.hidden", field: "sidebarHidden" },
      { path: "sidebar.attrs", field: "sidebarAttrs" }, { path: "sidebar.label", field: "sidebarLabel" },
      { path: "sidebar.badge", field: "sidebarBadge", stringAs: "text" },
      { path: "prev", union: { toggle: "prevToggle", value: "prev", stringAs: "label" } },
      { path: "next", union: { toggle: "nextToggle", value: "next", stringAs: "label" } },
    ],
    fileRefs: ["hero.image.file", "hero.image.dark", "hero.image.light"],
    requiredWhenSource: ["hero"],
  };
  if (options.docsDir !== undefined) layout.docsDir = options.docsDir;
  if (options.sourceDir !== undefined) layout.sourceDir = options.sourceDir;
  if (options.localeDirs !== undefined) layout.localeDirs = options.localeDirs;
  return { collection, layout };
}
