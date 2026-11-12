import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { LanguageModel } from "ai";
import { NotFoundError, ValidationError, createDocument, deleteDocument, publish, saveDraft, type AiProvenanceInput } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import {
  claim, complete, fallbackFailure, reap, release, renewLease, type CallCost, type ClaimResult, type Completion,
} from "../src/claim.js";
import { cancelJobs, enqueueStale, type JobRow } from "../src/jobs.js";
import type { AiConfigInput, AiCtx } from "../src/config.js";
import { ctxFor, extraConnection, migrateAndSeed } from "./fixtures.js";
import { withTestDb } from "./db.js";

const model = {} as unknown as LanguageModel;

const sourceData = (title: string) => ({
  title, body: markdownToTree("# Hi\n\nHello `x` {name}\n"), legal: "Terms apply", tags: ["a", "b"], price: 5,
});

/** Migrates, seeds one published post and enqueues one job per locale (in that order). Returns the job ids. */
async function setup(
  sql: Sql, o: { locales?: string[]; overrides?: Partial<AiConfigInput> } = {},
): Promise<{ ctx: AiCtx; docId: string; ids: number[] }> {
  const docId = await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model, o.overrides ?? {});
  await enqueueStale(ctx, { locales: o.locales ?? ["de"] });
  const rows = await sql`select id from ai_jobs order by id`;
  return { ctx, docId, ids: rows.map((r) => Number(r.id)) };
}

/** A claim that must succeed. */
async function claimed(ctx: AiCtx, workerId = "w1", filter = {}): Promise<{ job: JobRow; lease: string }> {
  const r: ClaimResult = await claim(ctx, { workerId, filter });
  if (!("job" in r)) throw new Error(`expected a job, got ${JSON.stringify(r)}`);
  return r;
}

type JobState = {
  state: string; attempts: number; error_message: string | null; locked_by: string | null; locked_until: Date | null;
  /** run_after - updated_at in seconds: both set by the same transition statement from the DB clock. */
  backoff: number; lease_for: number | null; lease_live: boolean | null; run_after_due: boolean;
};

async function jobState(sql: Sql, id: number): Promise<JobState> {
  const [r] = await sql`select state, attempts, error_message, locked_by, locked_until,
      extract(epoch from run_after - updated_at)::float8 as backoff,
      extract(epoch from locked_until - updated_at)::float8 as lease_for,
      locked_until > clock_timestamp() as lease_live,
      run_after <= clock_timestamp() as run_after_due
    from ai_jobs where id = ${id}`;
  return r as unknown as JobState;
}

const expire = (sql: Sql, id: number) => sql`update ai_jobs set locked_until = now() - interval '1 second' where id = ${id}`;
const makeDue = (sql: Sql, id: number) => sql`update ai_jobs set run_after = clock_timestamp() - interval '1 second' where id = ${id}`;

async function spent(sql: Sql): Promise<number> {
  const [r] = await sql`select coalesce(sum(spent_micros), 0) as s from ai_budgets where scope = 'global'`;
  return Number(r!.s);
}

type Prov = {
  call_id: string | null; job_id: string | null; field_path: string | null; version: number | null; discarded: boolean;
  discard_reason: string | null; cost_micros: string; warnings: string[]; locale: string; prompt_version: string;
};
const provenance = async (sql: Sql): Promise<Prov[]> =>
  (await sql`select * from content_provenance order by id`) as unknown as Prov[];

const call = (costMicros: number, kept: boolean, promptVersion = "translate.v1"): CallCost => ({
  callId: randomUUID(), modelId: "mock/translate", promptVersion, promptTokens: 100, completionTokens: 50, costMicros, kept,
});

async function draft(sql: Sql, job: JobRow, calls: CallCost[], fields: Record<string, unknown> = { title: "Hallo" }): Promise<Completion> {
  const [r] = await sql`select source_hashes from ai_jobs where id = ${job.id}`;
  const all = r!.source_hashes as Record<string, string>;
  const kept = calls.filter((c) => c.kept).at(-1)!;
  const perField: AiProvenanceInput[] = Object.keys(fields).map((f) => ({
    fieldPath: f, modelId: kept.modelId, promptVersion: kept.promptVersion, promptTokens: kept.promptTokens,
    completionTokens: kept.completionTokens, costMicros: kept.costMicros, jobId: job.id, callId: kept.callId, warnings: ["w1"],
  }));
  const sourceHashes = Object.fromEntries(Object.keys(fields).filter((f) => Object.hasOwn(all, f)).map((f) => [f, all[f]!]));
  return { kind: "draft", fields, sourceHashes, calls, perField };
}

