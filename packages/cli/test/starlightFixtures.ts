import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Sql } from "postgres";
import { afterAll } from "vitest";
import { defineConfig } from "@mogging/core";
import { starlightPreset } from "@mogging/starlight/preset";
import type { Deps } from "../src/types.js";
import { testDeps } from "./fixtures.js";

/** The default Starlight preset: the `docs` collection and its layout input. */
export const starlightDocs = starlightPreset();

/** A config over the preset collection with source `en` and target locales `de` and `zh-CN`. */
export const starlightConfig = defineConfig({
  collections: [starlightDocs.collection],
  locales: { source: "en", chains: { de: ["en"], "zh-CN": ["en"] } },
});

const projectRoots: string[] = [];
// Not `process.once("exit")`: that never fires in a vitest worker. `afterAll` runs once per test file that imports this.
afterAll(() => {
  for (const d of projectRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A fresh `mkdtemp` project root holding an empty `mogging.config.ts` and each of `files` at its project-relative
 * path; removed when the importing test file finishes.
 *
 * @param files file text by project-relative POSIX path.
 * @returns the absolute project root.
 */
export function starlightProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mogging-cli-starlight-"));
  projectRoots.push(root);
  writeFileSync(join(root, "mogging.config.ts"), "");
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

/**
 * `testDeps` for a Starlight project: the working directory is `root` and the config module exports the Starlight
 * config and layout.
 *
 * @param sql the per-test schema connection.
 * @param root the project root from `starlightProject`.
 * @param overrides replace any default.
 * @returns the test deps.
 */
export function starlightDeps(sql: Sql, root: string, overrides: Partial<Deps> = {}) {
  return testDeps(sql, {
    cwd: root,
    loadModule: async () => ({ config: starlightConfig, starlight: starlightDocs.layout }),
    ...overrides,
  });
}

/** A page file: `title`, extra front-matter lines (each ending in a newline) and a body. */
export const page = (title: string, extra = "", body = "Hello"): string => `---\ntitle: ${title}\n${extra}---\n${body}\n`;

/** An `astro.config.mjs` with a root locale `en`, `de` and `zh-cn` (lang `zh-CN`). */
export const ASTRO_ROOT_DE_ZH = `import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Docs",
      locales: {
        root: { label: "English", lang: "en" },
        de: { label: "Deutsch", lang: "de" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
      },
    }),
  ],
});
`;
