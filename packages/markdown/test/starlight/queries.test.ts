import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { migrate } from "@mogging/core";
import { exportFolder } from "../../src/export.js";
import { importFolder } from "../../src/import.js";
import { withTestDb } from "../db.js";
import { countingSql, ctxFor, layout, project, writeTree } from "./fixtures.js";

// Spec section 6, the acceptance bar: the Starlight import and export read the database once per PAGE of documents
// (`listDocuments({ limit: 200 })`), never once per file. A page boundary is 200 documents, so 50 and 150 documents
// are one page, 250 are two pages and 450 are three.
const D = "src/content/docs";

type Counts = { importQueries: number; exportQueries: number };

/**
 * Grows one project to each of `sizes` pages (x 2 locales: en and de), importing and exporting it after every growth
 * step, then counts the database queries of one unchanged re-export and one unchanged re-import on a second,
 * counting connection. One database is reused across the sizes so that each page is seeded only once.
 *
 * @param sizes ascending page counts
 * @returns the query counts per page count
 */
async function measure(sizes: number[]): Promise<Record<number, Counts>> {
  const root = project({});
  const out: Record<number, Counts> = {};
  try {
    await withTestDb(async (sql) => {
      await migrate(sql);
      const ctx = ctxFor(sql);
      const imp = (c: typeof ctx) => importFolder(c, { dir: root, starlight: { layout } });
      const exp = (c: typeof ctx) => exportFolder(c, { dir: root, starlight: { layout } });
      const counting = await countingSql(sql);
      try {
        const cctx = { ...ctx, sql: counting.sql };
        let have = 0;
        for (const pages of sizes) {
          const files: Record<string, string> = {};
          for (let i = have; i < pages; i++) {
            files[`${D}/p${i}.md`] = `---\ntitle: P${i}\n---\nBody ${i}\n`;
            files[`${D}/de/p${i}.md`] = `---\ntitle: S${i}\n---\nInhalt ${i}\n`;
          }
          writeTree(root, files);
          have = pages;
          const first = await imp(ctx);
          expect(first.errors).toEqual([]);
          expect(first.files).toHaveLength(pages * 2);
          const written = await exp(ctx);
          expect(written.starlight!.attention).toEqual([]);

          counting.reset();
          const again = await exp(cctx);
          const exportQueries = counting.count();
          // The run must be the real unchanged path, not an early exit that would make the count meaningless.
          expect(again.starlight!.attention).toEqual([]);
          // Export acts on the target-locale files only (English is the source and is never written): one keep per page.
          expect(again.starlight!.actions.filter((a) => a.action === "keep")).toHaveLength(pages);
          expect(again.starlight!.actions.filter((a) => a.action !== "keep")).toEqual([]);

          counting.reset();
          const reimport = await imp(cctx);
          const importQueries = counting.count();
          expect(reimport.errors).toEqual([]);
          expect(reimport.files).toHaveLength(pages * 2);
          expect(reimport.files.every((f) => f.outcome === "unchanged")).toBe(true);

          out[pages] = { importQueries, exportQueries };
        }
      } finally {
        await counting.sql.end();
      }
    });
  } finally {
    fs.rmSync(path.resolve(root), { recursive: true, force: true });
  }
  return out;
}

describe("Starlight import and export read the database per page of documents", () => {
  test("an unchanged re-export and re-import issue a query count independent of the page count", async () => {
    const c = await measure([50, 150, 250, 450]);
    const counts = JSON.stringify(c);

    for (const key of ["exportQueries", "importQueries"] as const) {
      const [n50, n150, n250, n450] = [50, 150, 250, 450].map((n) => c[n]![key]);
      expect(n50, `${key} must be non-zero: ${counts}`).toBeGreaterThan(0);
      // One page of documents (up to 200): the same count however many files it holds.
      expect(n150, `${key} 50 vs 150 pages: ${counts}`).toBe(n50);
      // Each further page of documents adds the same amount: 250 is two pages, 450 is three.
      const perPage = n250! - n50!;
      expect(perPage, `${key} a second page must cost queries: ${counts}`).toBeGreaterThan(0);
      expect(n450! - n250!, `${key} per extra page: ${counts}`).toBe(perPage);
      // The cost of a page of 200 documents (400 files) is far below one query per document.
      expect(perPage, `${key} bounded per page, not per file: ${counts}`).toBeLessThan(200);
    }
  }, 300_000);
});
