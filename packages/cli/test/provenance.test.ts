import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { migrate } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import type { Deps } from "../src/types.js";
import { withTestDb } from "./db.js";
import { aiConfigFor, config, testDeps } from "./fixtures.js";
import { identity, mockModel } from "./mockModel.js";

type Model = Parameters<typeof aiConfigFor>[0];
type Row = { id: number; locale: string; fieldPath: string | null; discarded: boolean; discardReason: string | null };

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mogging-cli-content-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const EN = (title: string) => `---\ntitle: ${title}\n---\nHello\n`;

async function seedDoc(sql: Sql, name = "a"): Promise<string> {
  expect(await run(["import", tree({ [`en/docs/${name}.md`]: EN("A") }), "--publish"], testDeps(sql))).toBe(0);
  return (await sql`select id from documents order by created_at limit 1`)[0]!.id as string;
}

async function compileWith(sql: Sql, model: Model, locale: string): Promise<void> {
  const t = testDeps(sql, { loadModule: async () => ({ config, ai: aiConfigFor(model) }) });
  await run(["compile", "--locales", locale, "--budget", "1"], t);
}

async function provenanceCmd(sql: Sql, args: string[], overrides: Partial<Deps> = {}) {
  const t = testDeps(sql, overrides);
  const code = await run(["provenance", ...args], t);
  return { code, out: t.stdout(), err: t.stderr() };
}

const rowsOf = (out: string) => (JSON.parse(out) as { data: Row[] }).data;

async function insertRows(sql: Sql, docId: string, n: number): Promise<void> {
  await sql`insert into content_provenance (doc_id, locale, model_id, prompt_version, prompt_tokens, completion_tokens, cost_micros)
    select ${docId}::uuid, 'de', 'mock/translate', 'translate.v1.standard', 1, 1, 1 from generate_series(1, ${n}::int)`;
}

describe("mogging provenance", () => {
  test("a missing target, --limit 0 and --limit 1001 are usage errors before connecting", async () => {
    await withTestDb(async (sql) => {
      for (const args of [[], ["docs/a", "--limit", "0"], ["docs/a", "--limit", "1001"], ["docs/a", "--limit", "abc"]]) {
        let connected = false;
        const r = await provenanceCmd(sql, args, { connect: () => { connected = true; throw new Error("connected"); } });
        expect(r.code, args.join(" ")).toBe(2);
        expect(r.err).not.toContain("unknown command");
        expect(connected).toBe(false);
      }
    });
  });

  test("after a compile the document's rows appear, one per translated field", async () => {
    await withDb(async (sql) => {
      await seedDoc(sql);
      await compileWith(sql, mockModel([identity]), "de");
      const r = await provenanceCmd(sql, ["docs/a"]);
      expect(r.code).toBe(0);
      const lines = r.out.split("\n");
      expect(lines[0]).toMatch(/^id +locale +version +field +job +model +tokens +cost_usd +discarded +reason$/);
      expect(lines).toHaveLength(4); // header, two rows, trailing newline
      expect(lines[1]).toMatch(/^\d+ +de +1 +(body|title) +\d+ +mock\/translate +\d+\/\d+ +0\.\d{6} +- +-$/);
      expect(lines[2]).toMatch(/^\d+ +de +1 +(body|title) +\d+ +mock\/translate +\d+\/\d+ +0\.\d{6} +- +-$/);

      const json = rowsOf((await provenanceCmd(sql, ["docs/a", "--json"])).out);
      expect(json.map((x) => x.fieldPath).sort()).toEqual(["body", "title"]);
      expect(json.every((x) => !x.discarded)).toBe(true);
    });
  });

  test("a call the validator rejected shows as a discarded row; --discarded-only and --locale filter", async () => {
    await withDb(async (sql) => {
      await seedDoc(sql);
      await compileWith(sql, mockModel([identity]), "de");
      await compileWith(sql, mockModel([{ nope: 1 }, { nope: 1 }]), "fr");

      const all = rowsOf((await provenanceCmd(sql, ["docs/a", "--json"])).out);
      expect(all).toHaveLength(4);

      const discarded = await provenanceCmd(sql, ["docs/a", "--discarded-only"]);
      expect(discarded.code).toBe(0);
      const lines = discarded.out.split("\n").filter((l) => l !== "");
      expect(lines).toHaveLength(3); // header and the two calls (standard, strict)
      for (const l of lines.slice(1)) expect(l).toMatch(/ fr .* yes +validation:/);

      const onlyDe = rowsOf((await provenanceCmd(sql, ["docs/a", "--locale", "de", "--json"])).out);
      expect(onlyDe.map((x) => x.locale)).toEqual(["de", "de"]);
      const jsonDiscarded = rowsOf((await provenanceCmd(sql, ["docs/a", "--discarded-only", "--json"])).out);
      expect(jsonDiscarded).toHaveLength(2);
      expect(jsonDiscarded.every((x) => x.discarded && x.locale === "fr" && x.discardReason?.startsWith("validation:"))).toBe(true);
    });
  });

  test("205 rows are all printed without --limit and --limit 10 prints one page of 10", async () => {
    await withDb(async (sql) => {
      const docId = await seedDoc(sql);
      await insertRows(sql, docId, 205);
      const all = await provenanceCmd(sql, ["docs/a"]);
      expect(all.out.split("\n").filter((l) => l !== "")).toHaveLength(206); // header and 205 rows
      const some = await provenanceCmd(sql, ["docs/a", "--limit", "10"]);
      expect(some.out.split("\n").filter((l) => l !== "")).toHaveLength(11);
      const allRows = rowsOf((await provenanceCmd(sql, ["docs/a", "--json"])).out);
      expect(allRows).toHaveLength(205);
      // Identity, not just a count: --limit returns the FIRST page of the full listing, in the same order.
      const firstPage = rowsOf((await provenanceCmd(sql, ["docs/a", "--limit", "10", "--json"])).out);
      expect(firstPage.map((x) => x.id)).toEqual(allRows.slice(0, 10).map((x) => x.id));
    });
  }, 30_000);

  test("more than one core page (1005 rows) is read through afterId without a gap or a repeat", async () => {
    await withDb(async (sql) => {
      const docId = await seedDoc(sql);
      await insertRows(sql, docId, 1005);
      const rows = rowsOf((await provenanceCmd(sql, ["docs/a", "--json"])).out);
      expect(rows).toHaveLength(1005);
      expect(new Set(rows.map((x) => x.id)).size).toBe(1005);
      const ids = (await sql`select id from content_provenance order by created_at, id`).map((r) => Number(r.id));
      expect(rows.map((x) => x.id)).toEqual(ids);
    });
  }, 30_000);

  test("works without an ai export", async () => {
    await withDb(async (sql) => {
      const docId = await seedDoc(sql);
      await insertRows(sql, docId, 3);
      const r = await provenanceCmd(sql, ["docs/a"], { loadModule: async () => ({ config }) });
      expect(r.code).toBe(0);
      expect(r.out.split("\n").filter((l) => l !== "")).toHaveLength(4);
    });
  });

  test("an unknown document is an error and a target without a slash is a usage error", async () => {
    await withDb(async (sql) => {
      await seedDoc(sql);
      expect((await provenanceCmd(sql, ["docs/nope"])).code).toBe(1);
      expect((await provenanceCmd(sql, ["docs"])).code).toBe(2);
    });
  });
});
