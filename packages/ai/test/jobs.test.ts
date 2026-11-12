import { expect, test } from "vitest";
import type { Sql } from "postgres";
import type { LanguageModel } from "ai";
import {
  LicenceError, ValidationError, approve, createDocument, getDocument, publish, recordAiDraft, saveDraft,
} from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { cancelJobs, enqueueStale, listJobs, retryJobs } from "../src/jobs.js";
import { estimateRequest, planRequests } from "../src/estimate.js";
import { maxTemplateTokens } from "../src/prompt.js";
import { priceFor } from "../src/config.js";
import type { AiCtx } from "../src/config.js";
import { ctxFor, extraConnection, migrateAndSeed } from "./fixtures.js";
import { withTestDb } from "./db.js";

const model = {} as unknown as LanguageModel;
const FIELDS = ["title", "body", "legal", "tags"];

type Job = { id: number; locale: string; field_paths: string[]; source_version: number; state: string; error_message: string | null;
  cost_estimate_micros: number; budget_scope: string | null; attempts: number; source_hashes: Record<string, string> };

async function jobs(sql: Sql): Promise<Job[]> {
  const rows = await sql`select * from ai_jobs order by id`;
  return rows.map((r) => ({
    id: Number(r.id), locale: r.locale as string, field_paths: r.field_paths as string[], source_version: r.source_version as number,
    state: r.state as string, error_message: r.error_message as string | null, cost_estimate_micros: Number(r.cost_estimate_micros),
    budget_scope: r.budget_scope as string | null, attempts: r.attempts as number, source_hashes: r.source_hashes as Record<string, string>,
  }));
}

const sourceData = (title: string, legal = "Terms apply") => ({
  title, body: markdownToTree("# Hi\n\nHello `x` {name}\n"), legal, tags: ["a", "b"], price: 5,
});

/** Saves and publishes a new source (en) version with the given title and legal text. */
async function republishSource(ctx: AiCtx, docId: string, title: string, legal?: string): Promise<void> {
  await saveDraft(ctx, { docId, locale: "en", data: sourceData(title, legal) });
  await publish(ctx, { docId, locale: "en" });
}

/** A second published `posts` document, like migrateAndSeed's (without migrating). */
async function seedPost(ctx: AiCtx): Promise<string> {
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "en", data: sourceData("Hello") });
  await publish(ctx, { docId: id, locale: "en" });
  return id;
}

async function sourceHead(ctx: AiCtx, docId: string) {
  const doc = await getDocument(ctx, { collection: "posts", docId });
  return doc!.locales.en!.published!;
}

/** An AI draft of `fields` for `de` at the current source version. */
async function aiDraft(ctx: AiCtx, docId: string, fields: Record<string, unknown>): Promise<void> {
  const src = await sourceHead(ctx, docId);
  const out = await recordAiDraft(ctx, {
    docId, locale: "de", fields, sourceVersion: src.version, sourceHashes: src.sourceHashes, provenance: [],
  });
  expect(out).toHaveProperty("version");
}

const allDe = () => ({ title: "Hallo", body: markdownToTree("# Hallo\n"), legal: "AGB gelten", tags: ["a", "b"] });

