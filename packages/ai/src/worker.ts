import { hostname } from "node:os";
import { LicenceError, NotFoundError, ValidationError, assertLicensed, getDocument, normalizeLocale } from "@mogging/core";
import { assertActor, rejectNul } from "./actor.js";
import type { AiCtx } from "./config.js";
import {
  claim, complete, fallbackFailure, reap, release, renewLease, type ClaimFilter, type Completion, type CompleteResult,
} from "./claim.js";
import { listGlossary } from "./glossary.js";
import { startLeaseKeeper } from "./leaseKeeper.js";
import type { JobRow } from "./jobs.js";
import { resolveModel } from "./providers.js";
import { translateJob, type TranslateOutcome } from "./translate.js";

export type WorkerOptions = { once: boolean; runBudgetMicros?: number; pollMs?: number; filter?: ClaimFilter; workerId?: string;
  log?: (line: string) => void; signal?: AbortSignal;                                           // signal ends a polling run at its next poll
  hooks?: { afterClaim?: (job: JobRow) => Promise<void>; beforeComplete?: (job: JobRow) => Promise<void> } };   // test windows: after the claim, before loading; and after the call, before complete
export type WorkerReport = { completed: number; failed: number; cancelled: number; discarded: number; requeued: number;
  errors: number; budgetRefusals: number; runBudgetStop: boolean; spentMicros: number };

const DEFAULT_POLL_MS = 2000;
const MAX_TIMEOUT_MS = 2147483647; // setTimeout takes a signed 32-bit delay; a larger one fires after 1 ms

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Sleeps `ms`, or less when `signal` aborts. Leaves no timer and no listener behind. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A translate outcome as the completion `complete` records (the source hashes of the drafted fields come from the doc). */
function toCompletion(outcome: TranslateOutcome, sourceHashes: Record<string, string>): Completion {
  if (outcome.ok) {
    const hashes = Object.fromEntries(Object.keys(outcome.fields).filter((f) => Object.hasOwn(sourceHashes, f)).map((f) => [f, sourceHashes[f]!]));
    return { kind: "draft", fields: outcome.fields, sourceHashes: hashes, calls: outcome.calls, perField: outcome.perField };
  }
  if (outcome.kind === "cancel") return { kind: "cancel", code: outcome.code, calls: outcome.calls };
  return { kind: outcome.kind, reason: outcome.reason, calls: outcome.calls };
}

/**
 * True when a runnable job matching `filter` exists that only the run budget's max-estimate filter keeps from the claim
 * (the same conditions as `claim`'s candidate select, with the estimate inverted).
 */
async function overRunBudget(ctx: AiCtx, filter: ClaimFilter, maxEstimateMicros: number): Promise<boolean> {
  const { sql } = ctx;
  const locales = filter.locales?.map(normalizeLocale);
  const [hit] = await sql`select 1 from ai_jobs j join documents d on d.id = j.doc_id
    where j.state = 'QUEUED' and j.run_after <= clock_timestamp()
      and not (j.id = any(${(filter.excludeIds ?? []).map(String)}::bigint[]))
      ${filter.collection === undefined ? sql`` : sql`and d.collection = ${filter.collection}`}
      ${filter.docIds === undefined ? sql`` : sql`and j.doc_id::text = any(${filter.docIds.map((d) => d.toLowerCase())}::text[])`}
      ${locales === undefined ? sql`` : sql`and j.locale = any(${locales}::text[])`}
      and j.cost_estimate_micros > ${maxEstimateMicros}
    limit 1`;
  return hit !== undefined;
}

/**
 * The translation worker (spec 8.2, 8.5): claims jobs within the budgets, renews each lease while its provider calls
 * run, and records every outcome with `complete`. Licence-guarded; every model the filter can reach is resolved before
 * the first claim, so a missing key or an unknown model fails the run with nothing claimed.
 */
