import { randomUUID } from "node:crypto";
import { NoObjectGeneratedError, NoOutputGeneratedError, Output, generateText, type LanguageModel } from "ai";
import type { AiProvenanceInput, Collection, DocumentRecord, Field } from "@mogging/core";
import { glossaryModeFor, type AiCtx, type ModelPrice } from "./config.js";
import type { CallCost } from "./claim.js";
import { jobContext } from "./context.js";
import { actualCostMicros, apportion, planRequests, type RequestPlan } from "./estimate.js";
import { outputSchema } from "./fields.js";
import type { JobRow } from "./jobs.js";
import { buildPrompt, maxTemplateTokens, type PromptVariant } from "./prompt.js";
import { prepareField, validateField, type GlossaryEntry, type PreparedField } from "./validate.js";

export type TranslateOutcome =
  | { ok: true; fields: Record<string, unknown>; perField: AiProvenanceInput[]; calls: CallCost[]; warnings: string[] }
  | { ok: false; kind: "failed"; reason: string; calls: CallCost[] }
  | { ok: false; kind: "retry"; reason: string; calls: CallCost[] }
  | { ok: false; kind: "cancel"; code: "SOURCE_MOVED" | "DRAFT_HUMAN"; calls: [] };

export type TranslateArgs = {
  job: JobRow; collection: Collection; doc: DocumentRecord;
  glossary: GlossaryEntry[]; model: { model: LanguageModel; modelId: string; price: ModelPrice };
  signalFor: () => AbortSignal; onCall?: (c: CallCost) => void; beforeCall?: () => Promise<boolean>;
};

const VARIANTS: readonly PromptVariant[] = ["standard", "strict"];

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const wireChars = (p: PreparedField): number => (JSON.stringify(p.wire) ?? "").length;

/**
 * Translates one claimed job with the model (spec 8.2 to 8.5). Never throws: a paid call is always in `calls`, so the
 * worker can hand every outcome to `complete`. Reads only ctx.ai and ctx.config, never the database.
 */
export async function translateJob(ctx: AiCtx, args: TranslateArgs): Promise<TranslateOutcome> {
  const calls: CallCost[] = [];
  const state: { unnotified?: CallCost } = {};
  try {
    return await run(ctx, args, calls, state);
  } catch (err) {
    if (state.unnotified) notify(args, state.unnotified);
    return { ok: false, kind: "retry", reason: errorMessage(err), calls };
  }
}

function notify(args: TranslateArgs, call: CallCost): void {
  try { args.onCall?.(call); } catch { /* a logging hook never decides the outcome */ }
}