test("enqueueStale on a fresh de creates one QUEUED job of the translatable missing fields in schema order", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    const report = await enqueueStale(ctx, { locales: ["DE"], collection: "posts", docIds: [docId] });
    expect(report.enqueued).toBe(1);
    expect(report.duplicates).toBe(0);
    expect(report.cancelledStale).toBe(0);

    const src = await sourceHead(ctx, docId);
    const { price } = priceFor(ctx.ai, "posts");
    const contextChars = JSON.stringify({ siblings: {}, shared: {}, glossary: [] }, null, 1).length;
    const planned = planRequests({
      ai: ctx.ai, price, sourceLocale: "en", targetLocale: "de",
      fields: FIELDS.map((name) => ({ name, wire: src.data[name] })), contextChars, glossaryChars: contextChars,
      templateTokens: maxTemplateTokens(),
    });
    expect("requests" in planned && planned.requests.length).toBe(1);
    const single = estimateRequest({
      sourceLocale: "en", targetLocale: "de", contextChars, templateTokens: maxTemplateTokens(), price,
      translateChars: FIELDS.reduce((n, f) => n + JSON.stringify(src.data[f]).length, 0),
    });

    const [job, ...rest] = await jobs(sql);
    expect(rest).toEqual([]);
    expect(job).toMatchObject({
      locale: "de", field_paths: FIELDS, source_version: src.version, state: "QUEUED", budget_scope: "global",
      cost_estimate_micros: 2 * single.costMicros,
    });
    expect(single.costMicros).toBeGreaterThan(0);
    expect(job!.source_hashes).toEqual(Object.fromEntries(FIELDS.map((f) => [f, src.sourceHashes[f]])));
    expect(report.estimateMicros).toBe(2 * single.costMicros);
  });
});

test("non-text fields are reported, not enqueued", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const report = await enqueueStale(ctxFor(sql, model), { locales: ["de"] });
    expect(report.skipped).toEqual([{ docId, locale: "de", field: "price", reason: "not translatable" }]);
    const [job] = await jobs(sql);
    expect(job!.field_paths).not.toContain("price");
  });
});

test("a second call reports duplicates and inserts nothing", async () => {
  await withTestDb(async (sql) => {
    await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const again = await enqueueStale(ctx, { locales: ["de"] });
    expect(again).toMatchObject({ enqueued: 0, duplicates: 1, cancelledStale: 0, estimateMicros: 0 });
    expect(await jobs(sql)).toHaveLength(1);
  });
});

test("a current DRAFT_AI head is not bought again", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    // A PUBLISHED de head, so getSyncState measures it rather than the draft head (state.ts:77-80).
    await aiDraft(ctx, docId, allDe());
    await approve(ctx, { docId, locale: "de" });
    await publish(ctx, { docId, locale: "de" });
    // The source title moves; an AI draft of the new title is pending.
    await republishSource(ctx, docId, "Hello again");
    await aiDraft(ctx, docId, { title: "Hallo wieder" });

    const report = await enqueueStale(ctx, { locales: ["de"] });
    expect(report.enqueued).toBe(0);
    expect(report.skipped.filter((s) => s.reason === "draft already current"))
      .toEqual([{ docId, locale: "de", field: "title", reason: "draft already current" }]);
    expect(await jobs(sql)).toEqual([]);

    // Now legal moves too: only legal is bought.
    await republishSource(ctx, docId, "Hello again", "New terms");
    const next = await enqueueStale(ctx, { locales: ["de"] });
    expect(next.enqueued).toBe(1);
    const [job] = await jobs(sql);
    expect(job!.field_paths).toEqual(["legal"]);
  });
});

test("a new source version cancels the old QUEUED job and enqueues a new one", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    await republishSource(ctx, docId, "Hello again");
    const report = await enqueueStale(ctx, { locales: ["de"] });
    expect(report).toMatchObject({ enqueued: 1, duplicates: 0, cancelledStale: 1 });
    const [old, fresh] = await jobs(sql);
    expect(old).toMatchObject({ state: "CANCELLED", error_message: "source moved before claim (test)" });
    expect(fresh!.state).toBe("QUEUED");
    expect(fresh!.source_version).toBe(old!.source_version + 1);
  });
});