const estimateOf = async (sql: Sql, id: number): Promise<number> =>
  Number((await sql`select cost_estimate_micros from ai_jobs where id = ${id}`)[0]!.cost_estimate_micros);

/** Sets this month's global spent_micros (creating the row through a claim-free insert). */
async function setSpent(sql: Sql, micros: number): Promise<void> {
  await sql`insert into ai_budgets (scope, period_start, cap_micros, spent_micros)
    values ('global', date_trunc('month', clock_timestamp() at time zone 'UTC')::date, 0, ${micros})
    on conflict (scope, period_start) do update set spent_micros = excluded.spent_micros`;
}

// ---- reap ---------------------------------------------------------------------------------------------

test("reap requeues an expired lease with backoff and fails one at max_attempts", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql, { locales: ["de", "de-CH"] });
  const a = await claimed(ctx);
  const b = await claimed(ctx);
  expect([a.job.id, b.job.id]).toEqual(ids);
  // A live lease is left alone.
  expect(await reap(ctx)).toEqual({ requeued: 0, failed: 0 });
  await expire(sql, a.job.id);
  await expire(sql, b.job.id);
  await sql`update ai_jobs set attempts = max_attempts where id = ${b.job.id}`;

  expect(await reap(ctx)).toEqual({ requeued: 1, failed: 1 });
  const ra = await jobState(sql, a.job.id);
  expect(ra).toMatchObject({ state: "QUEUED", attempts: 1, error_message: "lease expired", locked_by: null, locked_until: null });
  expect(ra.backoff).toBeCloseTo(60, 1); // 30 s * 2^1
  expect(await jobState(sql, b.job.id)).toMatchObject({
    state: "FAILED", attempts: 3, error_message: "lease expired after 3 attempts", locked_by: null, locked_until: null,
  });
  expect(await reap(ctx)).toEqual({ requeued: 0, failed: 0 });
}));

// ---- claim --------------------------------------------------------------------------------------------

test("claim takes the oldest runnable job, sets RUNNING, a per-claim lease token and attempts", async () => withTestDb(async (sql) => {
  const { ctx, docId, ids } = await setup(sql, { locales: ["de", "de-CH"] });
  // The second job becomes the oldest by run_after.
  await sql`update ai_jobs set run_after = clock_timestamp() - interval '1 hour' where id = ${ids[1]!}`;
  await sql`update ai_jobs set error_message = 'old' where id = ${ids[1]!}`;
  const { job, lease } = await claimed(ctx, "worker-a");
  expect(job.id).toBe(ids[1]);
  expect(lease).toMatch(/^worker-a#[0-9a-f]{8}$/);
  expect(job).toMatchObject({
    docId, collection: "posts", locale: "de-CH", state: "RUNNING", attempts: 1, lockedBy: lease, errorMessage: null,
  });
  const s = await jobState(sql, job.id);
  expect(s).toMatchObject({ state: "RUNNING", attempts: 1, locked_by: lease, error_message: null, lease_live: true });
  expect(s.lease_for).toBeCloseTo(300, 1);

  const second = await claimed(ctx, "worker-a");
  expect(second.job.id).toBe(ids[0]);
  expect(second.lease).not.toBe(lease);
  expect(await claim(ctx, { workerId: "worker-a", filter: {} })).toEqual({ refused: "empty" });
}));

test("claim skips a job whose run_after is in the future", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  await sql`update ai_jobs set run_after = clock_timestamp() + interval '1 hour' where id = ${ids[0]!}`;
  expect(await claim(ctx, { workerId: "w1", filter: {} })).toEqual({ refused: "empty" });
  expect((await jobState(sql, ids[0]!)).state).toBe("QUEUED");
}));

test("claim applies the filter, excludeIds and maxEstimateMicros", async () => withTestDb(async (sql) => {
  const { ctx, docId, ids } = await setup(sql, { locales: ["de", "de-CH"] });
  const e0 = await estimateOf(sql, ids[0]!);
  const none = { refused: "empty" };
  expect(await claim(ctx, { workerId: "w", filter: { collection: "docs" } })).toEqual(none);
  expect(await claim(ctx, { workerId: "w", filter: { docIds: [randomUUID()] } })).toEqual(none);
  expect(await claim(ctx, { workerId: "w", filter: { excludeIds: ids } })).toEqual(none);
  expect(await claim(ctx, { workerId: "w", filter: { maxEstimateMicros: e0 - 1, locales: ["de"] } })).toEqual(none);
  // Locales are normalized.
  const r = await claimed(ctx, "w", { collection: "posts", docIds: [docId], locales: ["DE-ch"], maxEstimateMicros: 1e9 });
  expect(r.job.id).toBe(ids[1]);
  const r2 = await claimed(ctx, "w", { maxEstimateMicros: e0 });
  expect(r2.job.id).toBe(ids[0]);
}));

