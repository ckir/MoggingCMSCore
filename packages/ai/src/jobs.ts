import type { Sql, TransactionSql } from "postgres";
import {
  ValidationError, assertLicensed, getDocument, getSyncState, normalizeLocale,
  type Collection, type DocumentRecord, type Snapshot, type SyncStateRow,
} from "@mogging/core";
import { assertActor } from "./actor.js";
import { priceFor, type AiCtx } from "./config.js";
import { jobContext } from "./context.js";
import { estimateRequest, planRequests } from "./estimate.js";
import { isTranslatable } from "./fields.js";
import { listGlossary } from "./glossary.js";
import { maxTemplateTokens } from "./prompt.js";
import { getBudgets, scopesFor, type BudgetRow } from "./budget.js";
import { listLimit } from "./provenance.js";

type Json = Parameters<Sql["json"]>[0];

export type EnqueueInput = { locales: string[]; collection?: string; docIds?: string[] };
export type Skipped = {
  docId: string; locale: string; field: string | null; reason: "not translatable" | "human draft pending" | "draft already current";
};
export type EnqueueReport = { enqueued: number; duplicates: number; cancelledStale: number; estimateMicros: number; skipped: Skipped[] };

export type JobRow = {
  id: number; docId: string; collection: string; locale: string; fieldPaths: string[]; sourceVersion: number; state: string;
  attempts: number; maxAttempts: number; runAfter: Date; lockedUntil: Date | null; lockedBy: string | null;
  costEstimateMicros: number; budgetScope: string | null; errorMessage: string | null; createdAt: Date; updatedAt: Date;
};

/** An ai_jobs row joined with its document's collection, as postgres.js returns it. */
export type Row = {
  id: string; doc_id: string; collection: string; locale: string; field_paths: string[]; source_version: number; state: string;
  attempts: number; max_attempts: number; run_after: Date; locked_until: Date | null; locked_by: string | null;
  cost_estimate_micros: string; budget_scope: string | null; error_message: string | null; created_at: Date; updated_at: Date;
};

