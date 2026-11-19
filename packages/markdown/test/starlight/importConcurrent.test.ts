import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { Sql } from "postgres";
import { ValidationError, migrate } from "@mogging/core";
import type { ImportReport } from "../../src/import.js";
import { importFolder } from "../../src/import.js";
import { withPooledTestDb, withTestDb } from "../db.js";
import { countingSql, ctxFor, layout, project } from "./fixtures.js";
import { dumpEndState, runScenario } from "./endState.js";

// Records `report.starlight.concurrency` and the raw (unsorted, as returned) `report.warnings` of every import,
// including the ones `runScenario` makes (it calls the module's `importFolder` and returns the normalized report,
// which leaves the concurrency out and sorts the warnings).
const seen = vi.hoisted(() => [] as unknown[]);
const seenWarnings = vi.hoisted(() => [] as unknown[]);
vi.mock("../../src/import.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/import.js")>();
  return {
    ...m,
    importFolder: async (...args: Parameters<typeof m.importFolder>) => {
      const r = await m.importFolder(...args);
      seen.push(r.starlight?.concurrency);
      seenWarnings.push(r.warnings.map((w) => ({ file: w.file, message: w.message })));
      return r;
    },
  };
});

const D = "src/content/docs";
const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "import-end-state.json");
const page = (title: string, body: string): string => `---\ntitle: ${title}\n---\n${body}\n`;