test("claim moves to the next candidate when the first is taken between the select and the lock", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql, { locales: ["de", "de-CH"] });
  const extra = await extraConnection(sql);
  try {
    const r = await extra.begin(async (tx) => {
      await tx`select id from ai_jobs where id = ${ids[0]!} for update`;
      return claim(ctx, { workerId: "w1", filter: {} });
    });
    expect("job" in r && r.job.id).toBe(ids[1]);
    expect((await jobState(sql, ids[0]!)).state).toBe("QUEUED");
  } finally {
    await extra.end();
  }
}));

test("claim gives up after 10 candidates", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql, { locales: ["de", "de-CH"] });
  for (let i = 0; i < 5; i++) {
    const { id } = await createDocument(ctx, { collection: "posts" });
    await saveDraft(ctx, { docId: id, locale: "en", data: sourceData(`Hello ${i}`) });
    await publish(ctx, { docId: id, locale: "en" });
  }
  await enqueueStale(ctx, { locales: ["de", "de-CH"] });
  const ids = (await sql`select id from ai_jobs order by id`).map((r) => Number(r.id));
  expect(ids).toHaveLength(12);
  await sql`update ai_jobs set run_after = clock_timestamp() - make_interval(secs => 1000 - id)`;
  const extra = await extraConnection(sql);
  try {
    const first10 = ids.slice(0, 10);
    const r = await extra.begin(async (tx) => {
      await tx`select id from ai_jobs where id = any(${first10.map(String)}::bigint[]) for update`;
      return claim(ctx, { workerId: "w1", filter: {} });
    });
    expect(r).toEqual({ refused: "empty" });
    // Eleven taken would reach the free ones: with only nine locked, the tenth candidate is free.
    const r2 = await extra.begin(async (tx) => {
      await tx`select id from ai_jobs where id = any(${ids.slice(0, 9).map(String)}::bigint[]) for update`;
      return claim(ctx, { workerId: "w1", filter: {} });
    });
    expect("job" in r2 && r2.job.id).toBe(ids[9]);
  } finally {
    await extra.end();
  }
}));

test("a cap of 0 refuses every job", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql, { locales: ["de", "de-CH"], overrides: { budgets: { monthlyCapUsd: 0 } } });
  const e0 = await estimateOf(sql, ids[0]!);
  const r = await claim(ctx, { workerId: "w1", filter: {} });
  expect(r).toEqual({
    refused: "budget", jobId: ids[0], reason: `budget_exhausted: global spent 0 + in-flight 0 + estimate ${e0} > cap 0`,
  });
  const r2 = await claim(ctx, { workerId: "w1", filter: { excludeIds: [ids[0]!] } });
  expect(r2).toMatchObject({ refused: "budget", jobId: ids[1] });
  for (const id of ids) expect(await jobState(sql, id)).toMatchObject({ state: "QUEUED", attempts: 0, locked_by: null });
}));

test("claim at the cap boundary", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql, { overrides: { budgets: { monthlyCapUsd: 0.01 } } });
  const id = ids[0]!;
  const est = await estimateOf(sql, id);
  expect(est).toBeGreaterThan(0);
  expect(est).toBeLessThan(10_000);

  // spent + 1 + estimate = cap + 1: refused.
  await setSpent(sql, 10_000 - est + 1);
  const r = await claim(ctx, { workerId: "w1", filter: {} });
  expect(r).toEqual({
    refused: "budget", jobId: id,
    reason: `budget_exhausted: global spent ${10_000 - est + 1} + in-flight 0 + estimate ${est} > cap 10000`,
  });
  const s = await jobState(sql, id);
  expect(s).toMatchObject({ state: "QUEUED", attempts: 0, locked_by: null, run_after_due: false });
  expect(s.error_message).toMatch(/^budget_exhausted:/);
  expect(s.backoff).toBeCloseTo(300, 1);
  expect(await claim(ctx, { workerId: "w1", filter: {} })).toEqual({ refused: "empty" }); // run_after moved

  // spent + estimate == cap: claims, and the claim clears error_message.
  await setSpent(sql, 10_000 - est);
  await makeDue(sql, id);
  const ok = await claimed(ctx);
  expect(ok.job).toMatchObject({ id, state: "RUNNING", errorMessage: null });
  expect((await jobState(sql, id)).error_message).toBeNull();
}));

