import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cancelJobs } from "@mogging/ai";
import { migrate } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import type { Deps } from "../src/types.js";
import { withTestDb } from "./db.js";
import { aiConfigFor, config, ctxFor, testDeps } from "./fixtures.js";
import { asyncMockModel, identity, mockModel } from "./mockModel.js";
import type { MockCallOptions } from "./mockModel.js";

type Model = Parameters<typeof aiConfigFor>[0];
type AiOverrides = Parameters<typeof aiConfigFor>[1];

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

/** Imports and publishes the `en` files; the ai export of this run is irrelevant (import does not translate). */
async function seed(sql: Sql, files: Record<string, string>): Promise<void> {
  const t = testDeps(sql);
  expect(await run(["import", tree(files), "--publish"], t)).toBe(0);
}

async function compileCmd(
  sql: Sql, model: Model, args: string[], aiOverrides?: AiOverrides, depsOverrides: Partial<Deps> = {},
) {
  const t = testDeps(sql, { loadModule: async () => ({ config, ai: aiConfigFor(model, aiOverrides) }), ...depsOverrides });
  const code = await run(["compile", ...args], t);
  return { code, out: t.stdout(), err: t.stderr() };
}

const states = async (sql: Sql) =>
  (await sql`select locale, state from ai_jobs order by id`) as unknown as Array<{ locale: string; state: string }>;

/** `deps.connect` that fails the test when it is reached. */
function neverConnect(): { overrides: Partial<Deps>; connected(): boolean } {
  let connected = false;
  return {
    overrides: { connect: () => { connected = true; throw new Error("connected"); } },
    connected: () => connected,
  };
}

describe("mogging compile: usage errors before connecting", () => {
  const cases: Array<[string, string[]]> = [
    ["no --budget", ["--locales", "de"]],
    ["no --locales", ["--budget", "1"]],
    ["--budget 0", ["--locales", "de", "--budget", "0"]],
    ["--budget abc", ["--locales", "de", "--budget", "abc"]],
    ["--budget 0x10", ["--locales", "de", "--budget", "0x10"]],
    ["--budget 1e2", ["--locales", "de", "--budget", "1e2"]],
    ["an empty locale entry", ["--locales", "de,,fr", "--budget", "1"]],
    ["targets in two collections", ["--locales", "de", "--budget", "1", "docs/intro", "blog/x"]],
    ["a target outside --collection", ["--locales", "de", "--budget", "1", "--collection", "posts", "docs/intro"]],
  ];
  for (const [name, args] of cases) {
    test(`${name} exits 2 and never connects`, async () => {
      await withTestDb(async (sql) => {
        const guard = neverConnect();
        const r = await compileCmd(sql, mockModel([]), args, undefined, guard.overrides);
        expect(r.code).toBe(2);
        expect(r.err).not.toContain("unknown command");
        expect(guard.connected()).toBe(false);
        expect(r.err).not.toContain("connected");
        expect(r.out).toBe("");
      });
    });
  }

  test("the share-one-collection message names the remedy", async () => {
    await withTestDb(async (sql) => {
      const r = await compileCmd(sql, mockModel([]), ["--locales", "de", "--budget", "1", "docs/intro", "blog/x"]);
      expect(r.err).toContain("compile targets must share one collection; run compile once per collection");
    });
  });
});

