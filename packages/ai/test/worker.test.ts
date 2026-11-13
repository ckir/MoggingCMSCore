import { expect, test, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { hostname } from "node:os";
import type { Sql } from "postgres";
import {
  LicenceError, ValidationError, createDocument, deleteDocument, publish, saveDraft, type Ctx,
} from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { runWorker, type WorkerOptions, type WorkerReport } from "../src/worker.js";
import { claim } from "../src/claim.js";
import { cancelJobs, enqueueStale } from "../src/jobs.js";
import type { AiCtx } from "../src/config.js";
import { config, ctxFor, extraConnection, migrateAndSeed } from "./fixtures.js";
import { asyncMockModel, identity, mockModel, type MockCallOptions } from "./mockModel.js";
import { withTestDb } from "./db.js";

// Cost of one mock call: 100 input tokens at $1/Mtok + 50 output tokens at $2/Mtok = 200 micro-dollars.
const CALL_MICROS = 100 * 1 + 50 * 2;

type JobState = { id: number; doc_id: string; state: string; attempts: number; error_message: string | null; run_after_future: boolean };

async function jobs(sql: Sql): Promise<JobState[]> {
  const rows = await sql`select id, doc_id, state, attempts, error_message, run_after > clock_timestamp() as run_after_future
    from ai_jobs order by id`;
  return rows.map((r) => ({ ...(r as unknown as JobState), id: Number(r.id) }));
}

type Prov = {
  job_id: string | null; call_id: string | null; field_path: string | null; model_id: string; prompt_version: string;
  prompt_tokens: number; completion_tokens: number; cost_micros: string; discarded: boolean; discard_reason: string | null;
};
const provenance = async (sql: Sql): Promise<Prov[]> => (await sql`select * from content_provenance order by id`) as unknown as Prov[];

const spent = async (sql: Sql): Promise<number> =>
  Number((await sql`select coalesce(sum(spent_micros), 0) as s from ai_budgets where scope = 'global'`)[0]!.s);

const draftHead = async (sql: Sql, docId: string, locale = "de") =>
  (await sql`select state, data from document_localized where doc_id = ${docId} and locale = ${locale} and is_head_draft`)[0];

const report = (r: Partial<WorkerReport> = {}): WorkerReport => ({
  completed: 0, failed: 0, cancelled: 0, discarded: 0, requeued: 0, errors: 0, budgetRefusals: 0, runBudgetStop: false,
  spentMicros: 0, ...r,
});

const run = (ctx: AiCtx, o: Partial<WorkerOptions> = {}) => runWorker(ctx, { once: true, ...o });

/** A core ctx on another connection, as another writer would hold it. */
const other = (extra: Sql): Ctx => ({ sql: extra, config, actor: "other" });

async function publishNewSource(extra: Sql, docId: string): Promise<void> {
  await saveDraft(other(extra), { docId, locale: "en", data: { title: "Hello again" } });
  await publish(other(extra), { docId, locale: "en" });
}

/** A second published post (the seed is migrateAndSeed's). */
async function seedPost(sql: Sql, title: string, data?: Record<string, unknown>): Promise<string> {
  const ctx = { sql, config, actor: "seed" };
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, {
    docId: id, locale: "en", data: data ?? { title, body: markdownToTree("# Two\n\nSecond\n"), legal: "L", tags: ["c"], price: 1 },
  });
  await publish(ctx, { docId: id, locale: "en" });
  return id;
}

async function seedDocsPage(sql: Sql): Promise<string> {
  const ctx = { sql, config, actor: "seed" };
  const { id } = await createDocument(ctx, { collection: "docs" });
  await saveDraft(ctx, { docId: id, locale: "en", data: { body: markdownToTree("# Doc\n\nText\n"), summary: markdownToTree("Short\n") } });
  await publish(ctx, { docId: id, locale: "en" });
  return id;
}

const moveRunAfterBack = (extra: Sql) => extra`update ai_jobs set run_after = clock_timestamp() - interval '1 second'`;