test("a later claim after the budget is raised clears error_message", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql, { overrides: { budgets: { monthlyCapUsd: 0 } } });
  expect(await claim(ctx, { workerId: "w1", filter: {} })).toMatchObject({ refused: "budget" });
  await makeDue(sql, ids[0]!);
  const raised = ctxFor(sql, model, { budgets: { monthlyCapUsd: 1 } });
  const ok = await claimed(raised);
  expect(ok.job.errorMessage).toBeNull();
  expect(await jobState(sql, ids[0]!)).toMatchObject({ state: "RUNNING", error_message: null });
}));

test("in-flight estimates of live leases count against the cap, expired leases do not", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const probe = ctxFor(sql, model);
  await enqueueStale(probe, { locales: ["de", "de-CH"] });
  const ids = (await sql`select id from ai_jobs order by id`).map((r) => Number(r.id));
  const [e0, e1] = [await estimateOf(sql, ids[0]!), await estimateOf(sql, ids[1]!)];
  const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: (e0 + e1 - 1) / 1e6 } });
  void docId;

  const a = await claimed(ctx);
  expect(a.job.id).toBe(ids[0]);
  const r = await claim(ctx, { workerId: "w2", filter: {} });
  expect(r).toEqual({
    refused: "budget", jobId: ids[1],
    reason: `budget_exhausted: global spent 0 + in-flight ${e0} + estimate ${e1} > cap ${e0 + e1 - 1}`,
  });

  await expire(sql, a.job.id);
  await makeDue(sql, ids[1]!);
  const b = await claimed(ctx, "w2");
  expect(b.job.id).toBe(ids[1]);
}));

test("two claims on one connection each cannot take the same job", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql, { locales: ["de", "de-CH"] });
  const extra = await extraConnection(sql);
  try {
    const other: AiCtx = { ...ctx, sql: extra };
    const [r1, r2] = await Promise.all([claim(ctx, { workerId: "w1", filter: {} }), claim(other, { workerId: "w2", filter: {} })]);
    const got = [r1, r2].map((r) => ("job" in r ? r.job.id : null)).sort();
    expect(got).toEqual([...ids].sort());
    const [r3, r4] = await Promise.all([claim(ctx, { workerId: "w1", filter: {} }), claim(other, { workerId: "w2", filter: {} })]);
    expect([r3, r4]).toEqual([{ refused: "empty" }, { refused: "empty" }]);
  } finally {
    await extra.end();
  }
}));

test("two concurrent claims for a single job: one takes it, the other finds nothing", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  const extra = await extraConnection(sql);
  try {
    const other: AiCtx = { ...ctx, sql: extra };
    const rs = await Promise.all([claim(ctx, { workerId: "w1", filter: {} }), claim(other, { workerId: "w2", filter: {} })]);
    expect(rs.filter((r) => "job" in r).map((r) => "job" in r && r.job.id)).toEqual([ids[0]]);
    expect(rs.filter((r) => !("job" in r))).toEqual([{ refused: "empty" }]);
    expect((await jobState(sql, ids[0]!)).attempts).toBe(1);
  } finally {
    await extra.end();
  }
}));

// ---- release and renewLease ---------------------------------------------------------------------------

test("release puts an unstarted job back to QUEUED with backoff only while the fence holds, and FAILS it at max_attempts", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  const id = ids[0]!;
  let { lease } = await claimed(ctx);
  expect(await release(ctx, id, "w1#00000000", "load failed")).toBe(false);
  expect((await jobState(sql, id)).state).toBe("RUNNING");

  expect(await release(ctx, id, lease, "load failed")).toBe("QUEUED");
  let s = await jobState(sql, id);
  expect(s).toMatchObject({ state: "QUEUED", attempts: 1, error_message: "load failed", locked_by: null, locked_until: null });
  expect(s.backoff).toBeCloseTo(60, 1);
  expect(await release(ctx, id, lease, "load failed")).toBe(false); // no longer RUNNING

  await makeDue(sql, id);
  ({ lease } = await claimed(ctx));
  expect(await release(ctx, id, lease, "load failed")).toBe("QUEUED");
  s = await jobState(sql, id);
  expect(s.attempts).toBe(2);
  expect(s.backoff).toBeCloseTo(120, 1);

  await makeDue(sql, id);
  ({ lease } = await claimed(ctx));
  expect(await release(ctx, id, lease, "load failed")).toBe("FAILED");
  expect(await jobState(sql, id)).toMatchObject({
    state: "FAILED", attempts: 3, error_message: "load failed (after 3 attempts)", locked_by: null, locked_until: null,
  });
}));

