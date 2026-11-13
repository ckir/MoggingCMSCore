import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { enqueueStale } from "@mogging/ai";
import { migrate } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import type { Deps } from "../src/types.js";
import { withTestDb } from "./db.js";
import { aiConfigFor, config, ctxFor, testDeps } from "./fixtures.js";
import { mockModel } from "./mockModel.js";

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

/** Publishes the `en` files and queues one `de` job per document; returns the document ids. */
async function seedJobs(sql: Sql, files: Record<string, string>): Promise<string[]> {
  expect(await run(["import", tree(files), "--publish"], testDeps(sql))).toBe(0);
  await enqueueStale(ctxFor(sql, mockModel([])), { locales: ["de"] });
  return (await sql`select doc_id from ai_jobs order by id`).map((r) => r.doc_id as string);
}

async function jobsCmd(sql: Sql, args: string[], overrides: Partial<Deps> = {}) {
  const t = testDeps(sql, { loadModule: async () => ({ config, ai: aiConfigFor(mockModel([])) }), ...overrides });
  const code = await run(["jobs", ...args], t);
  return { code, out: t.stdout(), err: t.stderr() };
}

const jobIds = async (sql: Sql) => (await sql`select id from ai_jobs order by id`).map((r) => Number(r.id));
const stateOf = async (sql: Sql, id: number) => (await sql`select state from ai_jobs where id = ${id}`)[0]!.state as string;

/** `n` CANCELLED jobs of one document (the unique index only covers QUEUED and RUNNING). */
async function insertCancelled(sql: Sql, docId: string, n: number): Promise<void> {
  await sql`insert into ai_jobs (doc_id, locale, field_paths, source_version, state, budget_scope)
    select ${docId}::uuid, 'de', array['title'], g, 'CANCELLED', 'global' from generate_series(1, ${n}::int) g`;
}

describe("mogging jobs: usage errors before connecting", () => {
  const cases: Array<[string, string[]]> = [
    ["--state bogus", ["--state", "bogus"]],
    ["--limit 0", ["--limit", "0"]],
    ["--limit abc", ["--limit", "abc"]],
    ["--limit 1001", ["--limit", "1001"]],
    ["--retry 0", ["--retry", "0"]],
    ["--retry 0x10", ["--retry", "0x10"]],
    ["--retry with an empty entry", ["--retry", "1,"]],
    ["--cancel abc", ["--cancel", "abc"]],
    ["--retry together with --cancel", ["--retry", "1", "--cancel", "2"]],
  ];
  for (const [name, args] of cases) {
    test(`${name} exits 2 and never connects`, async () => {
      await withTestDb(async (sql) => {
        let connected = false;
        const r = await jobsCmd(sql, args, { connect: () => { connected = true; throw new Error("connected"); } });
        expect(r.code).toBe(2);
        expect(r.err).not.toContain("unknown command");
        expect(connected).toBe(false);
        expect(r.out).toBe("");
      });
    });
  }
});