/** Referenced timers alive in this process (setInterval/setTimeout that are not unref'd). */
const timeouts = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

// ---- outcomes --------------------------------------------------------------------------------------

test("a valid translation is recorded as DRAFT_AI with provenance per field and the job COMPLETED", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const model = mockModel([identity]);
  const ctx = ctxFor(sql, model);
  await enqueueStale(ctx, { locales: ["de"] });
  const lines: string[] = [];
  expect(await run(ctx, { log: (l) => lines.push(l) })).toEqual(report({ completed: 1, spentMicros: CALL_MICROS }));

  const head = (await sql`select state, data, source_hashes from document_localized
    where doc_id = ${docId} and locale = 'de' and is_head_draft`)[0];
  const source = (await sql`select data, source_hashes from document_localized
    where doc_id = ${docId} and locale = 'en' and is_head_published`)[0]!;
  expect(head!.state).toBe("DRAFT_AI");
  expect(head!.data.body).toEqual(source.data.body);
  // The draft records the source hashes it was translated from, so sync state sees it as current.
  const fields = Object.keys(head!.source_hashes as Record<string, string>).sort();
  expect(fields).toEqual(["body", "legal", "tags", "title"]);
  for (const f of fields) expect(head!.source_hashes[f]).toBe(source.source_hashes[f]);
  const [job] = await jobs(sql);
  expect(job!.state).toBe("COMPLETED");
  const prov = await provenance(sql);
  expect(prov).toHaveLength(4);
  const callId = prov[0]!.call_id;
  for (const p of prov) {
    expect(p).toMatchObject({
      job_id: String(job!.id), call_id: callId, model_id: "mock/translate", prompt_version: "translate.v1.standard", discarded: false,
    });
  }
  expect(prov.reduce((n, p) => n + p.prompt_tokens, 0)).toBe(100);
  expect(prov.reduce((n, p) => n + p.completion_tokens, 0)).toBe(50);
  expect(await spent(sql)).toBe(CALL_MICROS);
  expect(lines).toEqual([
    `job=${job!.id} doc=${docId} locale=de model=mock/translate tokens=100/50 cost_usd=0.000200 outcome=COMPLETED`,
  ]);
}));

test("runWorker rejects an unusable pollMs with a ValidationError", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);               // returns the seeded docId (a string), not a ctx
  const ctx = ctxFor(sql, mockModel([identity]));   // as the test at line 81 builds its ctx
  for (const pollMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    await expect(runWorker(ctx, { once: true, pollMs })).rejects.toBeInstanceOf(ValidationError);
  }
  await expect(runWorker(ctx, { once: true, pollMs: 1 })).resolves.toMatchObject({ completed: 0 });
}));

test("a rejected draft is retried with strict, then FAILED, and both calls are discarded rows", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const model = mockModel([{ nope: 1 }, { nope: 1 }]);
  const ctx = ctxFor(sql, model);
  await enqueueStale(ctx, { locales: ["de"] });
  expect(await run(ctx)).toEqual(report({ failed: 1, spentMicros: 2 * CALL_MICROS }));
  const prov = await provenance(sql);
  expect(prov).toHaveLength(2);
  for (const p of prov) {
    expect(p.discarded).toBe(true);
    expect(p.discard_reason).toMatch(/^validation:/);
  }
  expect(prov[1]!.prompt_version).toBe("translate.v1.strict");
  expect((await jobs(sql))[0]!.state).toBe("FAILED");
  expect(await draftHead(sql, docId)).toBeUndefined();
  expect(await spent(sql)).toBe(2 * CALL_MICROS);
}));

test("source moved: job is CANCELLED, cost is debited", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    const model = asyncMockModel([async (o: MockCallOptions) => {
      await publishNewSource(extra, docId);
      return identity(o);
    }]);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    expect(await run(ctx)).toEqual(report({ cancelled: 1, spentMicros: CALL_MICROS }));
    expect((await jobs(sql))[0]).toMatchObject({ state: "CANCELLED", error_message: "SOURCE_MOVED" });
    expect((await provenance(sql)).map((p) => [p.discarded, p.discard_reason])).toEqual([[true, "cancelled: SOURCE_MOVED"]]);
    expect(await draftHead(sql, docId)).toBeUndefined();
    expect(await spent(sql)).toBe(CALL_MICROS);
  } finally {
    await extra.end();
  }
}));

