import { expect, test } from "vitest";
import type { Sql } from "postgres";
import { LicenceError, ValidationError, createDocument, publish, saveDraft } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { compile } from "../src/compile.js";
import { enqueueStale } from "../src/jobs.js";
import { config, ctxFor, migrateAndSeed } from "./fixtures.js";
import { identity, mockModel } from "./mockModel.js";
import { withTestDb } from "./db.js";

type JobState = { doc_id: string; locale: string; state: string };
const jobStates = async (sql: Sql): Promise<JobState[]> =>
  (await sql`select doc_id, locale, state from ai_jobs order by id`) as unknown as JobState[];

/** A second published post (the seed is migrateAndSeed's). */
async function seedPost(sql: Sql): Promise<string> {
  const ctx = { sql, config, actor: "seed" };
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, {
    docId: id, locale: "en", data: { title: "Two", body: markdownToTree("# Two\n\nSecond\n"), legal: "L", tags: ["c"], price: 1 },
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

test("compile enqueues and translates a document end to end", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const model = mockModel([identity]);
  const lines: string[] = [];
  const r = await compile(ctxFor(sql, model), { locales: ["de"], budgetUsd: 1, log: (l) => lines.push(l) });
  expect(r.enqueue).toMatchObject({ enqueued: 1, duplicates: 0, cancelledStale: 0 });
  expect(r.worker).toMatchObject({ completed: 1, failed: 0, errors: 0, runBudgetStop: false });
  expect(r.pendingJobs).toBe(0);
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(await jobStates(sql)).toEqual([{ doc_id: docId, locale: "de", state: "COMPLETED" }]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(
    new RegExp(`^job=\\d+ doc=${docId} locale=de model=mock/translate tokens=100/50 cost_usd=0\\.000200 outcome=COMPLETED$`),
  );
}));

test("compile with a budget below the estimate enqueues but completes nothing", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const model = mockModel([identity]);
  const r = await compile(ctxFor(sql, model), { locales: ["de"], budgetUsd: 0.000001 });
  expect(r.enqueue.enqueued).toBe(1);
  expect(r.worker).toMatchObject({ completed: 0, failed: 0, runBudgetStop: true, spentMicros: 0 });
  expect(r.pendingJobs).toBe(1);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect((await jobStates(sql)).map((j) => j.state)).toEqual(["QUEUED"]);
}));

test("budgetUsd 0 throws ValidationError and enqueues nothing", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = ctxFor(sql, mockModel([identity]));
  for (const budgetUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(compile(ctx, { locales: ["de"], budgetUsd }), String(budgetUsd)).rejects.toBeInstanceOf(ValidationError);
  }
  expect(await jobStates(sql)).toEqual([]);
}));

test("compile with an expired licence throws LicenceError before enqueueing anything", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const model = mockModel([identity]);
  const saved = process.env.MOGGING_LICENSE_KEY;
  delete process.env.MOGGING_LICENSE_KEY;
  try {
    await sql`update migrations set applied_at = now() - interval '31 days'`;
    await expect(compile(ctxFor(sql, model), { locales: ["de"], budgetUsd: 1 })).rejects.toBeInstanceOf(LicenceError);
    expect(await jobStates(sql)).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  } finally {
    if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
  }
}));

test("compile runs and counts only the jobs inside its filter", async () => withTestDb(async (sql) => {
  const first = await migrateAndSeed(sql);
  const second = await seedPost(sql);
  const page = await seedDocsPage(sql);
  const model = mockModel([identity, identity]);
  const ctx = ctxFor(sql, model);
  // Three QUEUED jobs from an earlier sweep, one per document.
  expect((await enqueueStale(ctx, { locales: ["de"] })).enqueued).toBe(3);

  // docIds (with a case-folded locale): only `first` is run, and the other two stay QUEUED outside the filter.
  const r = await compile(ctx, { locales: ["DE"], collection: "posts", docIds: [first], budgetUsd: 1 });
  expect(r.enqueue).toMatchObject({ enqueued: 0, duplicates: 1 });
  expect(r.worker.completed).toBe(1);
  expect(r.pendingJobs).toBe(0);
  const states = new Map((await jobStates(sql)).map((j) => [j.doc_id, j.state]));
  expect([states.get(first), states.get(second), states.get(page)]).toEqual(["COMPLETED", "QUEUED", "QUEUED"]);

  // collection: the docs page is outside `posts`, so `second` is run and the page is neither run nor counted.
  const r2 = await compile(ctx, { locales: ["de"], collection: "posts", budgetUsd: 1 });
  expect(r2.worker.completed).toBe(1);
  expect(r2.pendingJobs).toBe(0);
  expect((await jobStates(sql)).find((j) => j.doc_id === page)!.state).toBe("QUEUED");
  expect(model.doGenerateCalls).toHaveLength(2);
}));

test("a job that went back to QUEUED with back-off still counts as pending", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const model = mockModel([new Error("provider down")]);
  const r = await compile(ctxFor(sql, model), { locales: ["de"], budgetUsd: 1 });
  expect(r.worker).toMatchObject({ completed: 0, requeued: 1 });
  expect(r.pendingJobs).toBe(1);
}));