test("renewLease extends locked_until only while the fence holds", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  const id = ids[0]!;
  const { lease } = await claimed(ctx);
  await sql`update ai_jobs set locked_until = clock_timestamp() + interval '10 seconds' where id = ${id}`;
  expect(await renewLease(ctx, id, lease)).toBe(true);
  const s = await jobState(sql, id);
  expect(s.lease_for).toBeCloseTo(300, 1);

  expect(await renewLease(ctx, id, "w1#00000000")).toBe(false);
  expect(await renewLease(ctx, id, `${lease}x`)).toBe(false);

  await expire(sql, id);
  expect(await renewLease(ctx, id, lease)).toBe(false);
  expect((await jobState(sql, id)).lease_live).toBe(false);
}));

// ---- complete -----------------------------------------------------------------------------------------

test("a lost lease writes only a discarded row and debits the budget", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const before = await spent(sql);
  await sql`update ai_jobs set locked_until = now() - interval '1 second' where id = ${job.id}`;
  const c = call(1234, true);
  expect(await complete(ctx, job, lease, await draft(sql, job, [c]))).toBe("DISCARDED");
  expect(await sql`select 1 from document_localized where locale = 'de'`).toHaveLength(0);
  const rows = await provenance(sql);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    discarded: true, discard_reason: "lease lost", cost_micros: "1234", call_id: c.callId, job_id: String(job.id), version: null,
    field_path: null,
  });
  expect(await spent(sql)).toBe(before + 1234);
  expect((await jobState(sql, job.id)).state).toBe("RUNNING");
}));

test("complete with a draft records DRAFT_AI, per-field provenance with job_id, call_id and warnings, and marks COMPLETED", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const before = await spent(sql);
  const c = call(900, true);
  const d = await draft(sql, job, [c], { title: "Hallo", legal: "Es gelten Bedingungen" });
  expect(await complete(ctx, job, lease, d)).toBe("COMPLETED");
  const [loc] = await sql`select state, data, is_head_draft, version from document_localized where doc_id = ${docId} and locale = 'de'`;
  expect(loc).toMatchObject({ state: "DRAFT_AI", is_head_draft: true, data: { title: "Hallo", legal: "Es gelten Bedingungen" } });
  const rows = await provenance(sql);
  expect(rows.map((r) => r.field_path)).toEqual(["title", "legal"]);
  for (const r of rows) {
    expect(r).toMatchObject({
      discarded: false, job_id: String(job.id), call_id: c.callId, warnings: ["w1"], version: loc!.version, locale: "de",
    });
  }
  expect(await spent(sql)).toBe(before + 900);
  expect(await jobState(sql, job.id)).toMatchObject({ state: "COMPLETED", error_message: null, locked_by: null, locked_until: null });
}));

test("a stale lease token from an earlier claim fails the fence", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const first = await claimed(ctx, "w1");
  await expire(sql, first.job.id);
  expect(await reap(ctx)).toEqual({ requeued: 1, failed: 0 });
  await makeDue(sql, first.job.id);
  const second = await claimed(ctx, "w1");
  expect(second.job.id).toBe(first.job.id);
  expect(second.lease).not.toBe(first.lease);

  const c = call(500, true);
  expect(await complete(ctx, first.job, first.lease, await draft(sql, first.job, [c]))).toBe("DISCARDED");
  expect(await sql`select 1 from document_localized where locale = 'de'`).toHaveLength(0);
  expect((await provenance(sql)).map((r) => r.discard_reason)).toEqual(["lease lost"]);
  const s = await jobState(sql, second.job.id);
  expect(s).toMatchObject({ state: "RUNNING", locked_by: second.lease, attempts: 2, lease_live: true });
}));