test("a human draft appearing mid-flight cancels", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    const model = asyncMockModel([async (o: MockCallOptions) => {
      await saveDraft(other(extra), { docId, locale: "de", data: { title: "Von Hand" } });
      return identity(o);
    }]);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    expect(await run(ctx)).toEqual(report({ cancelled: 1, spentMicros: CALL_MICROS }));
    expect((await jobs(sql))[0]).toMatchObject({ state: "CANCELLED", error_message: "DRAFT_HUMAN" });
    expect((await provenance(sql)).map((p) => [p.discarded, p.discard_reason])).toEqual([[true, "cancelled: DRAFT_HUMAN"]]);
    expect((await draftHead(sql, docId))!.state).toBe("DRAFT_HUMAN");
    expect(await spent(sql)).toBe(CALL_MICROS);
  } finally {
    await extra.end();
  }
}));

test("a source moved before the call cancels without spend", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    const model = mockModel([identity]);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const r = await run(ctx, { hooks: { afterClaim: () => publishNewSource(extra, docId) } });
    expect(r).toEqual(report({ cancelled: 1 }));
    expect((await jobs(sql))[0]).toMatchObject({ state: "CANCELLED", error_message: "SOURCE_MOVED" });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await provenance(sql)).toEqual([]);
    expect(await spent(sql)).toBe(0);
  } finally {
    await extra.end();
  }
}));

test("a job cancelled between claim and call is not paid", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    const model = mockModel([identity]);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const afterClaim = async (job: { id: number }) => {
      await cancelJobs({ ...ctx, sql: extra, actor: "other" }, { ids: [job.id] });
    };
    expect(await run(ctx, { hooks: { afterClaim } })).toEqual(report({ discarded: 1 }));
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await provenance(sql)).toEqual([]);
    expect((await jobs(sql))[0]).toMatchObject({ state: "CANCELLED", error_message: "cancelled by other" });
  } finally {
    await extra.end();
  }
}));

test("a provider error backs the job off and a later run completes it", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    const model = mockModel([new Error("provider down"), identity]);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    expect(await run(ctx)).toEqual(report({ requeued: 1 }));
    expect((await jobs(sql))[0]).toMatchObject({ state: "QUEUED", attempts: 1, error_message: "provider down", run_after_future: true });
    // The backoff holds the job back: a run now finds nothing.
    expect(await run(ctx)).toEqual(report());
    await moveRunAfterBack(extra);
    expect(await run(ctx)).toEqual(report({ completed: 1, spentMicros: CALL_MICROS }));
    expect((await jobs(sql))[0]).toMatchObject({ state: "COMPLETED", attempts: 2 });
    expect((await draftHead(sql, docId))!.state).toBe("DRAFT_AI");
  } finally {
    await extra.end();
  }
}));

test("the reaper runs before the claim and its counts stay out of the report", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const model = mockModel([identity]);
  const ctx = ctxFor(sql, model);
  await enqueueStale(ctx, { locales: ["de"] });
  // A dead worker's job: claimed, its lease expired.
  expect("job" in await claim(ctx, { workerId: "dead", filter: {} })).toBe(true);
  await sql`update ai_jobs set locked_until = clock_timestamp() - interval '1 second'`;
  expect(await run(ctx)).toEqual(report());
  expect((await jobs(sql))[0]).toMatchObject({ state: "QUEUED", attempts: 1, error_message: "lease expired", run_after_future: true });
  expect(model.doGenerateCalls).toHaveLength(0);
}));