test("a sweep never cancels a QUEUED job of a NEWER source version; a later sweep still cancels the older one", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    const v = (await sourceHead(ctx, docId)).version;
    // A concurrent sweep that read the next source version queued its job first.
    const [{ id: newerRaw }] = (await sql`insert into ai_jobs (doc_id, locale, field_paths, source_version, state)
      values (${docId}, 'de', ${FIELDS}::text[], ${v + 1}, 'QUEUED') returning id`) as unknown as [{ id: string }];
    const newer = Number(newerRaw);

    // This sweep read version v: it queues its own job and leaves the newer one alone.
    const report = await enqueueStale(ctx, { locales: ["de"] });
    expect(report).toMatchObject({ enqueued: 1, duplicates: 0, cancelledStale: 0 });
    const [first, second] = await jobs(sql);
    expect(first).toMatchObject({ id: newer, state: "QUEUED", source_version: v + 1 });
    expect(second).toMatchObject({ state: "QUEUED", source_version: v });

    // The source reaches v + 1: a sweep there cancels the job at v and finds the newer one already queued.
    await republishSource(ctx, docId, "Hello again");
    expect((await sourceHead(ctx, docId)).version).toBe(v + 1);
    const next = await enqueueStale(ctx, { locales: ["de"] });
    expect(next).toMatchObject({ enqueued: 0, duplicates: 1, cancelledStale: 1 });
    const after = await jobs(sql);
    expect(after.map((j) => [j.id, j.state])).toEqual([[newer, "QUEUED"], [second!.id, "CANCELLED"]]);
  });
});

test("a DRAFT_HUMAN draft in de makes the pair human draft pending", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await saveDraft(ctx, { docId, locale: "de", data: { title: "Hallo" } }); // body, legal, tags stay missing
    const report = await enqueueStale(ctx, { locales: ["de"] });
    expect(report.enqueued).toBe(0);
    expect(report.skipped).toContainEqual({ docId, locale: "de", field: null, reason: "human draft pending" });
    expect(await jobs(sql)).toEqual([]);
  });
});

test("a human draft cancels the pair's QUEUED job at enqueue", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    await saveDraft(ctx, { docId, locale: "de", data: { title: "Hallo" } });
    const report = await enqueueStale(ctx, { locales: ["de"] });
    expect(report).toMatchObject({ enqueued: 0, duplicates: 0, cancelledStale: 1 });
    expect(report.skipped).toContainEqual({ docId, locale: "de", field: null, reason: "human draft pending" });
    const [job, ...rest] = await jobs(sql);
    expect(rest).toEqual([]);
    expect(job).toMatchObject({ state: "CANCELLED", error_message: "human draft pending" });
  });
});

test("a FAILED job for the same source version is re-enqueued", async () => {
  await withTestDb(async (sql) => {
    await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    await sql`update ai_jobs set state = 'FAILED', error_message = 'boom'`;
    const report = await enqueueStale(ctx, { locales: ["de"] });
    expect(report).toMatchObject({ enqueued: 1, duplicates: 0, cancelledStale: 0 });
    const [failed, fresh] = await jobs(sql);
    expect(failed!.state).toBe("FAILED");
    expect(fresh).toMatchObject({ state: "QUEUED", source_version: failed!.source_version });
  });
});

test("docIds without collection throws ValidationError", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    await expect(enqueueStale(ctxFor(sql, model), { locales: ["de"], docIds: [docId] })).rejects.toBeInstanceOf(ValidationError);
    expect(await jobs(sql)).toEqual([]);
  });
});

test("enqueueStale with an expired licence throws LicenceError", async () => {
  await withTestDb(async (sql) => {
    await migrateAndSeed(sql);
    const saved = process.env.MOGGING_LICENSE_KEY;
    delete process.env.MOGGING_LICENSE_KEY;
    try {
      await sql`update migrations set applied_at = now() - interval '31 days'`;
      await expect(enqueueStale(ctxFor(sql, model), { locales: ["de"] })).rejects.toBeInstanceOf(LicenceError);
      expect(await jobs(sql)).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
    }
  });
});

test("listJobs returns the job and the global budget row", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const [raw] = await jobs(sql);
    const out = await listJobs(ctx);
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]).toMatchObject({
      id: raw!.id, docId, collection: "posts", locale: "de", fieldPaths: FIELDS, sourceVersion: raw!.source_version,
      state: "QUEUED", attempts: 0, maxAttempts: 3, lockedUntil: null, lockedBy: null,
      costEstimateMicros: raw!.cost_estimate_micros, budgetScope: "global", errorMessage: null,
    });
    expect(out.jobs[0]!.runAfter).toBeInstanceOf(Date);
    expect(out.budgets.map((b) => [b.scope, b.capMicros])).toEqual([["global", 1_000_000]]);
    expect((await listJobs(ctx, { state: "FAILED" })).jobs).toEqual([]);
    expect((await listJobs(ctx, { collection: "docs" })).jobs).toEqual([]);
  });
});

