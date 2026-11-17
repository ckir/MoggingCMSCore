import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import type { Sql } from "postgres";
import {
  boolean, defineCollection, defineConfig, json, list, number, object, richText, slug, text,
} from "@mogging/core";
import type { Ctx } from "@mogging/core";
import { defineStarlightLayout } from "../../src/index.js";
import type { StarlightLayoutInput } from "../../src/index.js";

/** The Starlight docs collection: the draft of plan 6b's preset, so its field names are the ones 6b ships. */
export const docs = defineCollection("docs", {
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
});

/** Config over `docs`: English source, German and Simplified Chinese targets. */
export const config = defineConfig({ collections: [docs], locales: { source: "en", chains: { de: ["en"], "zh-CN": ["en"] } } });

/** The layout input of the preset (root-locale mode, `fr/` a Starlight locale Mogging does not manage). */
export const layoutInput: StarlightLayoutInput = {
  collection: "docs", passthrough: "extra", otherLocaleDirs: ["fr"],
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

/** The validated layout, root-locale mode (docsDir `src/content/docs`). */
export const layout = defineStarlightLayout(layoutInput, config);

/** The same input in the own-folder mode (`sourceDir: "en"`); Tasks 12 to 16 each run at least one test against it. */
export const layoutOwn = defineStarlightLayout({ ...layoutInput, sourceDir: "en" }, config);

/** Builds the write context over `config` for a test connection. */
export const ctxFor = (sql: Sql, actor = "tester"): Ctx => ({ sql, config, actor });

/** Writes `files` (POSIX relative path -> content) under `root` (a fresh temp directory when null) and returns its path. */
export function writeTree(root: string | null, files: Record<string, string>): string {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "mog-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

/** A fresh temp project root holding `files` (POSIX relative path -> content). */
export function project(files: Record<string, string>): string {
  return writeTree(null, files);
}

/** Every file under `root` as POSIX relative path -> text. */
export function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

/** Opens a second connection on the same per-test schema as `sql` (as `core/test/fixtures.ts`). Caller must `end()` it. */
export async function extraConnection(sql: Sql): Promise<Sql> {
  const [{ s }] = (await sql`select current_schema() as s`) as unknown as [{ s: string }];
  return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: s } });
}

/**
 * An `extraConnection` that counts every query it runs (postgres.js `debug` callback).
 *
 * @returns the connection (caller must `end()` it), `count()` of queries since the last `reset()`, and `reset()`.
 */
export async function countingSql(sql: Sql): Promise<{ sql: Sql; count(): number; reset(): void }> {
  const [{ s }] = (await sql`select current_schema() as s`) as unknown as [{ s: string }];
  let n = 0;
  const counting = postgres(process.env.DATABASE_URL!, {
    max: 1, onnotice: () => {}, connection: { search_path: s }, debug: () => { n++; },
  });
  return { sql: counting, count: () => n, reset: () => { n = 0; } };
}
