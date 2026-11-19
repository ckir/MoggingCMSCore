import fs from "node:fs";
import { expect, test } from "vitest";
import { defineConfig, migrate } from "@mogging/core";
import type { Ctx } from "@mogging/core";
import { exportFolder } from "../../src/export.js";
import { importFolder } from "../../src/import.js";
import { defineStarlightLayout } from "../../src/index.js";
import { withPooledTestDb, withTestDb } from "../db.js";
import { countingSql, docs, layoutInput, project, writeTree } from "./fixtures.js";

// The measurement of spec section 6 (performance): 2,000 pages x 6 locales through the Starlight import and export,
// each run twice, printing wall time and database query count per run. It runs only when MOGGING_PERF is set,
// like the live test. The owner's timing discipline applies: the figures are taken by the controller at the top
// level on an idle machine (backgrounded, no other tool call until it finishes), never by a subagent:
//   MOGGING_PERF=1 pnpm --filter @mogging/markdown test perf --reporter=verbose
// (the default reporter hides the console output of a passing test, which is where the PERF lines go)
const PAGES = 2000;
const D = "src/content/docs";

/** Six locales: English source, five targets. */
const perfConfig = defineConfig({
  collections: [docs],
  locales: { source: "en", chains: { de: ["en"], "zh-CN": ["en"], es: ["en"], ja: ["en"], "pt-BR": ["en"] } },
});
const perfLayout = defineStarlightLayout({ ...layoutInput, otherLocaleDirs: [] }, perfConfig);

/** The 2,000-page, 6-locale file tree both perf tests write to disk. */
function perfFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < PAGES; i++) {
    files[`${D}/p${i}.md`] = `---\ntitle: Page ${i}\ndescription: About page ${i}\n---\nBody of page ${i}.\n`;
    for (const [locale, folder] of Object.entries(perfLayout.localeDirs)) {
      files[`${D}/${folder}/p${i}.md`] = `---\ntitle: ${locale} ${i}\ndescription: ${locale} about ${i}\n---\n${locale} body ${i}.\n`;
    }
  }
  return files;
}

test.skipIf(!process.env.MOGGING_PERF)(
  `perf: ${PAGES} pages x 6 locales, import and export twice each`,
  async () => {
    const files = perfFiles();
    const root = project({});
    try {
      writeTree(root, files);
      await withTestDb(async (sql) => {
        await migrate(sql);
        const counting = await countingSql(sql);
        try {
          const ctx: Ctx = { sql: counting.sql, config: perfConfig, actor: "perf" };
          const input = { dir: root, starlight: { layout: perfLayout } };
          const timed = async <T>(label: string, run: () => Promise<T>, size: (r: T) => string): Promise<T> => {
            counting.reset();
            const t0 = performance.now();
            const r = await run();
            const wall = performance.now() - t0;
            console.log(`PERF ${label}: wall ${(wall / 1000).toFixed(1)} s, ${counting.count()} queries, ${size(r)}`);
            return r;
          };
          const imp = () => timed("import 1", () => importFolder(ctx, input), (r) => `${r.files.length} files, ${r.errors.length} errors`);
          const first = await imp();
          expect(first.errors).toEqual([]);
          expect(first.files).toHaveLength(PAGES * 6);
          const second = await timed("import 2", () => importFolder(ctx, input), (r) => `${r.files.length} files, ${r.errors.length} errors`);
          expect(second.errors).toEqual([]);
          expect(second.files.every((f) => f.outcome === "unchanged")).toBe(true);

          const exp = (label: string) => timed(label, () => exportFolder(ctx, input), (r) => `${r.starlight!.actions.length} actions`);
          const e1 = await exp("export 1");
          expect(e1.starlight!.attention).toEqual([]);
          const e2 = await exp("export 2");
          expect(e2.starlight!.attention).toEqual([]);
          expect(e2.starlight!.actions.every((a) => a.action === "keep")).toBe(true);
        } finally {
          await counting.sql.end();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  3_600_000,
);

// The concurrent arm: the same first import on a pool of 8 with `concurrency: 8`. `countingSql` counts on its own
// max-1 connection and cannot count a pool, so the count here hooks the pool's own postgres.js `debug` option,
// which every pooled connection reads per query (`sql.options` is the object the connections share).
test.skipIf(!process.env.MOGGING_PERF)(
  `perf: ${PAGES} pages x 6 locales, first import at concurrency 8`,
  async () => {
    const files = perfFiles();
    const root = project({});
    try {
      writeTree(root, files);
      await withPooledTestDb(8, async (sql) => {
        await migrate(sql);
        let queries = 0;
        sql.options.debug = () => { queries++; };
        const ctx: Ctx = { sql, config: perfConfig, actor: "perf" };
        const input = { dir: root, starlight: { layout: perfLayout, concurrency: 8 } };
        queries = 0;
        const t0 = performance.now();
        const r = await importFolder(ctx, input);
        const wall = performance.now() - t0;
        console.log(`PERF import 1 (concurrency 8): wall ${(wall / 1000).toFixed(1)} s, queries ${queries}`);
        expect(r.errors).toEqual([]);
        expect(r.files).toHaveLength(PAGES * 6);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  3_600_000,
);
