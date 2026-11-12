import { ValidationError, assertLicensed, normalizeLocale } from "@mogging/core";
import { usdToMicros, type AiCtx } from "./config.js";
import { enqueueStale, type EnqueueReport } from "./jobs.js";
import { runWorker, type WorkerReport } from "./worker.js";

export type CompileInput = {
  locales: string[]; budgetUsd: number; collection?: string; docIds?: string[]; log?: (line: string) => void;
};
export type CompileReport = { enqueue: EnqueueReport; worker: WorkerReport; pendingJobs: number };

/**
 * Spec 9.3's `compile`: queues every stale or missing translation in scope, then runs one worker pass over exactly that
 * scope with `budgetUsd` as the run budget. `pendingJobs` is what is still QUEUED in the scope afterwards (jobs over the
 * run budget or the monthly caps, and jobs backed off after an error). Licence-guarded; a `LicenceError` from the
 * worker rejects the call and the partial report is lost.
 */
export async function compile(ctx: AiCtx, input: CompileInput): Promise<CompileReport> {
  await assertLicensed(ctx);
  if (typeof input.budgetUsd !== "number" || !Number.isFinite(input.budgetUsd) || !(input.budgetUsd > 0)) {
    throw new ValidationError(`budgetUsd must be a positive number, got ${input.budgetUsd}`);
  }
  const enqueue = await enqueueStale(ctx, { locales: input.locales, collection: input.collection, docIds: input.docIds });
  const locales = [...new Set(input.locales.map(normalizeLocale))];
  const worker = await runWorker(ctx, {
    once: true,
    runBudgetMicros: usdToMicros(input.budgetUsd),
    filter: { collection: input.collection, docIds: input.docIds, locales },
    log: input.log,
  });

  // The same conditions as the worker's claim, without the run_after test: a backed-off job is still pending.
  const { sql } = ctx;
  const [row] = await sql`select count(*) as n from ai_jobs j join documents d on d.id = j.doc_id
    where j.state = 'QUEUED'
      ${input.collection === undefined ? sql`` : sql`and d.collection = ${input.collection}`}
      ${input.docIds === undefined ? sql`` : sql`and j.doc_id::text = any(${input.docIds.map((d) => d.toLowerCase())}::text[])`}
      and j.locale = any(${locales}::text[])`;
  return { enqueue, worker, pendingJobs: Number(row!.n) };
}
