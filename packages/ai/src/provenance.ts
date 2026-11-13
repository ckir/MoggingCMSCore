import type { TransactionSql } from "postgres";
import { ValidationError, normalizeLocale, type Ctx } from "@mogging/core";

export type ProvenanceRow = {
  id: number; docId: string; locale: string; version: number | null; fieldPath: string | null; jobId: number | null;
  modelId: string; promptVersion: string; promptTokens: number; completionTokens: number; costMicros: number; edited: boolean;
  discarded: boolean; discardReason: string | null; warnings: string[]; acknowledgedWarnings: string[] | null; bulkId: string | null;
  supersededVersion: number | null; callId: string | null; approvedBy: string | null; approvedAt: Date | null; createdAt: Date;
};

type Row = {
  id: string; doc_id: string; locale: string; version: number | null; field_path: string | null; job_id: string | null;
  model_id: string; prompt_version: string; prompt_tokens: number; completion_tokens: number; cost_micros: string;
  edited: boolean; discarded: boolean; discard_reason: string | null; warnings: string[]; acknowledged_warnings: string[] | null;
  bulk_id: string | null; superseded_version: number | null; call_id: string | null; approved_by: string | null;
  approved_at: Date | null; created_at: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Checks an optional list limit: a positive integer, default 200, at most 1000. */
export function listLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer from 1 to ${MAX_LIMIT}, got ${limit}`);
  }
  return limit;
}

// bigint columns arrive as strings from postgres.js.
const toProvenanceRow = (r: Row): ProvenanceRow => ({
  id: Number(r.id), docId: r.doc_id, locale: r.locale, version: r.version, fieldPath: r.field_path,
  jobId: r.job_id === null ? null : Number(r.job_id), modelId: r.model_id, promptVersion: r.prompt_version,
  promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens, costMicros: Number(r.cost_micros), edited: r.edited,
  discarded: r.discarded, discardReason: r.discard_reason, warnings: [...r.warnings],
  acknowledgedWarnings: r.acknowledged_warnings === null ? null : [...r.acknowledged_warnings], bulkId: r.bulk_id,
  supersededVersion: r.superseded_version, callId: r.call_id, approvedBy: r.approved_by, approvedAt: r.approved_at,
  createdAt: r.created_at,
});

/**
 * Provenance rows ordered by id. Without `docId` it lists across documents, so an operator can see the
 * spend that produced no draft (`discardedOnly`) for the whole project. `afterId` is the cursor: only rows with a
 * greater id, so pass the last id of a page to read the next one. Not licence-guarded: a read.
 */
export async function listProvenance(
  ctx: Ctx, input: { docId?: string; locale?: string; discardedOnly?: boolean; limit?: number; afterId?: number },
): Promise<ProvenanceRow[]> {
  const limit = listLimit(input.limit);
  if (input.afterId !== undefined && !(Number.isSafeInteger(input.afterId) && input.afterId >= 0)) {
    throw new ValidationError(`afterId must be a non-negative integer, got ${input.afterId}`);
  }
  const locale = input.locale === undefined ? undefined : normalizeLocale(input.locale);
  if (input.docId !== undefined && !UUID.test(input.docId)) return [];
  const { sql } = ctx;
  const rows = (await sql`select * from content_provenance
    where true
      ${input.afterId === undefined ? sql`` : sql`and id > ${input.afterId}`}
      ${input.docId === undefined ? sql`` : sql`and doc_id = ${input.docId}`}
      ${locale === undefined ? sql`` : sql`and locale = ${locale}`}
      ${input.discardedOnly ? sql`and discarded` : sql``}
    order by id
    limit ${limit}`) as unknown as Row[];
  return rows.map(toProvenanceRow);
}

/** The record of a provider call whose result was never stored (spec 7.1, 8.2): no version, no field, discarded. */
export async function writeDiscardedRow(tx: TransactionSql, row: {
  docId: string; locale: string; jobId: number | null; callId: string; modelId: string;
  promptVersion: string; promptTokens: number; completionTokens: number; costMicros: number; discardReason: string;
}): Promise<void> {
  await tx`insert into content_provenance
      (doc_id, locale, version, field_path, call_id, job_id, model_id, prompt_version, prompt_tokens, completion_tokens,
       cost_micros, discarded, discard_reason)
    values (${row.docId}, ${row.locale}, null, null, ${row.callId}, ${row.jobId}, ${row.modelId}, ${row.promptVersion},
            ${row.promptTokens}, ${row.completionTokens}, ${row.costMicros}, true, ${row.discardReason})`;
}