test("cancelJobs then retryJobs round-trip the state and record the actor", async () => {
  await withTestDb(async (sql) => {
    await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const [job] = await jobs(sql);
    expect(await cancelJobs(ctx, { ids: [job!.id] })).toEqual({ cancelled: 1 });
    expect((await jobs(sql))[0]).toMatchObject({ state: "CANCELLED", error_message: "cancelled by test" });
    expect(await cancelJobs(ctx, { ids: [job!.id] })).toEqual({ cancelled: 0 }); // already cancelled

    await sql`update ai_jobs set attempts = 2`;
    const retried = await retryJobs({ ...ctx, actor: "ops" }, { ids: [job!.id] });
    expect(retried).toEqual({ retried: 1, skipped: [] });
    expect((await jobs(sql))[0]).toMatchObject({ state: "QUEUED", attempts: 0, error_message: "retried by ops", field_paths: FIELDS });
  });
});

test("retryJobs skips a job whose source moved, one with an active sibling, one under a human draft and one whose draft is already current", async () => {
  await withTestDb(async (sql) => {
    const moved = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    const human = await seedPost(ctx);
    const current = await seedPost(ctx);
    await enqueueStale(ctx, { locales: ["de"] });
    const idOf = async (docId: string) => Number((await sql`select id from ai_jobs where doc_id = ${docId} order by id desc limit 1`)[0]!.id);
    const movedJob = await idOf(moved);
    const humanJob = await idOf(human);
    const currentJob = await idOf(current);
    expect(await cancelJobs(ctx, { ids: [movedJob, humanJob, currentJob] })).toEqual({ cancelled: 3 });

    // Source moved: a new source version is published after the job was cancelled.
    await republishSource(ctx, moved, "Hello again");
    // Active sibling: a cancelled job beside a QUEUED one of the same (doc, locale, source version).
    await enqueueStale(ctx, { locales: ["de"], collection: "posts", docIds: [moved] });
    const [{ id: siblingRaw }] = (await sql`insert into ai_jobs (doc_id, locale, field_paths, source_version, state)
      select doc_id, locale, field_paths, source_version, 'CANCELLED' from ai_jobs where state = 'QUEUED' and doc_id = ${moved}
      returning id`) as unknown as [{ id: string }];
    const sibling = Number(siblingRaw);
    // Human draft.
    await saveDraft(ctx, { docId: human, locale: "de", data: { title: "Hallo" } });
    // Draft already current: every job field has a current AI draft.
    await aiDraft(ctx, current, allDe());

    const out = await retryJobs(ctx, { ids: [movedJob, sibling, humanJob, currentJob] });
    expect(out).toEqual({
      retried: 0,
      skipped: [
        { id: movedJob, reason: "source moved" },
        { id: sibling, reason: "active job exists" },
        { id: humanJob, reason: "human draft pending" },
        { id: currentJob, reason: "draft already current" },
      ],
    });
    const states = await sql`select id, state from ai_jobs where id = any(${[movedJob, sibling, humanJob, currentJob].map(String)}::bigint[])`;
    expect(states.every((r) => r.state === "CANCELLED")).toBe(true);
  });
});

test("retryJobs narrows field_paths to the fields a pending draft does not already cover", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const [job] = await jobs(sql);
    await cancelJobs(ctx, { ids: [job!.id] });
    await aiDraft(ctx, docId, { title: "Hallo", legal: "AGB gelten" });
    expect(await retryJobs(ctx, { ids: [job!.id] })).toEqual({ retried: 1, skipped: [] });
    expect((await jobs(sql))[0]).toMatchObject({ state: "QUEUED", field_paths: ["body", "tags"] });
  });
});