test("a lease names the actor, host and process unless workerId is given", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const model = mockModel([identity, identity]);
  const ctx = ctxFor(sql, model);
  await enqueueStale(ctx, { locales: ["de"] });
  const leases: Array<string | null> = [];
  const afterClaim = async (job: { id: number; lockedBy: string | null }) => {
    leases.push(job.lockedBy);
    leases.push((await sql`select locked_by from ai_jobs where id = ${job.id}`)[0]!.locked_by as string);
  };
  expect(await run(ctx, { hooks: { afterClaim } })).toMatchObject({ completed: 1 });
  expect(ctx.actor).toBe("test");
  for (const l of leases) expect(l).toMatch(new RegExp(`^test@[^#]+#${process.pid}#[0-9a-f]{8}$`));
  expect(leases[0]!.split("#")[0]).toBe(`test@${hostname()}`);

  // An explicit workerId wins.
  await saveDraft(ctx, { docId: (await jobs(sql))[0]!.doc_id, locale: "en", data: { title: "Hello again" } });
  await publish(ctx, { docId: (await jobs(sql))[0]!.doc_id, locale: "en" });
  await enqueueStale(ctx, { locales: ["de"] });
  leases.length = 0;
  expect(await run(ctx, { workerId: "w9", hooks: { afterClaim } })).toMatchObject({ completed: 1 });
  expect(leases).toHaveLength(2);
  for (const l of leases) expect(l).toMatch(/^w9#[0-9a-f]{8}$/);
}));

// ---- budgets ---------------------------------------------------------------------------------------

test("the run budget stops the run before claiming", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const model = mockModel([identity]);
  const ctx = ctxFor(sql, model);
  await enqueueStale(ctx, { locales: ["de"] });
  const estimate = Number((await sql`select cost_estimate_micros from ai_jobs`)[0]!.cost_estimate_micros);
  expect(await run(ctx, { runBudgetMicros: estimate - 1 })).toEqual(report({ runBudgetStop: true }));
  expect((await jobs(sql))[0]).toMatchObject({ state: "QUEUED", attempts: 0, error_message: null });
  expect(model.doGenerateCalls).toHaveLength(0);
  // The control: a run budget equal to the estimate claims and completes it.
  expect(await run(ctx, { runBudgetMicros: estimate })).toEqual(report({ completed: 1, spentMicros: CALL_MICROS }));
}));

test("the run budget is cumulative: spend so far counts against the next claim", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  // The same source as the seed, so both jobs carry the same estimate.
  await seedPost(sql, "Hello", {
    title: "Hello", body: markdownToTree("# Hi\n\nHello `x` {name}\n"), legal: "Terms apply", tags: ["a", "b"], price: 5,
  });
  const model = mockModel([identity, identity]);
  const ctx = ctxFor(sql, model);
  await enqueueStale(ctx, { locales: ["de"] });
  const estimates = (await sql`select cost_estimate_micros from ai_jobs order by id`).map((r) => Number(r.cost_estimate_micros));
  expect(estimates).toHaveLength(2);
  expect(estimates[0]).toBe(estimates[1]);
  // Each job fits the run budget alone; after the first job's spend the second no longer does.
  const runBudgetMicros = estimates[0]! + CALL_MICROS / 2;
  expect(runBudgetMicros - CALL_MICROS).toBeLessThan(estimates[1]!);
  expect(await run(ctx, { runBudgetMicros })).toEqual(report({ completed: 1, runBudgetStop: true, spentMicros: CALL_MICROS }));
  const states = (await jobs(sql)).map((j) => [j.state, j.attempts, j.error_message]);
  expect(states.sort()).toEqual([["COMPLETED", 1, null], ["QUEUED", 0, null]]);
  expect(model.doGenerateCalls).toHaveLength(1);
}));

test("a monthly cap refusal is counted and the job keeps its reason", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const model = mockModel([identity]);
  const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: 0 } });
  await enqueueStale(ctx, { locales: ["de"] });
  expect(await run(ctx)).toEqual(report({ budgetRefusals: 1 }));
  const [job] = await jobs(sql);
  expect(job).toMatchObject({ state: "QUEUED", attempts: 0 });
  expect(job!.error_message).toMatch(/^budget_exhausted:/);
  expect(model.doGenerateCalls).toHaveLength(0);
}));

