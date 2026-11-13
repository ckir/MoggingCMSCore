import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { enqueueStale } from "@mogging/ai";
import type { WorkerReport } from "@mogging/ai";
import { defineCollection, defineConfig, migrate, richText, slug, text } from "@mogging/core";
import type { Sql } from "postgres";
import { workerLines } from "../src/commands/worker.js";
import { run } from "../src/run.js";
import type { Deps } from "../src/types.js";
import { withTestDb } from "./db.js";
import { aiConfigFor, config, ctxFor, docs, testDeps } from "./fixtures.js";
import type { TestDeps } from "./fixtures.js";
import { asyncMockModel, identity, mockModel } from "./mockModel.js";
import type { MockCallOptions } from "./mockModel.js";

type Model = Parameters<typeof aiConfigFor>[0];

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

/** Publishes the `en` files and queues their `de` (and `fr` when asked) jobs, as `compile` would, without running them. */
async function seedJobs(sql: Sql, files: Record<string, string>, locales = ["de"]): Promise<void> {
  expect(await run(["import", tree(files), "--publish"], testDeps(sql))).toBe(0);
  await enqueueStale(ctxFor(sql, mockModel([])), { locales });
}

function workerDeps(sql: Sql, model: Model, overrides: Partial<Deps> = {}): TestDeps {
  return testDeps(sql, { loadModule: async () => ({ config, ai: aiConfigFor(model) }), ...overrides });
}

async function workerCmd(sql: Sql, model: Model, args: string[], overrides: Partial<Deps> = {}) {
  const t = workerDeps(sql, model, overrides);
  const code = await run(["worker", ...args], t);
  return { code, out: t.stdout(), err: t.stderr() };
}

const states = async (sql: Sql) =>
  (await sql`select locale, state from ai_jobs order by id`) as unknown as Array<{ locale: string; state: string }>;

describe("mogging worker: usage errors before connecting", () => {
  const cases: Array<[string, string[]]> = [
    ["--poll-ms 0", ["--poll-ms", "0"]],
    ["--poll-ms abc", ["--poll-ms", "abc"]],
    ["--poll-ms 50", ["--poll-ms", "50"]],
    ["--poll-ms 2147483648", ["--poll-ms", "2147483648"]],
    ["--poll-ms 0x10", ["--poll-ms", "0x10"]],
    ["--budget 0", ["--budget", "0"]],
    ["--budget abc", ["--budget", "abc"]],
    ["--budget 1e2", ["--budget", "1e2"]],
    ["an empty locale entry", ["--locales", "de,"]],
  ];
  for (const [name, args] of cases) {
    test(`${name} exits 2 and never connects`, async () => {
      await withTestDb(async (sql) => {
        let connected = false;
        const r = await workerCmd(sql, mockModel([]), ["--once", ...args], {
          connect: () => { connected = true; throw new Error("connected"); },
        });
        expect(r.code).toBe(2);
        expect(r.err).not.toContain("unknown command");
        expect(connected).toBe(false);
        expect(r.out).toBe("");
      });
    });
  }
});