export async function runWorker(ctx: AiCtx, options: WorkerOptions): Promise<WorkerReport> {
  const { pollMs: requestedPollMs } = options;
  if (requestedPollMs !== undefined && !(Number.isSafeInteger(requestedPollMs) && requestedPollMs >= 1 && requestedPollMs <= MAX_TIMEOUT_MS)) {
    throw new ValidationError(`pollMs must be an integer from 1 to ${MAX_TIMEOUT_MS}, got ${requestedPollMs}`);
  }
  await assertLicensed(ctx);
  // Always, not only when the lease is derived from it: complete() persists ctx.actor through recordAiDraft after a
  // paid provider call, so a bad actor must stop the run before any job is claimed.
  assertActor(ctx);
  if (options.workerId !== undefined) rejectNul(options.workerId, "workerId");
  const report: WorkerReport = {
    completed: 0, failed: 0, cancelled: 0, discarded: 0, requeued: 0, errors: 0, budgetRefusals: 0, runBudgetStop: false,
    spentMicros: 0,
  };
  const baseFilter = options.filter ?? {};
  const reachable = baseFilter.collection !== undefined ? [baseFilter.collection] : ctx.config.collections.map((c) => c.name);
  const models = new Map(reachable.map((c) => [c, resolveModel(ctx.ai, c)]));
  // A lease names a process: <actor>@<hostname>#<pid>; claim appends #<8 hex> per claim.
  const workerId = options.workerId ?? `${ctx.actor}@${hostname()}#${process.pid}`;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const log = options.log ?? (() => undefined);
  const excludeIds = new Set<number>(baseFilter.excludeIds ?? []);

  const count = (r: CompleteResult | "QUEUED" | "FAILED") => {
    if (r === "COMPLETED") report.completed += 1;
    else if (r === "FAILED") report.failed += 1;
    else if (r === "CANCELLED") report.cancelled += 1;
    else if (r === "DISCARDED") report.discarded += 1;
    else report.requeued += 1;
  };

  while (!options.signal?.aborted) {
    await reap(ctx); // its counts are other runs' jobs, not this run's
    const filter: ClaimFilter = { ...baseFilter, excludeIds: [...excludeIds] };
    if (options.runBudgetMicros !== undefined) filter.maxEstimateMicros = options.runBudgetMicros - report.spentMicros;
    const claimed = await claim(ctx, { workerId, filter });

    if ("refused" in claimed) {
      if (claimed.refused === "budget") {
        report.budgetRefusals += 1;
        if (claimed.jobId !== undefined) excludeIds.add(claimed.jobId);
        continue; // another scope may still have budget
      }
      if (filter.maxEstimateMicros !== undefined && await overRunBudget(ctx, filter, filter.maxEstimateMicros)) {
        report.runBudgetStop = true;
        break;
      }
      if (options.once) break;
      excludeIds.clear(); // a refused or released job is tried again once its run_after has passed
      for (const id of baseFilter.excludeIds ?? []) excludeIds.add(id);
      await sleep(pollMs, options.signal);
      continue;
    }

    const { job, lease } = claimed;
    // (1) Load, before any provider call. A throw releases the job with back-off.
    let loaded: { doc: NonNullable<Awaited<ReturnType<typeof getDocument>>>; glossary: Awaited<ReturnType<typeof listGlossary>>;
      model: ReturnType<typeof resolveModel> };
    try {
      await options.hooks?.afterClaim?.(job);
      const doc = await getDocument(ctx, { collection: job.collection, docId: job.docId });
      if (!doc) throw new NotFoundError(`Document "${job.docId}" not found`);
      const glossary = await listGlossary(ctx, { sourceLocale: ctx.config.locales.source, targetLocale: job.locale });
      const model = models.get(job.collection) ?? resolveModel(ctx.ai, job.collection);
      loaded = { doc, glossary, model };
    } catch (err) {
      report.errors += 1;
      excludeIds.add(job.id);
      let released: "QUEUED" | "FAILED" | false = false;
      try {
        released = await release(ctx, job.id, lease, errorMessage(err));
        if (released) count(released);
      } catch (releaseErr) {
        log(`job=${job.id} doc=${job.docId} locale=${job.locale} release failed: ${errorMessage(releaseErr)}`);
      }
      log(`job=${job.id} doc=${job.docId} locale=${job.locale} model=${models.get(job.collection)?.modelId ?? "-"}`
        + ` tokens=0/0 cost_usd=0.000000 outcome=${released || "ERROR"}`);
      log(`job=${job.id} error=${errorMessage(err)}`);
      if (err instanceof LicenceError) throw err;
      continue;
    }

    const collection = ctx.config.collections.find((c) => c.name === job.collection)!;
    const sourceHashes = loaded.doc.locales[ctx.config.locales.source]?.published?.sourceHashes ?? {};

    // (2) The call, with the lease renewed every third of its length. A renewal the fence refuses aborts the call in
    // flight; one that throws is retried, and only a lease about to lapse without a success aborts (leaseKeeper.ts).
    const leaseLost = new AbortController();
    const keeper = startLeaseKeeper({
      leaseMs: ctx.ai.leaseSeconds * 1000, renew: () => renewLease(ctx, job.id, lease), onLost: () => leaseLost.abort(),
    });
    let outcome: TranslateOutcome;
    try {
      outcome = await translateJob(ctx, {
        job, collection, doc: loaded.doc, glossary: loaded.glossary, model: loaded.model,
        signalFor: () => AbortSignal.any([AbortSignal.timeout(ctx.ai.providerTimeoutSeconds * 1000), leaseLost.signal]),
        beforeCall: () => renewLease(ctx, job.id, lease),
      });
    } finally {
      // Before complete: no renewal can land after the completion commit, and no timer outlives the run.
      await keeper.stop();
    }

    const callMicros = outcome.calls.reduce((n, c) => n + c.costMicros, 0);
    report.spentMicros += callMicros; // a call that happened is spend, whatever complete records
    const tokensIn = outcome.calls.reduce((n, c) => n + c.promptTokens, 0);
    const tokensOut = outcome.calls.reduce((n, c) => n + c.completionTokens, 0);
    const line = (result: string) => `job=${job.id} doc=${job.docId} locale=${job.locale} model=${loaded.model.modelId}`
      + ` tokens=${tokensIn}/${tokensOut} cost_usd=${(callMicros / 1e6).toFixed(6)} outcome=${result}`;

    // (3) The completion. A throw (after complete's own cost-only fallback) leaves the job RUNNING for the reaper.
    try {
      await options.hooks?.beforeComplete?.(job);
      const result = await complete(ctx, job, lease, toCompletion(outcome, sourceHashes));
      count(result);
      log(line(result));
    } catch (err) {
      report.errors += 1;
      excludeIds.add(job.id);
      log(line("ERROR"));
      const fallback = fallbackFailure(err);
      log(`job=${job.id} error=${errorMessage(err)}`
        + (fallback ? ` fallback_failed=${fallback.message} calls=${fallback.callIds.join(",")}` : ""));
      if (err instanceof LicenceError) throw err;
    }
  }
  return report;
}
