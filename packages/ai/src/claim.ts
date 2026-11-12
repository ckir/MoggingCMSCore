import { randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { normalizeLocale, recordAiDraft, type AiProvenanceInput } from "@mogging/core";
import type { AiCtx } from "./config.js";
import { debitBudgets, lockBudgets, scopesFor } from "./budget.js";
import { toJobRow, type JobRow, type Row } from "./jobs.js";
import { writeDiscardedRow } from "./provenance.js";

// Time: every comparison and every stored timestamp in this file uses the DATABASE clock (`clock_timestamp()`), never
// the worker's, so workers on hosts with skewed clocks agree with the reaper (spec 8.2 phrases the fence with `now()`).
// Lock order, in every transaction: ai_budgets rows (global first, lockBudgets) -> the ai_jobs row -> documents
// (taken by recordAiDraft).

export type ClaimFilter = { collection?: string; docIds?: string[]; locales?: string[]; excludeIds?: number[]; maxEstimateMicros?: number };
export type ClaimResult = { job: JobRow; lease: string } | { refused: "budget" | "empty"; reason?: string; jobId?: number };
export type CallCost = {
  callId: string; modelId: string; promptVersion: string; promptTokens: number; completionTokens: number;
  costMicros: number; kept: boolean; discardReason?: string;
};
export type Completion =
  | { kind: "draft"; fields: Record<string, unknown>; sourceHashes: Record<string, string>; calls: CallCost[]; perField: AiProvenanceInput[] }
  | { kind: "failed"; reason: string; calls: CallCost[] }
  | { kind: "retry"; reason: string; calls: CallCost[] }
  | { kind: "cancel"; code: "SOURCE_MOVED" | "DRAFT_HUMAN"; calls: CallCost[] };
export type CompleteResult = "COMPLETED" | "CANCELLED" | "FAILED" | "QUEUED" | "DISCARDED";

const MAX_CANDIDATES = 10;
const BUDGET_RETRY_SECONDS = 300;
const STRICT_RETRY = "validation: retried with strict";

/**
 * The SET list of the back-off transition shared by reap, release and a `retry` completion: QUEUED with
 * run_after = clock + 30 s * 2^attempts (attempts as stored) while attempts < max_attempts, else FAILED; the lease cleared.
 */
const backoffSet = (sql: Sql | TransactionSql, queuedMessage: ReturnType<Sql>, failedMessage: ReturnType<Sql>) => sql`
  state = case when attempts < max_attempts then 'QUEUED' else 'FAILED' end,
  run_after = case when attempts < max_attempts
    then clock_timestamp() + make_interval(secs => 30 * power(2, attempts)) else run_after end,
  error_message = case when attempts < max_attempts then ${queuedMessage} else ${failedMessage} end,
  locked_by = null, locked_until = null, updated_at = clock_timestamp()`;

/** RUNNING jobs whose lease expired -> QUEUED with back-off, or FAILED at max_attempts. One statement, its own transaction. */
export async function reap(ctx: AiCtx): Promise<{ requeued: number; failed: number }> {
  const { sql } = ctx;
  // skip locked: a job whose row a completion holds is left to that completion (its fence decides).
  const rows = await sql`with due as (
      select id from ai_jobs where state = 'RUNNING' and locked_until < clock_timestamp() order by id for update skip locked)
    update ai_jobs set ${backoffSet(sql, sql`'lease expired'`, sql`'lease expired after ' || attempts || ' attempts'`)}
    from due where ai_jobs.id = due.id
    returning ai_jobs.state`;
  const requeued = rows.filter((r) => r.state === "QUEUED").length;
  return { requeued, failed: rows.length - requeued };
}

/**
 * Claims the oldest runnable job the budget allows (spec 8.2, 8.5). At most 10 candidates, each in its own short
 * transaction, so the budget lock is never held across candidates.
 */
export async function claim(ctx: AiCtx, args: { workerId: string; filter: ClaimFilter }): Promise<ClaimResult> {
  const { sql } = ctx;
  const f = args.filter;
  const locales = f.locales?.map(normalizeLocale);
  const tried: number[] = [];
  for (let i = 0; i < MAX_CANDIDATES; i++) {
    const skip = [...(f.excludeIds ?? []), ...tried].map(String);
    // No lock and no deleted_at filter: a job on a deleted document is claimed and failed by the worker's pre-call check.
    const [cand] = (await sql`select j.id, d.collection from ai_jobs j join documents d on d.id = j.doc_id
      where j.state = 'QUEUED' and j.run_after <= clock_timestamp()
        and not (j.id = any(${skip}::bigint[]))
        ${f.collection === undefined ? sql`` : sql`and d.collection = ${f.collection}`}
        ${f.docIds === undefined ? sql`` : sql`and j.doc_id::text = any(${f.docIds.map((d) => d.toLowerCase())}::text[])`}
        ${locales === undefined ? sql`` : sql`and j.locale = any(${locales}::text[])`}
        ${f.maxEstimateMicros === undefined ? sql`` : sql`and j.cost_estimate_micros <= ${f.maxEstimateMicros}`}
      order by j.run_after, j.id
      limit 1`) as unknown as Array<{ id: string; collection: string } | undefined>;
    if (!cand) return { refused: "empty" };
    const id = Number(cand.id);

    const out = await sql.begin(async (tx): Promise<ClaimResult | null> => {
      const budgets = await lockBudgets(tx, ctx.ai, cand.collection);
      // run_after is re-checked: a concurrent claimer may have refused the job (and moved run_after) since the select.
      const [row] = await tx`select cost_estimate_micros from ai_jobs
        where id = ${id} and state = 'QUEUED' and run_after <= clock_timestamp()
        for update skip locked`;
      if (!row) return null;
      const estimate = Number(row.cost_estimate_micros);
      const over = budgets.find((b) => b.spentMicros + b.inFlightMicros + estimate > b.capMicros);
      if (over) {
        const reason = `budget_exhausted: ${over.scope} spent ${over.spentMicros} + in-flight ${over.inFlightMicros}`
          + ` + estimate ${estimate} > cap ${over.capMicros}`;
        await tx`update ai_jobs set error_message = ${reason},
            run_after = clock_timestamp() + make_interval(secs => ${BUDGET_RETRY_SECONDS}), updated_at = clock_timestamp()
          where id = ${id}`;
        return { refused: "budget", reason, jobId: id };
      }
      const lease = `${args.workerId}#${randomBytes(4).toString("hex")}`;
      const [updated] = (await tx`update ai_jobs set state = 'RUNNING', locked_by = ${lease},
          locked_until = clock_timestamp() + make_interval(secs => ${ctx.ai.leaseSeconds}), attempts = attempts + 1,
          error_message = null, updated_at = clock_timestamp()
        where id = ${id}
        returning *`) as unknown as Array<Omit<Row, "collection">>;
      return { job: toJobRow({ ...updated!, collection: cand.collection }), lease };
    });
    if (out) return out;
    tried.push(id);
  }
  return { refused: "empty" };
}

/**
 * A claimed job the worker could not even start (no provider call was made) goes back with back-off, or FAILS at
 * max_attempts. The attempt consumed at claim stays consumed. false when the fence (state, lease) fails.
 */
export async function release(ctx: AiCtx, jobId: number, lease: string, reason: string): Promise<"QUEUED" | "FAILED" | false> {
  const { sql } = ctx;
  const [r] = await sql`update ai_jobs
    set ${backoffSet(sql, sql`${reason}::text`, sql`${reason}::text || ' (after ' || attempts || ' attempts)'`)}
    where id = ${jobId} and state = 'RUNNING' and locked_by = ${lease}
    returning state`;
  return r ? (r.state as "QUEUED" | "FAILED") : false;
}

/** THE FENCE: extends the lease only while it is live and held by `lease`. An expired lease is never renewed. */
export async function renewLease(ctx: AiCtx, jobId: number, lease: string): Promise<boolean> {
  const { sql } = ctx;
  const r = await sql`update ai_jobs set locked_until = clock_timestamp() + make_interval(secs => ${ctx.ai.leaseSeconds}),
      updated_at = clock_timestamp()
    where id = ${jobId} and state = 'RUNNING' and locked_by = ${lease} and locked_until > clock_timestamp()`;
  return r.count === 1;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Records a finished job (spec 8.2): debit, the fence, the provenance rows and the transition in one transaction. When
 * that transaction throws, a cost-only fallback records the spend unless the first one did commit, then rethrows. When
 * the fallback throws too, the original error is rethrown with a `fallbackError` property (see `fallbackFailure`).
 */
export async function complete(ctx: AiCtx, job: JobRow, lease: string, c: Completion): Promise<CompleteResult> {
  const scopes = scopesFor(ctx.ai, job.collection);
  const total = c.calls.reduce((n, x) => n + x.costMicros, 0);
  const discard = (tx: TransactionSql, call: CallCost, reason: string) => writeDiscardedRow(tx, {
    docId: job.docId, locale: job.locale, jobId: job.id, callId: call.callId, modelId: call.modelId,
    promptVersion: call.promptVersion, promptTokens: call.promptTokens, completionTokens: call.completionTokens,
    costMicros: call.costMicros, discardReason: reason,
  });
  const finish = (tx: TransactionSql, state: "COMPLETED" | "FAILED" | "CANCELLED", message: string | null) =>
    tx`update ai_jobs set state = ${state}, error_message = ${message}, locked_by = null, locked_until = null,
        updated_at = clock_timestamp()
      where id = ${job.id}`;

  try {
    return await ctx.sql.begin(async (tx): Promise<CompleteResult> => {
      if (c.calls.length > 0) {
        await lockBudgets(tx, ctx.ai, job.collection);
        await debitBudgets(tx, scopes, total);
      }
      const fence = await tx`update ai_jobs set updated_at = clock_timestamp()
        where id = ${job.id} and state = 'RUNNING' and locked_by = ${lease} and locked_until > clock_timestamp()`;
      if (fence.count === 0) {
        for (const call of c.calls) await discard(tx, call, "lease lost");
        return "DISCARDED";
      }

      if (c.kind === "draft") {
        for (const call of c.calls) if (!call.kept) await discard(tx, call, STRICT_RETRY);
        const r = await recordAiDraft({ ...ctx, sql: tx as unknown as Sql }, {
          docId: job.docId, locale: job.locale, fields: c.fields, sourceVersion: job.sourceVersion,
          sourceHashes: c.sourceHashes, provenance: c.perField,
        });
        if ("version" in r) {
          await finish(tx, "COMPLETED", null);
          return "COMPLETED";
        }
        for (const call of c.calls) if (call.kept) await discard(tx, call, `cancelled: ${r.cancelled}`);
        await finish(tx, "CANCELLED", r.cancelled);
        return "CANCELLED";
      }

      // Every other kind: every call gets a discarded row, `kept` notwithstanding. An earlier rejected call was
      // retried with strict; any other call carries the kind's reason.
      const last = c.calls.length - 1;
      const reason = c.kind === "cancel" ? `cancelled: ${c.code}` : c.kind === "failed" ? `validation: ${c.reason}` : `provider: ${c.reason}`;
      for (const [i, call] of c.calls.entries()) {
        await discard(tx, call, c.kind !== "cancel" && !call.kept && i < last ? STRICT_RETRY : reason);
      }
      if (c.kind === "failed") {
        await finish(tx, "FAILED", c.reason);
        return "FAILED";
      }
      if (c.kind === "cancel") {
        await finish(tx, "CANCELLED", c.code);
        return "CANCELLED";
      }
      const [r] = await tx`update ai_jobs
        set ${backoffSet(tx, tx`${c.reason}::text`, tx`${c.reason}::text || ' (after ' || attempts || ' attempts)'`)}
        where id = ${job.id}
        returning state`;
      return r!.state as "QUEUED" | "FAILED";
    });
  } catch (err) {
    try {
      await recordSpendOnly(ctx, job, c.calls, scopes, total, discard, errorMessage(err));
    } catch (fallbackErr) {
      // The spend of these calls is now recorded nowhere: say so on the ORIGINAL error (its class is kept).
      attachFallbackFailure(err, { error: fallbackErr, message: errorMessage(fallbackErr), callIds: c.calls.map((x) => x.callId) });
    }
    throw err;
  }
}

/** Why the cost-only fallback failed, and the ids of the calls whose spend it could not record. */
export type FallbackFailure = { error: unknown; message: string; callIds: string[] };

/** Attaches `f` to `err` as the non-enumerable `fallbackError` property (a non-object error cannot carry it). */
function attachFallbackFailure(err: unknown, f: FallbackFailure): void {
  if ((typeof err !== "object" && typeof err !== "function") || err === null) return;
  try {
    Object.defineProperty(err, "fallbackError", { value: f, enumerable: false, configurable: true, writable: false });
  } catch { /* a frozen error object: the original still propagates */ }
}

/** The fallback failure `complete` attached to an error it rethrew, if any. */
export function fallbackFailure(err: unknown): FallbackFailure | undefined {
  if ((typeof err !== "object" && typeof err !== "function") || err === null) return undefined;
  return Object.hasOwn(err, "fallbackError") ? (err as { fallbackError: FallbackFailure }).fallbackError : undefined;
}

/**
 * The cost-only fallback. Without calls there is nothing to record (no budget row is created or locked). A row with one
 * of the call ids means the first transaction committed after all (an ambiguous commit): nothing is written. Otherwise,
 * debit and one `commit_failed:` row per call. The job is left RUNNING for the reaper either way.
 */
async function recordSpendOnly(
  ctx: AiCtx, job: JobRow, calls: CallCost[], scopes: string[], total: number,
  discard: (tx: TransactionSql, call: CallCost, reason: string) => Promise<void>, message: string,
): Promise<void> {
  if (calls.length === 0) return;
  await ctx.sql.begin(async (tx) => {
    // Budgets are locked BEFORE the ambiguity check: a first transaction whose COMMIT is still in flight holds these
    // row locks, so this waits for it, and the check (a fresh READ COMMITTED statement) then sees its rows. Checking
    // first could miss a commit that becomes visible just after, and debit and record the calls twice.
    await lockBudgets(tx, ctx.ai, job.collection);
    const [hit] = await tx`select 1 from content_provenance where call_id = any(${calls.map((x) => x.callId)}::uuid[]) limit 1`;
    if (hit) return;
    await debitBudgets(tx, scopes, total);
    for (const call of calls) await discard(tx, call, `commit_failed: ${message}`);
  });
}
