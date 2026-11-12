import { expect, test } from "vitest";
import * as api from "../src/index.js";
import * as pkg from "@mogging/ai";
import type {
  AiConfig, AiConfigInput, AiCtx, BudgetRow, EnqueueInput, EnqueueReport, Estimate, GlossaryMode, JobRow, ModelPrice,
  ProvenanceRow, ProviderConfig, RequestPlan, Skipped, WorkerOptions, WorkerReport,
} from "../src/index.js";

// THE CONTRACT: the complete runtime surface of @mogging/ai. Every task that adds an export updates this
// list in the same commit.
const FUNCTIONS = [
  "defineAiConfig", "usdToMicros", "priceFor", "glossaryModeFor", "estimateRequest", "planRequests",
  "listGlossary", "upsertGlossary", "getBudgets", "enqueueStale", "listJobs", "retryJobs", "cancelJobs", "listProvenance",
  "runWorker",
];
const EXPECTED = [...FUNCTIONS].sort();

for (const [label, mod] of [["relative", api], ["package self-reference", pkg]] as const) {
  test(`${label}: every function is exported as a function`, () => {
    for (const name of FUNCTIONS) expect(typeof (mod as Record<string, unknown>)[name], name).toBe("function");
  });

  test(`${label}: the runtime surface is exactly the contract`, () => {
    expect(Object.keys(mod).sort()).toEqual(EXPECTED);
  });
}

test("the listed types are importable and usable", () => {
  const price: ModelPrice = { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 8192 };
  const provider: ProviderConfig = { kind: "openrouter" };
  const mode: GlossaryMode = "warn";
  const input: AiConfigInput = {
    provider, models: { translate: "m" }, prices: { m: price }, budgets: { monthlyCapUsd: 1 },
  };
  const cfg: AiConfig = api.defineAiConfig(input);
  const shape: Pick<AiCtx, "ai"> = { ai: cfg };
  expect([shape.ai.glossary, mode]).toEqual(["warn", "warn"]);
  const estimate: Estimate = api.estimateRequest({
    sourceLocale: "en", targetLocale: "de", translateChars: 3, contextChars: 0, templateTokens: 0, price,
  });
  const planned = api.planRequests({
    ai: cfg, price, sourceLocale: "en", targetLocale: "de", fields: [{ name: "t", wire: "x" }],
    contextChars: 0, glossaryChars: 0, templateTokens: 0,
  });
  const plans: RequestPlan[] = "requests" in planned ? planned.requests : [];
  expect([estimate.inputTokens, plans.map((p) => p.fields)]).toEqual([1, [["t"]]]);
  const row: BudgetRow = { scope: "global", periodStart: "2026-11-01", capMicros: 1, spentMicros: 0, inFlightMicros: 0 };
  expect(Object.keys(row)).toEqual(["scope", "periodStart", "capMicros", "spentMicros", "inFlightMicros"]);
  const enqueue: EnqueueInput = { locales: ["de"], collection: "posts", docIds: [] };
  const skip: Skipped = { docId: "d", locale: "de", field: null, reason: "human draft pending" };
  const report: EnqueueReport = { enqueued: 0, duplicates: 0, cancelledStale: 0, estimateMicros: 0, skipped: [skip] };
  const at = new Date(0);
  const job: JobRow = {
    id: 1, docId: "d", collection: "posts", locale: "de", fieldPaths: ["title"], sourceVersion: 1, state: "QUEUED",
    attempts: 0, maxAttempts: 3, runAfter: at, lockedUntil: null, lockedBy: null, costEstimateMicros: 0, budgetScope: "global",
    errorMessage: null, createdAt: at, updatedAt: at,
  };
  const prov: ProvenanceRow = {
    id: 1, docId: "d", locale: "de", version: null, fieldPath: null, jobId: null, modelId: "m", promptVersion: "p",
    promptTokens: 0, completionTokens: 0, costMicros: 0, edited: false, discarded: true, discardReason: "x", warnings: [],
    acknowledgedWarnings: null, bulkId: null, supersededVersion: null, callId: null, approvedBy: null, approvedAt: null,
    createdAt: at,
  };
  expect([enqueue.locales, report.skipped[0]!.reason, job.fieldPaths, prov.discarded])
    .toEqual([["de"], "human draft pending", ["title"], true]);
  const options: WorkerOptions = {
    once: true, runBudgetMicros: 1, pollMs: 1, filter: { collection: "posts" }, workerId: "w", log: () => undefined,
    signal: new AbortController().signal, hooks: { afterClaim: async () => undefined, beforeComplete: async () => undefined },
  };
  const worker: WorkerReport = {
    completed: 0, failed: 0, cancelled: 0, discarded: 0, requeued: 0, errors: 0, budgetRefusals: 0, runBudgetStop: false,
    spentMicros: 0,
  };
  expect([options.once, Object.keys(worker)]).toEqual([true, [
    "completed", "failed", "cancelled", "discarded", "requeued", "errors", "budgetRefusals", "runBudgetStop", "spentMicros",
  ]]);
});