test("a budget refusal in one collection does not stop a job in another", async () => withTestDb(async (sql) => {
  const postId = await migrateAndSeed(sql);
  const pageId = await seedDocsPage(sql);
  const model = mockModel([identity, identity, identity]);
  const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: 1, collections: { posts: 0 } } });
  await enqueueStale(ctx, { locales: ["de"] });
  expect((await jobs(sql)).map((j) => j.doc_id).sort()).toEqual([postId, pageId].sort());
  const r = await run(ctx);
  expect(r).toMatchObject({ completed: 1, budgetRefusals: 1, errors: 0, runBudgetStop: false });
  const byDoc = Object.fromEntries((await jobs(sql)).map((j) => [j.doc_id, j]));
  expect(byDoc[postId]).toMatchObject({ state: "QUEUED", attempts: 0 });
  expect(byDoc[postId]!.error_message).toMatch(/^budget_exhausted: collection:posts/);
  expect(byDoc[pageId]!.state).toBe("COMPLETED");
}));

test("a long-running worker retries a budget-refused job after the cap is raised", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    const model = mockModel([identity]);
    const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: 0 } });
    await enqueueStale(ctx, { locales: ["de"] });
    const stop = new AbortController();
    let completedLine!: () => void;
    const completed = new Promise<void>((resolve) => { completedLine = resolve; });
    const running = runWorker(ctx, {
      once: false, pollMs: 50, signal: stop.signal,
      log: (l) => { if (l.endsWith("outcome=COMPLETED")) completedLine(); },
    });
    try {
      // Waits for a state change (the refusal), not for time to pass.
      await vi.waitFor(async () => {
        expect((await jobs(extra))[0]!.error_message).toMatch(/^budget_exhausted:/);
      }, { timeout: 10_000, interval: 20 });
      // The SAME config object the worker holds: lockBudgets re-upserts the cap from it.
      ctx.ai.budgets.monthlyCapUsd = 1;
      await moveRunAfterBack(extra);
      await completed;
    } finally {
      stop.abort();
    }
    const r = await running;
    expect(r).toMatchObject({ completed: 1, errors: 0, runBudgetStop: false, spentMicros: CALL_MICROS });
    expect(r.budgetRefusals).toBeGreaterThanOrEqual(1);
    expect((await jobs(sql))[0]!.state).toBe("COMPLETED");
  } finally {
    await extra.end();
  }
}));

// ---- the lease timer (the only tests that depend on elapsed time) ---------------------------------

test("the renewal timer is cleared before completion and the run ends", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    const lockedUntil = async (): Promise<Date> => (await extra`select locked_until from ai_jobs`)[0]!.locked_until as Date;
    const reads: Date[] = [];
    const model = asyncMockModel([async (o: MockCallOptions) => {
      reads.push(await lockedUntil()); // after the beforeCall renewal
      await delay(1500);               // the interval (3 s / 3 = 1 s) ticks once in here
      reads.push(await lockedUntil());
      return identity(o);
    }]);
    const ctx = ctxFor(sql, model, { leaseSeconds: 3, providerTimeoutSeconds: 2 });
    await enqueueStale(ctx, { locales: ["de"] });
    // Connect `extra` first: postgres.js arms a (referenced) connection-lifetime timer when a connection opens
    // (postgres@4.1.0 src/pool.js:580). Then let vitest's 100 ms reporter throttle, armed at test start, fire
    // (vitest dist/chunks/run.CjdgFZiW.js:3817): a harness timer expiring during the run would hide a leaked one.
    await extra`select 1`;
    await delay(250);
    // Held for longer than one interval after the call: a timer still running here (it must be cleared before
    // complete, and beforeComplete runs just before complete) would move locked_until.
    const held: Date[] = [];
    const beforeComplete = async () => {
      held.push(await lockedUntil());
      await delay(1200);
      held.push(await lockedUntil());
    };
    const before = timeouts();
    expect(await run(ctx, { hooks: { beforeComplete } })).toEqual(report({ completed: 1, spentMicros: CALL_MICROS }));
    expect(timeouts()).toBe(before);
    expect(reads).toHaveLength(2);
    expect(reads[1]!.getTime()).toBeGreaterThan(reads[0]!.getTime());
    expect(held).toHaveLength(2);
    expect(held[1]!.getTime()).toBe(held[0]!.getTime());
  } finally {
    await extra.end();
  }
}));