describe("mogging compile", () => {
  test("an imported and published en document gets a DRAFT_AI de head; lines, exit 0", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro") });
      const model = mockModel([identity]);
      const r = await compileCmd(sql, model, ["--locales", "de", "--budget", "1"]);
      expect(r.code).toBe(0);
      expect(r.out.split("\n")).toEqual([
        expect.stringMatching(/^job=\d+ doc=\S+ locale=de model=mock\/translate tokens=100\/50 cost_usd=0\.000200 outcome=COMPLETED$/),
        "enqueued 1, duplicates 0, skipped 0",
        "completed 1, failed 0, cancelled 0, discarded 0, requeued 0",
        "spent 0.000200 USD",
        "pendingJobs 0",
        "",
      ]);
      const heads = await sql`select state from document_localized where locale = 'de' and is_head_draft`;
      expect(heads.map((h) => h.state)).toEqual(["DRAFT_AI"]);
      expect(model.doGenerateCalls).toHaveLength(1);
    });
  });

  test("--json prints one document whose data is the compile result; job lines go to stderr", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro") });
      const r = await compileCmd(sql, mockModel([identity]), ["--locales", "de", "--budget", "1", "--json"]);
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as {
        ok: boolean; partial: boolean;
        data: { enqueue: { enqueued: number }; worker: { completed: number; spentMicros: number }; pendingJobs: number };
      };
      expect(doc.ok).toBe(true);
      expect(doc.partial).toBe(false);
      expect(Object.keys(doc.data).sort()).toEqual(["enqueue", "pendingJobs", "worker"]);
      expect(doc.data.enqueue.enqueued).toBe(1);
      expect(doc.data.worker).toMatchObject({ completed: 1, spentMicros: 200 });
      expect(doc.data.pendingJobs).toBe(0);
      expect(r.err).toMatch(/^job=\d+ doc=\S+ locale=de .* outcome=COMPLETED$/m);
    });
  });

  test("the monthly cap refusal leaves the job pending and exits 0", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro") });
      const model = mockModel([identity]);
      const r = await compileCmd(sql, model, ["--locales", "de", "--budget", "1"], { budgets: { monthlyCapUsd: 0 } });
      expect(r.code).toBe(0);
      expect(r.out).toContain("pendingJobs 1");
      expect(r.out).toContain("completed 0, failed 0, cancelled 0, discarded 0, requeued 0");
      expect(model.doGenerateCalls).toHaveLength(0);
    });
  });

  test("a model that returns an invalid payload twice fails the only job: exit 1", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro") });
      const r = await compileCmd(sql, mockModel([{ nope: 1 }, { nope: 1 }]), ["--locales", "de", "--budget", "1"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("completed 0, failed 1, cancelled 0, discarded 0, requeued 0");
      expect(r.err).toContain("error: ");
      expect((await states(sql)).map((j) => j.state)).toEqual(["FAILED"]);
    });
  });

  test("a model whose call throws requeues the job: exit 1", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro") });
      const r = await compileCmd(sql, mockModel([new Error("provider down")]), ["--locales", "de", "--budget", "1"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("requeued 1");
      expect(r.out).toContain("pendingJobs 1");
      expect((await states(sql)).map((j) => j.state)).toEqual(["QUEUED"]);
    });
  });

  test("a job cancelled during its own provider call is discarded: exit 1", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro") });
      const cancelCtx = ctxFor(sql, mockModel([]));
      const model = asyncMockModel([async (o: MockCallOptions) => {
        const [job] = await sql`select id from ai_jobs`;
        await cancelJobs(cancelCtx, { ids: [Number(job!.id)] });
        return identity(o);
      }]);
      const r = await compileCmd(sql, model, ["--locales", "de", "--budget", "1"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("completed 0, failed 0, cancelled 0, discarded 1, requeued 0");
      expect((await states(sql)).map((j) => j.state)).toEqual(["CANCELLED"]);
    });
  });

  test("one document completes and one fails: exit 4, and --json is partial", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/a.md": EN("A"), "en/docs/b.md": EN("B") });
      // The first call answers whichever job is claimed first; the next two (standard then strict) fail the other.
      const r = await compileCmd(sql, mockModel([identity, { nope: 1 }, { nope: 1 }]), ["--locales", "de", "--budget", "1", "--json"]);
      expect(r.code).toBe(4);
      const doc = JSON.parse(r.out) as { ok: boolean; partial: boolean; data: { worker: { completed: number; failed: number } } };
      expect(doc).toMatchObject({ ok: true, partial: true });
      expect(doc.data.worker).toMatchObject({ completed: 1, failed: 1 });
      expect((await states(sql)).map((j) => j.state).sort()).toEqual(["COMPLETED", "FAILED"]);
    });
  });

  test("a single <collection>/<slug> target compiles that document only", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro"), "en/docs/other.md": EN("Other") });
      const r = await compileCmd(sql, mockModel([identity]), ["--locales", "de", "--budget", "1", "docs/intro", "--json"]);
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as { data: { enqueue: { enqueued: number } } };
      expect(doc.data.enqueue.enqueued).toBe(1);
      expect(await states(sql)).toEqual([{ locale: "de", state: "COMPLETED" }]);
    });
  });

  test("--collection compiles every document of it, and a matching target is accepted", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro"), "en/docs/other.md": EN("Other") });
      const all = await compileCmd(sql, mockModel([identity, identity]), ["--locales", "de", "--budget", "1", "--collection", "docs"]);
      expect(all.code).toBe(0);
      expect(all.out).toContain("enqueued 2, duplicates 0, skipped 0");
      const again = await compileCmd(sql, mockModel([identity]), ["--locales", "fr", "--budget", "1", "--collection", "docs", "docs/intro"]);
      expect(again.code).toBe(0);
      expect(again.out).toContain("enqueued 1, duplicates 0, skipped 0");
    });
  });

  test("a target that does not exist is an error, not a silent empty compile", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro") });
      const r = await compileCmd(sql, mockModel([]), ["--locales", "de", "--budget", "1", "docs/nope"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("not found");
    });
  });

  test("registers no signal listener: SIGINT and SIGTERM counts are unchanged while the provider call runs", async () => {
    await withDb(async (sql) => {
      await seed(sql, { "en/docs/intro.md": EN("Intro") });
      const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
      const during: Array<{ int: number; term: number }> = [];
      const model = asyncMockModel([async (o: MockCallOptions) => {
        during.push({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") });
        return identity(o);
      }]);
      const r = await compileCmd(sql, model, ["--locales", "de", "--budget", "1"]);
      expect(r.code).toBe(0);
      expect(during).toEqual([before]);
    });
  });

  test("a project without an ai export is a usage error naming the export", async () => {
    await withDb(async (sql) => {
      const t = testDeps(sql, { loadModule: async () => ({ config }) });
      expect(await run(["compile", "--locales", "de", "--budget", "1"], t)).toBe(2);
      expect(t.stderr()).toContain("needs an `ai` export");
    });
  });
});