test("an unkept call gets a discarded row beside the kept call's field rows", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const before = await spent(sql);
  const c1 = call(300, false);
  const c2 = call(700, true, "translate.v1.strict");
  expect(await complete(ctx, job, lease, await draft(sql, job, [c1, c2], { title: "Hallo", legal: "AGB" }))).toBe("COMPLETED");
  const rows = await provenance(sql);
  const discarded = rows.filter((r) => r.discarded);
  expect(discarded).toHaveLength(1);
  expect(discarded[0]).toMatchObject({ call_id: c1.callId, cost_micros: "300", field_path: null, version: null });
  expect(discarded[0]!.discard_reason).toMatch(/^validation: /);
  const kept = rows.filter((r) => !r.discarded);
  expect(kept).toHaveLength(2);
  for (const r of kept) expect(r.call_id).toBe(c2.callId);
  expect(await spent(sql)).toBe(before + 1000);
}));

test("the fallback writes nothing when a row with one of the call ids already exists", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const c = call(400, true);
  // An undeclared field: recordAiDraft throws after the fence, inside complete's first transaction.
  const d = await draft(sql, job, [c], { title: "Hallo", nope: "x" });
  const extra = await extraConnection(sql);
  try {
    // An earlier commit of this very completion, as an ambiguous commit leaves it.
    await extra`insert into content_provenance (doc_id, locale, call_id, job_id, model_id, prompt_version, prompt_tokens,
        completion_tokens, cost_micros, discarded, discard_reason)
      values (${docId}, 'de', ${c.callId}, ${job.id}, 'mock/translate', 'translate.v1', 100, 50, 400, true, 'earlier')`;
  } finally {
    await extra.end();
  }
  const before = await spent(sql);
  await expect(complete(ctx, job, lease, d)).rejects.toBeInstanceOf(ValidationError);
  const rows = await provenance(sql);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.discard_reason).toBe("earlier");
  expect(await spent(sql)).toBe(before);
  expect((await jobState(sql, job.id)).state).toBe("RUNNING");
}));

test("a concurrent cancel makes the fence fail and the calls become lease-lost rows", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const extra = await extraConnection(sql);
  try {
    expect(await cancelJobs({ ...ctx, sql: extra, actor: "op" }, { ids: [job.id] })).toEqual({ cancelled: 1 });
  } finally {
    await extra.end();
  }
  const before = await spent(sql);
  const c1 = call(100, false);
  const c2 = call(200, true);
  expect(await complete(ctx, job, lease, await draft(sql, job, [c1, c2]))).toBe("DISCARDED");
  const rows = await provenance(sql);
  expect(rows.map((r) => [r.call_id, r.discard_reason, r.discarded])).toEqual([
    [c1.callId, "lease lost", true], [c2.callId, "lease lost", true],
  ]);
  expect(rows.some((r) => r.discard_reason?.startsWith("commit_failed:"))).toBe(false);
  expect(await spent(sql)).toBe(before + 300);
  expect(await jobState(sql, job.id)).toMatchObject({ state: "CANCELLED", error_message: "cancelled by op" });
  expect(await sql`select 1 from document_localized where locale = 'de'`).toHaveLength(0);
}));

test("the fallback records the spend when the first transaction fails after the fence", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const extra = await extraConnection(sql);
  try {
    await deleteDocument({ ...ctx, sql: extra }, { docId });
  } finally {
    await extra.end();
  }
  const before = await spent(sql);
  const c1 = call(150, false);
  const c2 = call(250, true);
  const err = await complete(ctx, job, lease, await draft(sql, job, [c1, c2])).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NotFoundError);
  const rows = await provenance(sql);
  // One row per call, all commit_failed (the first transaction's validation row was rolled back).
  expect(rows.map((r) => r.call_id)).toEqual([c1.callId, c2.callId]);
  for (const r of rows) {
    expect(r).toMatchObject({ discarded: true, job_id: String(job.id), version: null, field_path: null });
    expect(r.discard_reason).toBe(`commit_failed: ${(err as Error).message}`);
  }
  expect(await spent(sql)).toBe(before + 400);
  expect(await jobState(sql, job.id)).toMatchObject({ state: "RUNNING", locked_by: lease });
}));

test("complete with kind failed and no calls writes no provenance and no debit, and marks FAILED with the reason", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const before = await spent(sql);
  expect(await complete(ctx, job, lease, { kind: "failed", reason: "field body is too large", calls: [] })).toBe("FAILED");
  expect(await provenance(sql)).toHaveLength(0);
  expect(await spent(sql)).toBe(before);
  expect(await jobState(sql, job.id)).toMatchObject({
    state: "FAILED", error_message: "field body is too large", locked_by: null, locked_until: null,
  });
}));