test("a lost lease during the call aborts it and the result is DISCARDED", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    let moved: Promise<unknown> = Promise.resolve();
    let abortedAfterMs: number | null = null;
    let reason: unknown;
    const model = asyncMockModel([async (o: MockCallOptions) => {
      const start = performance.now();
      // Well before the first renewal tick (1 s after the timer starts), on a connection opened beforehand.
      moved = delay(150).then(() => extra`update ai_jobs set locked_until = clock_timestamp() - interval '1 second'`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2500);
        o.abortSignal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (o.abortSignal?.aborted) {
        abortedAfterMs = performance.now() - start;
        reason = o.abortSignal.reason;
      }
      return identity(o); // resolves (with usage) either way, so the call is paid and must be recorded
    }]);
    // leaseSeconds must exceed providerTimeoutSeconds (defineAiConfig): 3 / 2. The abort reason, not the timing alone,
    // tells the lease abort (AbortError) from the provider timeout (TimeoutError).
    const ctx = ctxFor(sql, model, { leaseSeconds: 3, providerTimeoutSeconds: 2 });
    await enqueueStale(ctx, { locales: ["de"] });
    await extra`select 1`; // connected now, so the lease move does not pay for opening it
    const r = await run(ctx);
    await moved;
    expect(abortedAfterMs).not.toBeNull();
    expect((reason as Error).name).toBe("AbortError");
    expect(abortedAfterMs!).toBeLessThan(2000);
    expect(r).toEqual(report({ discarded: 1, spentMicros: CALL_MICROS }));
    expect((await provenance(sql)).map((p) => [p.discarded, p.discard_reason])).toEqual([[true, "lease lost"]]);
    expect(await draftHead(sql, docId)).toBeUndefined();
    expect(await spent(sql)).toBe(CALL_MICROS);
  } finally {
    await extra.end();
  }
}));

test("a provider call that hangs past providerTimeoutSeconds is aborted by the timeout and the job backs off", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  let aborted: boolean | null = null;
  let reason: unknown;
  const model = asyncMockModel([async (o: MockCallOptions) => {
    // Hangs for up to 5 s, or until the abort signal fires; the 1 s provider timeout is the only thing that can fire it.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      o.abortSignal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    aborted = o.abortSignal?.aborted ?? null;
    reason = o.abortSignal?.reason;
    throw reason instanceof Error ? reason : new Error("provider call hung and was not aborted");
  }]);
  // leaseSeconds must exceed providerTimeoutSeconds (defineAiConfig). The abort reason (TimeoutError, not the lease
  // path's AbortError) is the deterministic evidence that the timeout branch fired. Spend for the aborted call is a
  // documented known limit and is deliberately not asserted.
  const ctx = ctxFor(sql, model, { leaseSeconds: 3, providerTimeoutSeconds: 1 });
  await enqueueStale(ctx, { locales: ["de"] });
  const r = await run(ctx);
  expect(aborted).toBe(true);
  expect((reason as Error).name).toBe("TimeoutError");
  expect(r).toEqual(report({ requeued: 1 }));
  const [job] = await jobs(sql);
  expect(job).toMatchObject({ state: "QUEUED", attempts: 1, run_after_future: true });
  expect(job!.error_message).toEqual(expect.any(String));
  expect(job!.error_message).not.toBe("");
}));

// ---- failures before and after the call ------------------------------------------------------------