describe("mogging worker", () => {
  test("--once processes the queued jobs, one log line per job, exit 0", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A"), "en/docs/b.md": EN("B") });
      const model = mockModel([identity, identity]);
      const r = await workerCmd(sql, model, ["--once"]);
      expect(r.code).toBe(0);
      const logLines = r.out.split("\n").filter((l) => l.startsWith("job="));
      expect(logLines).toHaveLength(2);
      for (const l of logLines) {
        expect(l).toMatch(/^job=\d+ doc=\S+ locale=\S+ model=\S+ tokens=\d+\/\d+ cost_usd=[0-9.]+ outcome=\S+/);
        expect(l).toMatch(/outcome=COMPLETED$/);
      }
      expect(r.out).toContain("completed 2, failed 0, cancelled 0, discarded 0, requeued 0");
      expect(r.out).toContain("spent 0.000400 USD");
      expect((await states(sql)).map((j) => j.state)).toEqual(["COMPLETED", "COMPLETED"]);
      expect(model.doGenerateCalls).toHaveLength(2);
    });
  });

  test("--json prints the final WorkerReport as data; the job lines go to stderr", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const r = await workerCmd(sql, mockModel([identity]), ["--once", "--json"]);
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as { ok: boolean; data: Record<string, unknown> };
      expect(doc.ok).toBe(true);
      expect(Object.keys(doc.data).sort()).toEqual([
        "budgetRefusals", "cancelled", "completed", "discarded", "errors", "failed", "requeued", "runBudgetStop", "spentMicros",
      ]);
      expect(doc.data).toMatchObject({ completed: 1, spentMicros: 200 });
      expect(r.err).toMatch(/^job=\d+ doc=\S+ locale=de .* outcome=COMPLETED$/m);
    });
  });

  test("--collection and --locales limit what the run claims", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") }, ["de", "fr"]);
      const model = mockModel([identity]);
      const r = await workerCmd(sql, model, ["--once", "--collection", "docs", "--locales", "de"]);
      expect(r.code).toBe(0);
      expect(await states(sql)).toEqual([
        { locale: "de", state: "COMPLETED" },
        { locale: "fr", state: "QUEUED" },
      ]);
      expect(model.doGenerateCalls).toHaveLength(1);
    });
  });

  test("--budget is the run budget: a job estimated above it is not claimed", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const model = mockModel([identity]);
      const r = await workerCmd(sql, model, ["--once", "--budget", "0.000001", "--json"]);
      expect(r.code).toBe(0);
      expect((JSON.parse(r.out) as { data: { runBudgetStop: boolean } }).data.runBudgetStop).toBe(true);
      expect(model.doGenerateCalls).toHaveLength(0);
      expect((await states(sql)).map((j) => j.state)).toEqual(["QUEUED"]);
    });
  });

  test("a run stopped by --budget says so in the human output; an idle run says it was not", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const stopped = await workerCmd(sql, mockModel([identity]), ["--once", "--budget", "0.000001"]);
      expect(stopped.code).toBe(0);
      expect(stopped.out).toContain("budgetRefusals 0, runBudgetStop yes");
      await sql`delete from ai_jobs`;
      const idle = await workerCmd(sql, mockModel([identity]), ["--once"]);
      expect(idle.out).toContain("budgetRefusals 0, runBudgetStop no");
    });
  });

  test("a monthly-cap refusal is shown as budgetRefusals", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const t = workerDeps(sql, mockModel([identity]));
      t.loadModule = async () => ({ config, ai: aiConfigFor(mockModel([identity]), { budgets: { monthlyCapUsd: 0 } }) });
      expect(await run(["worker", "--once"], t)).toBe(0);
      expect(t.stdout()).toContain("budgetRefusals 1, runBudgetStop no");
    });
  });

  test("an errors outcome is visible on exit 4: one job completes, one fails to load", async () => {
    await withDb(async (sql) => {
      const posts = defineCollection("posts", {
        slug: slug(),
        title: text({ localized: true }),
        body: richText({ localized: true, body: true }),
      });
      const locales = { source: "en", chains: { de: ["en"], fr: ["en"] } };
      const both = defineConfig({ collections: [docs, posts], locales });
      const onlyPosts = defineConfig({ collections: [posts], locales });
      const files = { "en/docs/a.md": EN("A"), "en/posts/p.md": EN("P") };
      const seeding = testDeps(sql, { loadModule: async () => ({ config: both, ai: aiConfigFor(mockModel([])) }) });
      expect(await run(["import", tree(files), "--publish"], seeding)).toBe(0);
      await enqueueStale({ ...ctxFor(sql, mockModel([])), config: both }, { locales: ["de"] });
      expect(await states(sql)).toHaveLength(2);

      // The run's config no longer declares `docs`, so that job fails to load (an `errors` outcome, then back to the queue).
      const t = testDeps(sql, { loadModule: async () => ({ config: onlyPosts, ai: aiConfigFor(mockModel([identity])) }) });
      expect(await run(["worker", "--once"], t)).toBe(4);
      expect(t.stdout()).toContain("completed 1, failed 0, cancelled 0, discarded 0, requeued 1, errors 1");
      expect(t.stdout()).toMatch(/^job=\d+ error=Unknown collection "docs"$/m);
    });
  });

  test("workerLines prints every counter of the report, including errors, budgetRefusals and runBudgetStop", () => {
    const report: WorkerReport = {
      completed: 1, failed: 2, cancelled: 3, discarded: 4, requeued: 5, errors: 6, budgetRefusals: 7, runBudgetStop: true,
      spentMicros: 1_500_000,
    };
    expect(workerLines(report)).toEqual([
      "completed 1, failed 2, cancelled 3, discarded 4, requeued 5, errors 6",
      "spent 1.500000 USD",
      "budgetRefusals 7, runBudgetStop yes",
    ]);
  });

  test("a provider error requeues the job and the run exits 1", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const r = await workerCmd(sql, mockModel([new Error("provider down")]), ["--once"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("requeued 1");
      expect(r.err).toContain("error: ");
    });
  });

  test("polling with an already-aborted signal returns promptly with exit 0 and a final report", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const model = mockModel([identity]);
      const r = await workerCmd(sql, model, ["--poll-ms", "2147483647"], { signal: AbortSignal.abort() });
      expect(r.code).toBe(0);
      expect(r.out).toContain("completed 0, failed 0, cancelled 0, discarded 0, requeued 0");
      expect(model.doGenerateCalls).toHaveLength(0);
      expect((await states(sql)).map((j) => j.state)).toEqual(["QUEUED"]);
    });
  }, 10_000);

  test("polling ends when the signal is aborted after the first job, while it sleeps between polls", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const stop = new AbortController();
      const t = workerDeps(sql, mockModel([identity]), { signal: stop.signal });
      const write = t.io.out;
      // The job's completion line is the observable end of the first poll; the abort comes later, with the worker asleep.
      t.io.out = (s) => {
        write(s);
        if (s.includes("outcome=COMPLETED")) setTimeout(() => stop.abort(), 300);
      };
      const started = Date.now();
      // A two-billion-millisecond poll: only the abort can end this run within the test timeout.
      const code = await run(["worker", "--poll-ms", "2147483647"], t);
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(t.stdout()).toContain("completed 1, failed 0, cancelled 0, discarded 0, requeued 0");
    });
  }, 15_000);

  test("holds SIGINT and SIGTERM listeners for the run only (the probe sees listeners while the call runs)", async () => {
    await withDb(async (sql) => {
      await seedJobs(sql, { "en/docs/a.md": EN("A") });
      const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
      const during: Array<{ int: number; term: number }> = [];
      const model = asyncMockModel([async (o: MockCallOptions) => {
        during.push({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") });
        return identity(o);
      }]);
      const r = await workerCmd(sql, model, ["--once"]);
      expect(r.code).toBe(0);
      expect(during).toEqual([{ int: before.int + 1, term: before.term + 1 }]);
      expect({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") }).toEqual(before);
    });
  });

  test("a project without an ai export is a usage error naming the export", async () => {
    await withDb(async (sql) => {
      const t = testDeps(sql, { loadModule: async () => ({ config }) });
      expect(await run(["worker", "--once"], t)).toBe(2);
      expect(t.stderr()).toContain("needs an `ai` export");
    });
  });
});