function put(root: string, rel: string, text: string): void {
  const full = path.join(root, D, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

const SLUGS = ["a", "b", "c", "d", "e", "f"];

/** Six pages (or the `slugs` given), each with a German and a `zh-CN` file; `skip` names a file (relative to the docs folder) to leave out. */
function sixPages(skip: string[] = [], titles: Record<string, string> = {}, slugs: string[] = SLUGS): string {
  const root = project({});
  for (const s of slugs) {
    for (const [rel, title] of [[`${s}.md`, s.toUpperCase()], [`de/${s}.md`, `${s}-de`], [`zh-cn/${s}.md`, `${s}-zh`]] as const) {
      if (!skip.includes(rel)) put(root, rel, page(titles[rel] ?? title, `body ${rel}`));
    }
  }
  return root;
}

const run = (sql: Sql, root: string, starlight: Record<string, unknown> = {}, publish = true): Promise<ImportReport> =>
  importFolder(ctxFor(sql), { dir: root, publish, starlight: { layout, ...starlight } });

describe("importFolder, Starlight mode, concurrent locale writes", () => {
  test("(a) concurrency 1 and 4 leave the end state and report of the golden", async () => {
    const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as { phases: unknown };
    const results: unknown[] = [];
    const rawWarnings: unknown[][] = [];
    for (const concurrency of [1, 4]) {
      seen.length = 0;
      seenWarnings.length = 0;
      await withPooledTestDb(8, async (sql) => {
        await migrate(sql);
        results.push(await runScenario(sql, ctxFor(sql), { concurrency }));
      });
      expect(seen, `concurrency ${concurrency}`).toEqual(
        Array.from({ length: 3 }, () => ({ requested: concurrency, effective: concurrency, limit: "pool", poolMax: 8 })),
      );
      rawWarnings.push([...seenWarnings]);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toEqual(golden.phases);
    // `endState.ts` sorts the warnings, so the order `report.warnings` comes back in is compared here, raw.
    expect(rawWarnings[0]).toHaveLength(3);
    expect(rawWarnings[0]!.flat().length, "the scenario reports at least one warning").toBeGreaterThan(0);
    expect(rawWarnings[1]).toEqual(rawWarnings[0]);
  });

  test("(a2) several warnings from different documents come back in the same order at 1 and 4", async () => {
    // Locale files whose English page does not exist: one warning each, from the locale phase's planning loop.
    const raw: unknown[][] = [];
    for (const concurrency of [1, 4]) {
      seenWarnings.length = 0;
      await withPooledTestDb(8, async (sql) => {
        await migrate(sql);
        const root = sixPages();
        for (const rel of ["de/m.md", "de/n.md", "zh-cn/n.md", "de/o.md"]) put(root, rel, page(rel, `orphan ${rel}`));
        const r = await run(sql, root, { concurrency });
        expect(r.errors).toEqual([]);
        expect(r.warnings.length, "warnings from at least three documents").toBeGreaterThanOrEqual(3);
      });
      raw.push([...seenWarnings]);
    }
    expect(raw[0]).toHaveLength(1);
    expect((raw[0]![0] as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect(raw[1]).toEqual(raw[0]);
  }, 20_000);

  test("(b) a pool of 2 clamps a request of 8 to 2 and finishes", async () => {
    await withPooledTestDb(2, async (sql) => {
      await migrate(sql);
      const r = await run(sql, sixPages(), { concurrency: 8 });
      expect(r.starlight!.concurrency).toEqual({ requested: 8, effective: 2, limit: "pool", poolMax: 2 });
      expect(r.errors).toEqual([]);
      expect(r.files.filter((f) => f.file.includes("/de/") && f.published)).toHaveLength(6);
    });
  }, 20_000);

  test("(c) a single-connection handle clamps to 1", async () => {
    await withTestDb(async (sql) => {
      await migrate(sql);
      const r = await run(sql, sixPages(), { concurrency: 4 });
      expect(r.starlight!.concurrency).toEqual({ requested: 4, effective: 1, limit: "pool", poolMax: 1 });
      expect(r.errors).toEqual([]);
    });
  }, 20_000);

  test("(d) a transaction handle runs at 1", async () => {
    await withPooledTestDb(8, async (sql) => {
      await migrate(sql);
      const root = sixPages();
      const r = await sql.begin((tx) => importFolder(ctxFor(tx as unknown as Sql), {
        dir: root, publish: true, starlight: { layout, concurrency: 4 },
      }));
      expect(r.starlight!.concurrency).toEqual({ requested: 4, effective: 1, limit: "transaction" });
      expect(r.errors).toEqual([]);
      expect((await dumpEndState(sql)).documents).toHaveLength(6);
    });
  }, 20_000);

  test("(e) a failing file at 4 becomes that file's error; everything else is committed", async () => {
    const BOOM = "injected failure for the boom title";
    let clean: Awaited<ReturnType<typeof dumpEndState>> | undefined;
    await withPooledTestDb(8, async (sql) => {
      await migrate(sql);
      const r = await run(sql, sixPages(["de/c.md"]), { concurrency: 4 });
      expect(r.errors).toEqual([]);
      clean = await dumpEndState(sql);
    });
    await withPooledTestDb(8, async (sql) => {
      await migrate(sql);
      await sql.unsafe(`create function boom_guard() returns trigger language plpgsql as $$
        begin raise exception '${BOOM}'; end $$`);
      await sql.unsafe(`create trigger boom before insert on document_localized for each row
        when (new.data->>'title' = 'boom') execute function boom_guard()`);
      const r = await run(sql, sixPages([], { "de/c.md": "boom" }), { concurrency: 4 });
      expect(r.starlight!.concurrency.effective).toBe(4);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.file).toBe(`${D}/de/c.md`);
      expect(r.errors[0]!.message).toContain(BOOM);
      expect(r.files.find((f) => f.file === `${D}/de/c.md`)).toMatchObject({ outcome: "error", published: false });
      expect(r.files.filter((f) => f.outcome === "error")).toHaveLength(1);
      expect(r.files.find((f) => f.file === `${D}/zh-cn/c.md`)).toMatchObject({ outcome: "updated", published: true });
      expect(await dumpEndState(sql)).toEqual(clean);
    });
  }, 20_000);

  test("(f) a dry run reports the concurrency; 0 throws before any statement", async () => {
    await withPooledTestDb(8, async (sql) => {
      await migrate(sql);
      const root = sixPages();
      const r = await run(sql, root, { concurrency: 4, dryRun: true });
      expect(r.starlight).toMatchObject({ dryRun: true, concurrency: { requested: 4, effective: 4, limit: "pool", poolMax: 8 } });
      expect((await dumpEndState(sql)).documents).toEqual([]);

      const counting = await countingSql(sql);
      try {
        await expect(
          importFolder(ctxFor(counting.sql), { dir: root, publish: true, starlight: { layout, concurrency: 0 } }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(counting.count()).toBe(0);
      } finally {
        await counting.sql.end();
      }
    });
  });

  test("(g) an unchanged project at concurrency 8 reports the concurrency and writes nothing", async () => {
    await withPooledTestDb(8, async (sql) => {
      await migrate(sql);
      const root = sixPages();
      await run(sql, root);
      const before = await dumpEndState(sql);
      const r = await run(sql, root, { concurrency: 8 });
      expect(r.starlight!.concurrency).toEqual({ requested: 8, effective: 8, limit: "pool", poolMax: 8 });
      expect(r.files.every((f) => f.outcome === "unchanged")).toBe(true);
      expect(r.errors).toEqual([]);
      expect(await dumpEndState(sql)).toEqual(before);
    });
  });

  test("writes of different documents overlap at 4, never at 1, and never within one document", async () => {
    const overlap = async (concurrency: number, slugs: string[]): Promise<{ peak: number; sameDoc: boolean }> => {
      let out = { peak: 0, sameDoc: false };
      await withPooledTestDb(8, async (sql) => {
        await migrate(sql);
        await sql.unsafe(`create table probe (doc uuid, tx0 timestamptz, t0 timestamptz, t1 timestamptz)`);
        await sql.unsafe(`create function probe_fn() returns trigger language plpgsql as $$
          declare t timestamptz := clock_timestamp();
          begin perform pg_sleep(0.1); insert into probe values (new.doc_id, now(), t, clock_timestamp()); return new; end $$`);
        await sql.unsafe(`create trigger probe before insert on document_localized for each row execute function probe_fn()`);
        const r = await run(sql, sixPages([], {}, slugs), { concurrency });
        expect(r.errors).toEqual([]);
        const rows = (await sql`select doc, tx0, t0, t1 from probe`) as unknown as Array<{ doc: string; tx0: Date; t0: Date; t1: Date }>;
        expect(rows).toHaveLength(slugs.length * 3); // the English rows (written first, one at a time) and the locale rows
        // Two files of one document: the second's transaction must start after the first has finished (the document
        // row lock alone would also serialise them, so compare the transaction start, not the trigger start).
        const clash = (x: typeof rows[number], y: typeof rows[number]): boolean => x.tx0 < y.t1 && y.tx0 < x.t1;
        let peak = 0;
        let sameDoc = false;
        for (const x of rows) {
          // the most intervals open at one instant: count those open at each interval's start
          peak = Math.max(peak, rows.filter((y) => y.t0 <= x.t0 && x.t0 < y.t1).length);
          if (rows.some((y) => y !== x && y.doc === x.doc && clash(x, y))) sameDoc = true;
        }
        out = { peak, sameDoc };
      });
      return out;
    };
    expect(await overlap(1, SLUGS)).toEqual({ peak: 1, sameDoc: false });
    const four = await overlap(4, SLUGS);
    expect(four.peak).toBeGreaterThanOrEqual(2);
    expect(four.peak).toBeLessThanOrEqual(4);
    expect(four.sameDoc).toBe(false);
    // Two documents at 4: their four files are all queued at once, so only the grouping keeps one document's two
    // files apart (the document row lock would otherwise serialise the writes but not the transactions).
    expect(await overlap(4, ["a", "b"])).toMatchObject({ sameDoc: false });
  }, 30_000);
});