test("a missing API key fails the run before any claim", async () => withTestDb(async (sql) => {
  const VAR = "MOGGING_TEST_WORKER_UNSET_KEY_9B";
  expect(process.env[VAR]).toBeUndefined();
  await migrateAndSeed(sql);
  const model = mockModel([identity]);
  await enqueueStale(ctxFor(sql, model), { locales: ["de"] });
  const ctx = ctxFor(sql, model, { provider: { kind: "openrouter", apiKeyEnv: VAR } });
  await expect(run(ctx)).rejects.toBeInstanceOf(ValidationError);
  expect((await jobs(sql))[0]).toMatchObject({ state: "QUEUED", attempts: 0, error_message: null });
}));

test("a load error releases the job with backoff and counts an error", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    const model = mockModel([]);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    ctx.config.collections = ctx.config.collections.filter((c) => c.name !== "posts");
    expect(await run(ctx)).toEqual(report({ errors: 1, requeued: 1 }));
    expect((await jobs(sql))[0]).toMatchObject({
      state: "QUEUED", attempts: 1, run_after_future: true, error_message: 'Unknown collection "posts"',
    });
    await moveRunAfterBack(extra);
    expect(await run(ctx)).toEqual(report({ errors: 1, requeued: 1 }));
    expect((await jobs(sql))[0]).toMatchObject({ state: "QUEUED", attempts: 2 });
    await moveRunAfterBack(extra);
    expect(await run(ctx)).toEqual(report({ errors: 1, failed: 1 }));
    expect((await jobs(sql))[0]).toMatchObject({ state: "FAILED", attempts: 3 });
    expect(model.doGenerateCalls).toHaveLength(0);
  } finally {
    await extra.end();
  }
}));

test("a deleted document fails the job before any call", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const model = mockModel([identity]);
  const ctx = ctxFor(sql, model);
  await enqueueStale(ctx, { locales: ["de"] });
  await deleteDocument(ctx, { docId });
  expect(await run(ctx)).toEqual(report({ failed: 1 }));
  expect((await jobs(sql))[0]).toMatchObject({ state: "FAILED", error_message: "document deleted" });
  expect(model.doGenerateCalls).toHaveLength(0);
}));

test("a throwing completion is counted in errors and the run continues to the next job", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  await seedPost(sql, "Second");
  const extra = await extraConnection(sql);
  try {
    const model = mockModel([identity, identity]);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    expect(await jobs(sql)).toHaveLength(2);
    let first: { id: number; docId: string } | undefined;
    const beforeComplete = async (job: { id: number; docId: string }) => {
      if (first) return;
      first = job;
      await deleteDocument(other(extra), { docId: job.docId });
    };
    const lines: string[] = [];
    const r = await run(ctx, { hooks: { beforeComplete }, log: (l) => lines.push(l) });
    expect(r).toEqual(report({ errors: 1, completed: 1, spentMicros: 2 * CALL_MICROS }));
    const byId = Object.fromEntries((await jobs(sql)).map((j) => [j.id, j]));
    expect(byId[first!.id]!.state).toBe("RUNNING");
    const second = Object.values(byId).find((j) => j.id !== first!.id)!;
    expect(second.state).toBe("COMPLETED");
    const failedRows = (await provenance(sql)).filter((p) => p.job_id === String(first!.id));
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]).toMatchObject({ discarded: true, cost_micros: String(CALL_MICROS) });
    expect(failedRows[0]!.discard_reason).toMatch(/^commit_failed:/);
    expect(await spent(sql)).toBe(2 * CALL_MICROS);
    expect(lines.some((l) => l.startsWith(`job=${second.id} `) && l.endsWith("outcome=COMPLETED"))).toBe(true);
  } finally {
    await extra.end();
  }
}));