test("retryJobs skips a job whose translation was meanwhile approved and published at the same source version", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const [job] = await jobs(sql);
    await sql`update ai_jobs set state = 'FAILED', error_message = 'boom'`;
    await aiDraft(ctx, docId, allDe());
    await approve(ctx, { docId, locale: "de" });
    await publish(ctx, { docId, locale: "de" });
    const doc = await getDocument(ctx, { collection: "posts", docId });
    expect(doc!.locales.de!.draft).toBeNull(); // only the published head can tell the retry it is current

    expect(await retryJobs(ctx, { ids: [job!.id] })).toEqual({
      retried: 0, skipped: [{ id: job!.id, reason: "draft already current" }],
    });
    expect((await jobs(sql))[0]).toMatchObject({ state: "FAILED", error_message: "boom" });
  });
});

test("retryJobs narrows field_paths to the fields the published target head does not already cover", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const [job] = await jobs(sql);
    await sql`update ai_jobs set state = 'FAILED', error_message = 'boom'`;
    await aiDraft(ctx, docId, { title: "Hallo", legal: "AGB gelten" });
    await approve(ctx, { docId, locale: "de" });
    await publish(ctx, { docId, locale: "de" });
    expect(await retryJobs(ctx, { ids: [job!.id] })).toEqual({ retried: 1, skipped: [] });
    expect((await jobs(sql))[0]).toMatchObject({ state: "QUEUED", field_paths: ["body", "tags"] });
  });
});

test("retryJobs reports active job exists when a sibling is queued between its check and its update (23505)", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await enqueueStale(ctx, { locales: ["de"] });
    const [job] = await jobs(sql);
    await cancelJobs(ctx, { ids: [job!.id] });
    const other = await extraConnection(sql);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    try {
      let inserted!: () => void;
      const holding = new Promise<void>((r) => { inserted = r; });
      // An uncommitted QUEUED sibling: invisible to retryOne's active check, but its UPDATE to QUEUED waits on the
      // unique index entry and fails with 23505 once the sibling commits.
      const sibling = other.begin(async (tx) => {
        await tx`insert into ai_jobs (doc_id, locale, field_paths, source_version, state)
          values (${docId}, 'de', ${FIELDS}::text[], ${job!.source_version}, 'QUEUED')`;
        inserted();
        await gate;
      });
      await holding;
      // A third connection, opened while `sql` is still free: both others are busy below.
      const probe = await extraConnection(sql);
      const retry = retryJobs(ctx, { ids: [job!.id, 999_999] });
      // Wait until the retry's UPDATE is blocked on the sibling's transaction.
      try {
        for (let i = 0; ; i++) {
          const [w] = await probe`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()
            and query like '%update ai_jobs set state = ''QUEUED''%'`;
          if (w) break;
          if (i > 500) throw new Error("the retry never waited on the sibling");
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        await probe.end();
      }
      release();
      await sibling;
      expect(await retry).toEqual({
        retried: 0, skipped: [{ id: job!.id, reason: "active job exists" }, { id: 999_999, reason: "not found" }],
      });
      expect((await jobs(sql))[0]).toMatchObject({ id: job!.id, state: "CANCELLED" });
    } finally {
      release();
      await other.end();
    }
  });
});

test("listJobs afterId returns the next page with no overlap", async () => {
  await withTestDb(async (sql) => {
    await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    await seedPost(ctx);
    await seedPost(ctx);
    await enqueueStale(ctx, { locales: ["de"] });
    const all = (await listJobs(ctx)).jobs.map((j) => j.id);
    expect(all).toHaveLength(3);
    const first = (await listJobs(ctx, { limit: 2 })).jobs.map((j) => j.id);
    expect(first).toEqual(all.slice(0, 2));
    const second = (await listJobs(ctx, { limit: 2, afterId: first.at(-1)! })).jobs.map((j) => j.id);
    expect(second).toEqual(all.slice(2));
    expect((await listJobs(ctx, { afterId: all.at(-1)! })).jobs).toEqual([]);
    await expect(listJobs(ctx, { afterId: -1 })).rejects.toBeInstanceOf(ValidationError);
  });
});