// bigint columns arrive as strings from postgres.js.
export const toJobRow = (r: Row): JobRow => ({
  id: Number(r.id), docId: r.doc_id, collection: r.collection, locale: r.locale, fieldPaths: [...r.field_paths],
  sourceVersion: r.source_version, state: r.state, attempts: r.attempts, maxAttempts: r.max_attempts, runAfter: r.run_after,
  lockedUntil: r.locked_until, lockedBy: r.locked_by, costEstimateMicros: Number(r.cost_estimate_micros),
  budgetScope: r.budget_scope, errorMessage: r.error_message, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Fields of `collection` named in `names`, in SCHEMA order (the key order of `collection.fields`). */
const inSchemaOrder = (collection: Collection, names: Iterable<string>): string[] => {
  const set = new Set(names);
  return Object.keys(collection.fields).filter((f) => set.has(f));
};

/**
 * The job's fields that a pending DRAFT_AI or APPROVED draft head does not already cover at the source head's hash.
 * Any other draft state (or none) leaves every field.
 */
function notYetDrafted(draft: Snapshot | null, source: Snapshot, fields: string[]): string[] {
  if (draft === null || (draft.state !== "DRAFT_AI" && draft.state !== "APPROVED")) return fields;
  return fields.filter((f) => !(Object.hasOwn(draft.sourceHashes, f) && draft.sourceHashes[f] === source.sourceHashes[f]));
}

/** The fields whose PUBLISHED target head does not already carry the source head's hash (getSyncState's `current`). */
function notYetPublished(published: Snapshot | null, source: Snapshot, fields: string[]): string[] {
  if (published === null) return fields;
  return fields.filter((f) => !(Object.hasOwn(published.sourceHashes, f) && published.sourceHashes[f] === source.sourceHashes[f]));
}

/**
 * Spec 8.5's enqueue estimate over the STORED values: 2 x the sum of estimateRequest over the planned requests (a
 * standard call plus a possible strict retry each). A field too large for the window is left out of the estimate.
 */
function estimateJob(
  ctx: AiCtx, collection: Collection, doc: DocumentRecord, source: Snapshot, locale: string, fields: string[],
  glossary: Array<{ term: string; translation: string | null; doNotTranslate: boolean }>,
): number {
  const sourceLocale = ctx.config.locales.source;
  const { price } = priceFor(ctx.ai, collection.name);
  const { contextChars, glossaryChars } = jobContext(ctx.ai, collection, doc, locale, fields, glossary);
  const templateTokens = maxTemplateTokens();

  let candidates = fields.map((name) => ({ name, wire: source.data[name] }));
  for (;;) {
    const plan = planRequests({
      ai: ctx.ai, price, sourceLocale, targetLocale: locale, fields: candidates, contextChars, glossaryChars, templateTokens,
    });
    if ("tooLarge" in plan) {
      candidates = candidates.filter((c) => c.name !== plan.tooLarge); // the worker fails the job naming it
      continue;
    }
    let micros = 0;
    for (const r of plan.requests) {
      const translateChars = r.fields.reduce((n, f) => n + (JSON.stringify(source.data[f]) ?? "").length, 0);
      micros += estimateRequest({
        sourceLocale, targetLocale: locale, translateChars, contextChars: r.noContext ? glossaryChars : contextChars,
        templateTokens, price,
      }).costMicros;
    }
    return 2 * micros;
  }
}

type Pair = {
  docId: string; locale: string; collection: Collection; sourceVersion: number;
  fields: string[]; sourceHashes: Record<string, string>; estimate: number;
};

/**
 * Queues one job per (document, locale) with stale or missing translatable fields (spec 8.1, 8.2). Licence-guarded.
 * Reads (sync state, one getDocument per document, the glossary once per locale) happen first; every cancel and
 * insert then runs in one transaction. Takes no budget lock.
 */
export async function enqueueStale(ctx: AiCtx, input: EnqueueInput): Promise<EnqueueReport> {
  await assertLicensed(ctx);
  assertActor(ctx);
  const { config } = ctx;
  if (input.docIds !== undefined && input.collection === undefined) {
    throw new ValidationError("docIds requires collection");
  }
  if (!Array.isArray(input.locales)) throw new ValidationError("locales must be an array");
  const locales = [...new Set(input.locales.map(normalizeLocale))];
  let collections: Collection[];
  if (input.collection !== undefined) {
    const c = config.collections.find((x) => x.name === input.collection);
    if (!c) throw new ValidationError(`Unknown collection "${input.collection}"`);
    collections = [c];
  } else {
    collections = [...config.collections];
  }

  const skipped: Skipped[] = [];
  // (docId, locale) -> stale or missing translatable fields; insertion order is the sweep order.
  const groups = new Map<string, { docId: string; locale: string; collection: Collection; fields: string[] }>();
  for (const collection of collections) {
    for (const locale of locales) {
      const rows: SyncStateRow[] = [];
      if (input.docIds !== undefined) {
        for (const docId of new Set(input.docIds)) rows.push(...await getSyncState(ctx, { collection: collection.name, docId, locale }));
      } else {
        rows.push(...await getSyncState(ctx, { collection: collection.name, locale }));
      }
      for (const r of rows) {
        if (r.state !== "stale" && r.state !== "missing") continue;
        const field = Object.hasOwn(collection.fields, r.field) ? collection.fields[r.field] : undefined;
        if (!field || !isTranslatable(field)) {
          skipped.push({ docId: r.docId, locale: r.locale, field: r.field, reason: "not translatable" });
          continue;
        }
        const key = `${r.docId}\u0000${r.locale}`;
        let g = groups.get(key);
        if (!g) {
          g = { docId: r.docId, locale: r.locale, collection, fields: [] };
          groups.set(key, g);
        }
        g.fields.push(r.field);
      }
    }
  }

  const docs = new Map<string, DocumentRecord | null>();
  const glossaries = new Map<string, Array<{ term: string; translation: string | null; doNotTranslate: boolean }>>();
  const humanPending: Array<{ docId: string; locale: string }> = [];
  const pairs: Pair[] = [];
  for (const g of groups.values()) {
    let doc = docs.get(g.docId);
    if (doc === undefined) {
      doc = await getDocument(ctx, { collection: g.collection.name, docId: g.docId });
      docs.set(g.docId, doc);
    }
    const source = doc?.locales[config.locales.source]?.published ?? null;
    if (!doc || doc.deletedAt !== null || !source) continue; // deleted or unpublished since the sync-state read
    const draft = doc.locales[g.locale]?.draft ?? null;
    if (draft?.state === "DRAFT_HUMAN") {
      skipped.push({ docId: g.docId, locale: g.locale, field: null, reason: "human draft pending" });
      humanPending.push({ docId: g.docId, locale: g.locale });
      continue;
    }
    const ordered = inSchemaOrder(g.collection, g.fields);
    const fields = notYetDrafted(draft, source, ordered);
    for (const f of ordered) {
      if (!fields.includes(f)) skipped.push({ docId: g.docId, locale: g.locale, field: f, reason: "draft already current" });
    }
    if (fields.length === 0) continue;

    let glossary = glossaries.get(g.locale);
    if (glossary === undefined) {
      glossary = (await listGlossary(ctx, { sourceLocale: config.locales.source, targetLocale: g.locale }))
        .map((e) => ({ term: e.term, translation: e.translation, doNotTranslate: e.doNotTranslate }));
      glossaries.set(g.locale, glossary);
    }
    pairs.push({
      docId: g.docId, locale: g.locale, collection: g.collection, sourceVersion: source.version, fields,
      sourceHashes: Object.fromEntries(fields.filter((f) => Object.hasOwn(source.sourceHashes, f)).map((f) => [f, source.sourceHashes[f]!])),
      estimate: estimateJob(ctx, g.collection, doc, source, g.locale, fields, glossary),
    });
  }

  const report: EnqueueReport = { enqueued: 0, duplicates: 0, cancelledStale: 0, estimateMicros: 0, skipped };
  if (humanPending.length === 0 && pairs.length === 0) return report;
  await ctx.sql.begin(async (tx) => {
    for (const p of humanPending) {
      const cancelled = await tx`update ai_jobs set state = 'CANCELLED', error_message = 'human draft pending',
          updated_at = clock_timestamp()
        where doc_id = ${p.docId} and locale = ${p.locale} and state = 'QUEUED'`;
      report.cancelledStale += cancelled.count;
    }
    for (const p of pairs) {
      // `<`, not `<>`: source versions only increase, and a concurrent sweep that read a NEWER version may already
      // have queued its job; cancelling that one would leave only this older job, which then self-cancels.
      const cancelled = await tx`update ai_jobs set state = 'CANCELLED',
          error_message = ${`source moved before claim (${ctx.actor})`}, updated_at = clock_timestamp()
        where doc_id = ${p.docId} and locale = ${p.locale} and state = 'QUEUED' and source_version < ${p.sourceVersion}`;
      report.cancelledStale += cancelled.count;
      const inserted = await tx`insert into ai_jobs
          (doc_id, locale, field_paths, source_version, source_hashes, state, max_attempts, cost_estimate_micros, budget_scope)
        values (${p.docId}, ${p.locale}, ${p.fields}::text[], ${p.sourceVersion}, ${tx.json(p.sourceHashes as Json)}, 'QUEUED',
                ${ctx.ai.maxAttempts}, ${p.estimate}, ${scopesFor(ctx.ai, p.collection.name).at(-1)!})
        on conflict (doc_id, locale, source_version) where state in ('QUEUED', 'RUNNING') do nothing
        returning id`;
      if (inserted.length === 1) {
        report.enqueued += 1;
        report.estimateMicros += p.estimate;
      } else {
        report.duplicates += 1;
      }
    }
  });
  return report;
}

/**
 * Jobs ordered by id (oldest first) with the current month's budgets. `afterId` is the cursor: only jobs with a
 * greater id, so pass the last id of a page to read the next one. Not licence-guarded: a read.
 */
export async function listJobs(
  ctx: AiCtx, input: { state?: string; collection?: string; limit?: number; afterId?: number } = {},
): Promise<{ jobs: JobRow[]; budgets: BudgetRow[] }> {
  const limit = listLimit(input.limit);
  if (input.afterId !== undefined && !(Number.isSafeInteger(input.afterId) && input.afterId >= 0)) {
    throw new ValidationError(`afterId must be a non-negative integer, got ${input.afterId}`);
  }
  const { sql } = ctx;
  const rows = (await sql`select j.*, d.collection from ai_jobs j join documents d on d.id = j.doc_id
    where true
      ${input.afterId === undefined ? sql`` : sql`and j.id > ${input.afterId}`}
      ${input.state === undefined ? sql`` : sql`and j.state = ${input.state}`}
      ${input.collection === undefined ? sql`` : sql`and d.collection = ${input.collection}`}
    order by j.id
    limit ${limit}`) as unknown as Row[];
  return { jobs: rows.map(toJobRow), budgets: await getBudgets(ctx) };
}

function checkIds(ids: unknown): number[] {
  if (!Array.isArray(ids) || !ids.every((i) => Number.isSafeInteger(i) && i > 0)) {
    throw new ValidationError("ids must be an array of positive integers");
  }
  return [...new Set(ids as number[])];
}

type RetryOutcome = { retried: true } | { reason: string };
const UNIQUE_VIOLATION = "23505";

async function retryOne(ctx: AiCtx, tx: TransactionSql, id: number): Promise<RetryOutcome> {
  const [row] = (await tx`select j.*, d.collection from ai_jobs j join documents d on d.id = j.doc_id
    where j.id = ${id} for update of j`) as unknown as Array<Row | undefined>;
  if (!row) return { reason: "not found" };
  if (row.state !== "FAILED" && row.state !== "CANCELLED") return { reason: `not retryable (${row.state})` };
  const job = toJobRow(row);
  const collection = ctx.config.collections.find((c) => c.name === job.collection);
  const doc = collection ? await getDocument({ ...ctx, sql: tx as unknown as Sql }, { collection: collection.name, docId: job.docId }) : null;
  if (!collection || !doc || doc.deletedAt !== null) return { reason: "document deleted" };

  const source = doc.locales[ctx.config.locales.source]?.published ?? null;
  if (!source || source.version !== job.sourceVersion) return { reason: "source moved" };
  const [active] = await tx`select 1 from ai_jobs where doc_id = ${job.docId} and locale = ${job.locale}
    and source_version = ${job.sourceVersion} and state in ('QUEUED', 'RUNNING') and id <> ${job.id}`;
  if (active) return { reason: "active job exists" };
  const draft = doc.locales[job.locale]?.draft ?? null;
  if (draft?.state === "DRAFT_HUMAN") return { reason: "human draft pending" };
  // As at enqueue: a field the published target head already carries at the source hash is not bought again either.
  const published = doc.locales[job.locale]?.published ?? null;
  const fields = notYetPublished(published, source, notYetDrafted(draft, source, inSchemaOrder(collection, job.fieldPaths)));
  if (fields.length === 0) return { reason: "draft already current" };

  await tx`update ai_jobs set state = 'QUEUED', attempts = 0, error_message = ${`retried by ${ctx.actor}`},
      run_after = clock_timestamp(), locked_until = null, locked_by = null, field_paths = ${fields}::text[],
      updated_at = clock_timestamp()
    where id = ${job.id}`;
  return { retried: true };
}

/**
 * FAILED or CANCELLED -> QUEUED (attempts 0, error_message `retried by <actor>`), one transaction per id, under the
 * gates of enqueueStale. A job a pending draft or the published target head partly covers is narrowed to its other
 * fields. A sibling queued concurrently (unique violation) is reported `active job exists`. Not licence-guarded.
 */
export async function retryJobs(
  ctx: AiCtx, input: { ids: number[] },
): Promise<{ retried: number; skipped: Array<{ id: number; reason: string }> }> {
  assertActor(ctx);
  const ids = checkIds(input.ids);
  let retried = 0;
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const id of ids) {
    let out: RetryOutcome;
    try {
      out = await ctx.sql.begin((tx) => retryOne(ctx, tx, id));
    } catch (err) {
      // uq_ai_jobs_active: a sibling was queued after retryOne's active check (its only write is the final UPDATE).
      if ((err as { code?: unknown } | null)?.code !== UNIQUE_VIOLATION) throw err;
      out = { reason: "active job exists" };
    }
    if ("retried" in out) retried += 1;
    else skipped.push({ id, reason: out.reason });
  }
  return { retried, skipped };
}

/** QUEUED or RUNNING -> CANCELLED, error_message `cancelled by <actor>`; a RUNNING worker then fails its fence. */
export async function cancelJobs(ctx: AiCtx, input: { ids: number[] }): Promise<{ cancelled: number }> {
  assertActor(ctx);
  const ids = checkIds(input.ids);
  if (ids.length === 0) return { cancelled: 0 };
  const out = await ctx.sql`update ai_jobs set state = 'CANCELLED', error_message = ${`cancelled by ${ctx.actor}`},
      updated_at = clock_timestamp()
    where id = any(${ids.map(String)}::bigint[]) and state in ('QUEUED', 'RUNNING')`;
  return { cancelled: out.count };
}