test("a completion whose fallback fails too logs fallback_failed with the lost call ids", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const extra = await extraConnection(sql);
  try {
    const model = mockModel([identity]);
    // After the call, the document is deleted (complete's first transaction throws) and the next transaction (the
    // cost-only fallback) fails to start; every other transaction runs normally.
    let armed = false;
    let begins = 0;
    const flaky = new Proxy(sql, {
      get(target, prop, receiver) {
        if (prop !== "begin") return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => (armed && begins++ === 1
          ? Promise.reject(new Error("fallback down"))
          : (target.begin as (...a: unknown[]) => Promise<unknown>)(...args));
      },
    });
    const ctx = ctxFor(flaky, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const beforeComplete = async (job: { docId: string }) => {
      await deleteDocument(other(extra), { docId: job.docId });
      armed = true;
    };
    const lines: string[] = [];
    const r = await run(ctx, { hooks: { beforeComplete }, log: (l) => lines.push(l) });
    expect(r).toEqual(report({ errors: 1, spentMicros: CALL_MICROS }));
    const [job] = await jobs(sql);
    expect(job!.state).toBe("RUNNING");
    expect(await provenance(sql)).toEqual([]); // the spend is recorded nowhere: the log line is the only trace
    const errorLine = lines.find((l) => l.startsWith(`job=${job!.id} error=`));
    expect(errorLine).toMatch(/ error=Document .* not found fallback_failed=fallback down calls=[0-9a-f-]{36}$/);
  } finally {
    await extra.end();
  }
}));

/** Ends the evaluation window (no key): the next guarded call throws LicenceError. Returns the restore function. */
async function expireLicence(extra: Sql): Promise<() => void> {
  const saved = process.env.MOGGING_LICENSE_KEY;
  delete process.env.MOGGING_LICENSE_KEY;
  await extra`update migrations set applied_at = now() - interval '31 days'`;
  return () => { if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved; };
}

test("a LicenceError while loading releases the job and stops the run", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  await seedPost(sql, "Second");
  const model = mockModel([identity, identity]);
  const ctx = ctxFor(sql, model);
  await enqueueStale(ctx, { locales: ["de"] });
  const afterClaim = async () => { throw new LicenceError("LICENCE_EXPIRED", "window ended"); };
  await expect(run(ctx, { hooks: { afterClaim } })).rejects.toBeInstanceOf(LicenceError);
  const states = (await jobs(sql)).map((j) => [j.state, j.attempts]);
  // The claimed job went back with back-off; the other one was never claimed.
  expect(states.sort()).toEqual([["QUEUED", 0], ["QUEUED", 1]]);
  expect(model.doGenerateCalls).toHaveLength(0);
}));

test("a LicenceError from complete stops the run before the next job", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  await seedPost(sql, "Second");
  const extra = await extraConnection(sql);
  let restore = () => {};
  try {
    const model = mockModel([identity, identity]);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const beforeComplete = async () => { restore = await expireLicence(extra); };
    await expect(run(ctx, { hooks: { beforeComplete } })).rejects.toBeInstanceOf(LicenceError);
    const states = (await jobs(sql)).map((j) => [j.state, j.attempts]);
    // recordAiDraft refused under the expired licence: that job stays RUNNING for the reaper, the next is untouched.
    expect(states.sort()).toEqual([["QUEUED", 0], ["RUNNING", 1]]);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect((await provenance(sql)).map((p) => p.discard_reason?.split(":")[0])).toEqual(["commit_failed"]);
  } finally {
    restore();
    await extra.end();
  }
}));

test("runWorker with an expired licence throws LicenceError", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const model = mockModel([identity]);
  const ctx = ctxFor(sql, model);
  await enqueueStale(ctx, { locales: ["de"] });
  const saved = process.env.MOGGING_LICENSE_KEY;
  delete process.env.MOGGING_LICENSE_KEY;
  try {
    await sql`update migrations set applied_at = now() - interval '31 days'`;
    await expect(run(ctx)).rejects.toBeInstanceOf(LicenceError);
    expect((await jobs(sql))[0]).toMatchObject({ state: "QUEUED", attempts: 0 });
    expect(model.doGenerateCalls).toHaveLength(0);
  } finally {
    if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
  }
}));