test("complete with kind cancel marks CANCELLED with the code and writes nothing", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const before = await spent(sql);
  expect(await complete(ctx, job, lease, { kind: "cancel", code: "DRAFT_HUMAN", calls: [] })).toBe("CANCELLED");
  expect(await provenance(sql)).toHaveLength(0);
  expect(await spent(sql)).toBe(before);
  expect(await jobState(sql, job.id)).toMatchObject({ state: "CANCELLED", error_message: "DRAFT_HUMAN" });
}));

test("a split job that fails on its second request records the first request's call as discarded", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const before = await spent(sql);
  const first = call(100, true);            // request 1: accepted
  const second = call(200, false);          // request 2, standard: rejected
  const strict = call(300, false, "translate.v1.strict"); // request 2, strict: rejected again
  expect(await complete(ctx, job, lease, { kind: "failed", reason: "sentinel missing", calls: [first, second, strict] })).toBe("FAILED");
  const rows = await provenance(sql);
  expect(rows.map((r) => r.call_id)).toEqual([first.callId, second.callId, strict.callId]);
  expect(rows.every((r) => r.discarded && r.version === null && r.field_path === null)).toBe(true);
  expect(rows[0]!.discard_reason).toMatch(/^validation: /);
  expect(rows[1]!.discard_reason).toBe("validation: retried with strict");
  expect(rows[2]!.discard_reason).toBe("validation: sentinel missing");
  expect(await spent(sql)).toBe(before + 600);
  expect(await sql`select 1 from document_localized where locale = 'de'`).toHaveLength(0);
}));

test("complete with empty calls creates no ai_budgets row", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  await sql`delete from ai_budgets`;
  expect(await complete(ctx, job, lease, { kind: "cancel", code: "SOURCE_MOVED", calls: [] })).toBe("CANCELLED");
  expect(await sql`select 1 from ai_budgets`).toHaveLength(0);
}));

test("complete after the source moved marks CANCELLED and debits", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const d = await draft(sql, job, [call(800, true)]);
  await saveDraft(ctx, { docId, locale: "en", data: sourceData("Hello again") });
  await publish(ctx, { docId, locale: "en" });
  const before = await spent(sql);
  expect(await complete(ctx, job, lease, d)).toBe("CANCELLED");
  const rows = await provenance(sql);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ discarded: true, discard_reason: "cancelled: SOURCE_MOVED", cost_micros: "800" });
  expect(await spent(sql)).toBe(before + 800);
  expect(await jobState(sql, job.id)).toMatchObject({ state: "CANCELLED", error_message: "SOURCE_MOVED" });
  expect(await sql`select 1 from document_localized where locale = 'de'`).toHaveLength(0);
}));

test("complete with kind failed marks FAILED with the reason and writes discarded rows", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const before = await spent(sql);
  const c1 = call(100, false);
  const c2 = call(200, false, "translate.v1.strict");
  expect(await complete(ctx, job, lease, { kind: "failed", reason: "title: placeholder {name} missing", calls: [c1, c2] })).toBe("FAILED");
  expect((await provenance(sql)).map((r) => [r.call_id, r.discarded, r.discard_reason, r.prompt_version])).toEqual([
    [c1.callId, true, "validation: retried with strict", "translate.v1"],
    [c2.callId, true, "validation: title: placeholder {name} missing", "translate.v1.strict"],
  ]);
  expect(await spent(sql)).toBe(before + 300);
  expect(await jobState(sql, job.id)).toMatchObject({ state: "FAILED", error_message: "title: placeholder {name} missing" });
}));

test("complete with kind retry backs off, then FAILS at max_attempts", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const before = await spent(sql);
  const results: string[] = [];
  const backoffs: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const { job, lease } = await claimed(ctx);
    results.push(await complete(ctx, job, lease, { kind: "retry", reason: "HTTP 503", calls: [call(10, false)] }));
    const s = await jobState(sql, job.id);
    expect(s.attempts).toBe(i);
    if (s.state === "QUEUED") {
      backoffs.push(Math.round(s.backoff));
      expect(s).toMatchObject({ error_message: "HTTP 503", locked_by: null, locked_until: null, run_after_due: false });
      await makeDue(sql, job.id);
    } else {
      expect(s).toMatchObject({ state: "FAILED", error_message: "HTTP 503 (after 3 attempts)", locked_by: null });
    }
  }
  expect(results).toEqual(["QUEUED", "QUEUED", "FAILED"]);
  expect(backoffs).toEqual([60, 120]);
  const rows = await provenance(sql);
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.discarded && r.discard_reason === "provider: HTTP 503")).toBe(true);
  expect(await spent(sql)).toBe(before + 30);
}));