describe("mogging jobs", () => {
  test("lists a queued job, the counts line first, and one line per budget scope", async () => {
    await withDb(async (sql) => {
      const [docId] = await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const r = await jobsCmd(sql, []);
      expect(r.code).toBe(0);
      const lines = r.out.split("\n");
      expect(lines[0]).toBe("queued 1, running 0, failed 0, cancelled 0, completed 0");
      expect(lines[1]).toMatch(/^id +doc +locale +state +attempts +lease holder +lease expiry +error$/);
      expect(lines[2]).toMatch(new RegExp(`^\\d+ +docs/${docId} +de +QUEUED +0 +- +- +-$`));
      expect(lines[3]).toBe("budget global: spent 0.000000 USD, in-flight 0.000000 USD, cap 1.000000 USD");
      expect(lines).toHaveLength(5); // and the trailing newline
    });
  });

  test("--state is upper-cased and filters; the counts line covers the rows listed", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A"), "en/docs/b.md": EN("B") });
      const [first] = await jobIds(sql);
      await sql`update ai_jobs set state = 'CANCELLED' where id = ${first!}`;
      const queued = await jobsCmd(sql, ["--state", "queued"]);
      expect(queued.code).toBe(0);
      expect(queued.out.split("\n")[0]).toBe("queued 1, running 0, failed 0, cancelled 0, completed 0");
      const cancelled = await jobsCmd(sql, ["--state", "Cancelled", "--collection", "docs"]);
      expect(cancelled.out.split("\n")[0]).toBe("queued 0, running 0, failed 0, cancelled 1, completed 0");
    });
  });

  test("--json data is { jobs, budgets }", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const r = await jobsCmd(sql, ["--json"]);
      const doc = JSON.parse(r.out) as {
        ok: boolean; data: { jobs: Array<{ state: string; locale: string }>; budgets: Array<{ scope: string; capMicros: number }> };
      };
      expect(doc.ok).toBe(true);
      expect(Object.keys(doc.data).sort()).toEqual(["budgets", "jobs"]);
      expect(doc.data.jobs).toMatchObject([{ state: "QUEUED", locale: "de" }]);
      expect(doc.data.budgets).toMatchObject([{ scope: "global", capMicros: 1_000_000 }]);
    });
  });

  test("--cancel cancels a queued job and prints the count; --json data is the cancelJobs result", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const [id] = await jobIds(sql);
      const r = await jobsCmd(sql, ["--cancel", String(id)]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("cancelled 1 of 1\n");
      expect(await stateOf(sql, id!)).toBe("CANCELLED");

      const again = await jobsCmd(sql, ["--cancel", String(id), "--json"]);
      expect(again.code).toBe(0);
      expect((JSON.parse(again.out) as { data: unknown }).data).toEqual({ cancelled: 0 });
    });
  });

  test("--retry re-queues a FAILED job: exit 0; --json data is the retryJobs result", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const [id] = await jobIds(sql);
      await sql`update ai_jobs set state = 'FAILED', error_message = 'boom' where id = ${id!}`;
      const r = await jobsCmd(sql, ["--retry", String(id), "--json"]);
      expect(r.code).toBe(0);
      expect((JSON.parse(r.out) as { data: unknown }).data).toEqual({ retried: 1, skipped: [] });
      expect(await stateOf(sql, id!)).toBe("QUEUED");
    });
  });

  test("--retry: every id skipped exits 1, retried plus skipped exits 4, each skip with its reason", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A"), "en/docs/b.md": EN("B") });
      const [a, b] = await jobIds(sql);

      const missing = await jobsCmd(sql, ["--retry", "999999"]);
      expect(missing.code).toBe(1);
      expect(missing.out).toContain("retried 0");
      expect(missing.out).toContain("skipped 999999: not found");
      expect(missing.err).toContain("error: ");

      const queued = await jobsCmd(sql, ["--retry", String(b)]);
      expect(queued.code).toBe(1);
      expect(queued.out).toContain(`skipped ${b}: not retryable (QUEUED)`);

      await sql`update ai_jobs set state = 'FAILED' where id = ${a!}`;
      const mixed = await jobsCmd(sql, ["--retry", `${a},${b},999999`, "--json"]);
      expect(mixed.code).toBe(4);
      expect(JSON.parse(mixed.out)).toMatchObject({
        ok: true, partial: true, data: { retried: 1, skipped: [{ id: b }, { id: 999999 }] },
      });
      expect(await stateOf(sql, a!)).toBe("QUEUED");
    });
  });

  test("205 jobs are all listed without --limit, and --limit 10 lists one page of 10", async () => {
    await withDb(async (sql) => {
      const [docId] = await seedJobs(sql, { "en/docs/a.md": EN("A") });
      await insertCancelled(sql, docId!, 205);
      const all = await jobsCmd(sql, ["--state", "cancelled"]);
      expect(all.out.split("\n").filter((l) => /\bCANCELLED\b/.test(l))).toHaveLength(205);
      const some = await jobsCmd(sql, ["--state", "cancelled", "--limit", "10"]);
      expect(some.out.split("\n").filter((l) => /\bCANCELLED\b/.test(l))).toHaveLength(10);
      // Identity, not just a count: --limit returns the FIRST page of the full listing, in the same order.
      const idsOf = async (args: string[]) =>
        (JSON.parse((await jobsCmd(sql, args)).out) as { data: { jobs: Array<{ id: number }> } }).data.jobs.map((j) => j.id);
      const allIds = await idsOf(["--state", "cancelled", "--json"]);
      expect(allIds).toHaveLength(205);
      expect(await idsOf(["--state", "cancelled", "--limit", "10", "--json"])).toEqual(allIds.slice(0, 10));
    });
  }, 30_000);

  test("more than one core page (1005 jobs) is read through afterId without a gap or a repeat", async () => {
    await withDb(async (sql) => {
      const [docId] = await seedJobs(sql, { "en/docs/a.md": EN("A") });
      await insertCancelled(sql, docId!, 1005);
      const r = await jobsCmd(sql, ["--state", "cancelled", "--json"]);
      const jobs = (JSON.parse(r.out) as { data: { jobs: Array<{ id: number }> } }).data.jobs;
      expect(jobs).toHaveLength(1005);
      expect(jobs.map((j) => j.id)).toEqual((await jobIds(sql)).filter((id) => jobs.some((j) => j.id === id)));
      expect(new Set(jobs.map((j) => j.id)).size).toBe(1005);
    });
  }, 30_000);

  test("a project without an ai export is a usage error naming the export", async () => {
    await withDb(async (sql) => {
      const t = testDeps(sql, { loadModule: async () => ({ config }) });
      expect(await run(["jobs"], t)).toBe(2);
      expect(t.stderr()).toContain("needs an `ai` export");
    });
  });
});