async function run(
  ctx: AiCtx, args: TranslateArgs, calls: CallCost[], state: { unnotified?: CallCost },
): Promise<TranslateOutcome> {
  const { job, collection, doc } = args;
  const { model, modelId, price } = args.model;
  const sourceLocale = ctx.config.locales.source;
  const targetLocale = job.locale;

  // (a) the same checks recordAiDraft repeats under the lock, here before any spend
  if (doc.deletedAt !== null) return { ok: false, kind: "failed", reason: "document deleted", calls: [] };
  const source = doc.locales[sourceLocale]?.published ?? null;
  if (!source || source.version !== job.sourceVersion) return { ok: false, kind: "cancel", code: "SOURCE_MOVED", calls: [] };
  const target = doc.locales[targetLocale];
  if (target?.draft?.state === "DRAFT_HUMAN") return { ok: false, kind: "cancel", code: "DRAFT_HUMAN", calls: [] };

  // (b) the wire form of every field
  const prepared = new Map<string, { field: Field; prepared: PreparedField }>();
  try {
    for (const name of job.fieldPaths) {
      const field = Object.hasOwn(collection.fields, name) ? collection.fields[name] : undefined;
      if (!field) throw new Error(`unknown field "${name}"`);
      prepared.set(name, { field, prepared: prepareField(name, field, source.data[name]) });
    }
  } catch (err) {
    return { ok: false, kind: "failed", reason: `source: ${errorMessage(err)}`, calls: [] };
  }

  // Context: the same helper as the enqueue estimate (jobs.ts estimateJob), so the two cannot drift.
  const { siblings, shared, glossary, contextChars, glossaryChars } =
    jobContext(ctx.ai, collection, doc, targetLocale, job.fieldPaths, args.glossary);

  // (c) the requests
  const plan = planRequests({
    ai: ctx.ai, price, sourceLocale, targetLocale,
    fields: [...prepared.values()].map((p) => ({ name: p.prepared.field, wire: p.prepared.wire })),
    contextChars, glossaryChars, templateTokens: maxTemplateTokens(),
  });
  if ("tooLarge" in plan) {
    return { ok: false, kind: "failed", reason: `field "${plan.tooLarge}" exceeds the model context window`, calls: [] };
  }

  const glossaryMode = glossaryModeFor(ctx.ai, collection.name);
  const fields: Record<string, unknown> = {};
  const perField: AiProvenanceInput[] = [];
  const warnings: string[] = [];

  for (const request of plan.requests) {
    const translate = Object.fromEntries(request.fields.map((f) => [f, prepared.get(f)!.prepared.wire]));
    const schemaFields = Object.fromEntries(request.fields.map((f) => [f, prepared.get(f)!.field]));
    let lastRejections: string[] = [];
    let accepted = false;

    for (const variant of VARIANTS) {
      // The fence: a job cancelled or reaped since the claim is never paid for.
      let live: boolean;
      try { live = (await args.beforeCall?.()) ?? true; } catch (err) {
        return { ok: false, kind: "retry", reason: `lease check failed: ${errorMessage(err)}`, calls };
      }
      if (!live) return { ok: false, kind: "retry", reason: "lease check failed: lease lost before call", calls };

      const { system, user, promptVersion } = buildPrompt(variant, {
        sourceLocale, targetLocale, collection: collection.name, translate,
        siblings: request.noContext ? {} : siblings, shared: request.noContext ? {} : shared, glossary,
      });
      const callId = randomUUID();
      const callWarnings: string[] = [];
      const record = (
        usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined, providerCostUsd?: number,
      ): CallCost => {
        if (usage?.inputTokens === undefined) callWarnings.push("usage: inputTokens not reported");
        if (usage?.outputTokens === undefined) callWarnings.push("usage: outputTokens not reported");
        const tokens = { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens };
        const call: CallCost = {
          callId, modelId, promptVersion, promptTokens: tokens.inputTokens ?? 0, completionTokens: tokens.outputTokens ?? 0,
          costMicros: actualCostMicros(tokens, price, providerCostUsd), kept: true,
        };
        calls.push(call);
        state.unnotified = call;
        return call;
      };

      let call: CallCost;
      let output: { fields: Record<string, unknown> } | undefined;
      let rejections: string[] = [];
      try {
        const r = await generateText({
          model, output: Output.object({ schema: outputSchema(schemaFields) }), system, prompt: user,
          temperature: ctx.ai.temperature, maxRetries: 0, maxOutputTokens: request.maxOutputTokens,
          abortSignal: args.signalFor(),
        });
        // The paid call is recorded before its output is read.
        call = record(r.usage, providerCost(r.providerMetadata));
        try {
          output = r.output;
        } catch (err) {
          if (!NoOutputGeneratedError.isInstance(err)) throw err;
          rejections = ["output: NoOutputGeneratedError"];
        }
      } catch (err) {
        // generateText parses the structured output eagerly and rejects when it does not match the schema.
        if (!NoObjectGeneratedError.isInstance(err) || state.unnotified?.callId === callId) throw err;
        call = record(err.usage);
        rejections = [`output: NoObjectGeneratedError: ${err.message}`];
      }

      const verdicts = new Map<string, { value: unknown; warnings: string[] }>();
      if (output) {
        for (const name of request.fields) {
          const p = prepared.get(name)!;
          const v = validateField({
            prepared: p.prepared, field: p.field, draft: output.fields[name], glossary: args.glossary, glossaryMode,
          });
          if (v.ok) verdicts.set(name, { value: v.value, warnings: v.warnings });
          else rejections.push(...v.rejections);
        }
      }

      if (rejections.length > 0) {
        call.kept = false;
        call.discardReason = rejections[0]!.startsWith("output: ") ? rejections.join("; ") : `validation: ${rejections.join("; ")}`;
        warnings.push(...callWarnings);
        state.unnotified = undefined;
        notify(args, call);
        lastRejections = rejections;
        continue; // the strict variant over the SAME request, or the end of the loop
      }

      accept(request, call, verdicts, callWarnings);
      warnings.push(...callWarnings);
      state.unnotified = undefined;
      notify(args, call);
      accepted = true;
      break;
    }

    if (!accepted) return { ok: false, kind: "failed", reason: lastRejections.join("; "), calls };
  }

  // Job field order, whatever order the requests ran in.
  const order = new Map(job.fieldPaths.map((f, i) => [f, i]));
  perField.sort((a, b) => order.get(a.fieldPath)! - order.get(b.fieldPath)!);
  return {
    ok: true,
    fields: Object.fromEntries(job.fieldPaths.map((f) => [f, fields[f]])),
    perField, calls, warnings,
  };

  /** Stores an accepted request's values and one provenance input per field, apportioned by translate characters. */
  function accept(
    request: RequestPlan, call: CallCost, verdicts: Map<string, { value: unknown; warnings: string[] }>, callWarnings: string[],
  ): void {
    const shares = request.fields.map((f) => wireChars(prepared.get(f)!.prepared));
    const promptTokens = apportion(call.promptTokens, shares);
    const completionTokens = apportion(call.completionTokens, shares);
    const costMicros = apportion(call.costMicros, shares);
    request.fields.forEach((name, i) => {
      const v = verdicts.get(name)!;
      fields[name] = v.value;
      perField.push({
        fieldPath: name, modelId, promptVersion: call.promptVersion, promptTokens: promptTokens[i]!,
        completionTokens: completionTokens[i]!, costMicros: costMicros[i]!, jobId: job.id, callId: call.callId,
        warnings: [...callWarnings, ...v.warnings],
      });
    });
  }
}

/** OpenRouter's reported cost in USD (usage accounting on), when present and finite. */
function providerCost(metadata: unknown): number | undefined {
  const cost = (metadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}