test("a throwing completion still records the spend", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const before = await spent(sql);
  const c1 = call(120, false);
  const c2 = call(380, true);
  // An undeclared field: recordAiDraft throws ValidationError after the fence, inside the first transaction.
  const d = await draft(sql, job, [c1, c2], { title: "Hallo", nope: "x" });
  const err = await complete(ctx, job, lease, d).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).toMatch(/undeclared field/);
  const rows = await provenance(sql);
  // One commit_failed row per call; the first transaction's `validation:` row for c1 was rolled back.
  expect(rows.map((r) => r.call_id)).toEqual([c1.callId, c2.callId]);
  for (const r of rows) {
    expect(r).toMatchObject({ discarded: true, job_id: String(job.id), version: null, field_path: null });
    expect(r.discard_reason).toBe(`commit_failed: ${(err as Error).message}`);
  }
  expect(await spent(sql)).toBe(before + 500);
  expect(await jobState(sql, job.id)).toMatchObject({ state: "RUNNING", locked_by: lease });
  expect(await sql`select 1 from document_localized where locale = 'de'`).toHaveLength(0);
}));

test("a failing fallback rethrows the original error with the fallback failure and the lost call ids attached", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  const { job, lease } = await claimed(ctx);
  const before = await spent(sql);
  const c1 = call(120, false);
  const c2 = call(380, true);
  // An undeclared field makes the first transaction throw; every later transaction (the fallback) fails to start.
  const d = await draft(sql, job, [c1, c2], { title: "Hallo", nope: "x" });
  let begins = 0;
  const down = new Error("fallback down");
  const flaky = new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop !== "begin") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => (begins++ === 0
        ? (target.begin as (...a: unknown[]) => Promise<unknown>)(...args)
        : Promise.reject(down));
    },
  });
  const err = await complete({ ...ctx, sql: flaky }, job, lease, d).catch((e: unknown) => e);
  expect(begins).toBe(2);
  expect(err).toBeInstanceOf(ValidationError); // the ORIGINAL error, class kept
  expect((err as Error).message).toMatch(/undeclared field/);
  expect(fallbackFailure(err)).toEqual({ error: down, message: "fallback down", callIds: [c1.callId, c2.callId] });
  expect(Object.keys(err as object)).not.toContain("fallbackError"); // non-enumerable
  expect(await provenance(sql)).toEqual([]);
  expect(await spent(sql)).toBe(before);
  expect(fallbackFailure(new Error("plain"))).toBeUndefined();
}));

// ---- per-collection scope -----------------------------------------------------------------------------

test("a collection cap below the global cap refuses a job the global cap would allow", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  await enqueueStale(ctxFor(sql, model), { locales: ["de"] });
  const id = Number((await sql`select id from ai_jobs`)[0]!.id);
  const est = await estimateOf(sql, id);
  const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: 1, collections: { posts: (est - 1) / 1e6 } } });
  expect(await claim(ctx, { workerId: "w1", filter: {} })).toEqual({
    refused: "budget", jobId: id,
    reason: `budget_exhausted: collection:posts spent 0 + in-flight 0 + estimate ${est} > cap ${est - 1}`,
  });
  expect(await jobState(sql, id)).toMatchObject({ state: "QUEUED", attempts: 0 });
}));

test("complete debits both the global and the collection scope, in the fallback too", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql, {
    locales: ["de", "de-CH"], overrides: { budgets: { monthlyCapUsd: 1, collections: { posts: 0.5 } } },
  });
  const a = await claimed(ctx);
  const b = await claimed(ctx);
  const scoped = async () => Object.fromEntries((await sql`select scope, spent_micros from ai_budgets order by scope`)
    .map((r) => [r.scope as string, Number(r.spent_micros)]));
  expect(await scoped()).toEqual({ "collection:posts": 0, global: 0 });
  const calls = [call(300, false), call(400, false)];
  expect(await complete(ctx, a.job, a.lease, { kind: "failed", reason: "bad", calls })).toBe("FAILED");
  expect(await scoped()).toEqual({ "collection:posts": 700, global: 700 });
  // The cost-only fallback (an undeclared field makes the first transaction throw) debits both scopes as well.
  const d = await draft(sql, b.job, [call(50, true)], { title: "Hallo", nope: "x" });
  await expect(complete(ctx, b.job, b.lease, d)).rejects.toBeInstanceOf(ValidationError);
  expect(await scoped()).toEqual({ "collection:posts": 750, global: 750 });
}));
