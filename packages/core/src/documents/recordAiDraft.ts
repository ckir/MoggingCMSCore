import type { Sql } from "postgres";
import type { Ctx } from "../ctx.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { assertLicensed } from "../licence/guard.js";
import { normalizeLocale } from "../schema/locale.js";
import { normalizeValue, stripTopLevelNulls } from "../values/normalize.js";

type Json = Parameters<Sql["json"]>[0];

export type AiProvenanceInput = {
  fieldPath: string;
  modelId: string;
  promptVersion: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  jobId?: number;
  warnings?: string[];
};

export type RecordAiDraftInput = {
  docId: string;
  locale: string;
  fields: Record<string, unknown>;
  sourceVersion: number;
  sourceHashes: Record<string, string>;
  provenance: AiProvenanceInput[];
};

export type RecordAiDraftResult = { version: number } | { cancelled: "DRAFT_HUMAN" | "SOURCE_MOVED" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records an AI-produced draft for a non-source locale (spec 8.1). Serializes with saveDraft through the
 * `documents` row lock. Version allocation and head clearing are duplicated from saveDraft.ts on purpose.
 */
export async function recordAiDraft(ctx: Ctx, input: RecordAiDraftInput): Promise<RecordAiDraftResult> {
  await assertLicensed(ctx);
  const { config, sql, actor } = ctx;
  if (input.locale === "shared") throw new ValidationError("AI drafts are translations: locale cannot be \"shared\"");
  const locale = normalizeLocale(input.locale);
  const declared = new Set([config.locales.source, ...Object.keys(config.locales.chains)]);
  if (!declared.has(locale)) throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  if (locale === config.locales.source) {
    throw new ValidationError(`Locale "${locale}" is the source locale: AI drafts are translations`);
  }
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);

  const [docProbe] = await sql`select collection from documents where id = ${input.docId} and deleted_at is null`;
  if (!docProbe) throw new NotFoundError(`Document "${input.docId}" not found`);
  const collection = config.collections.find((c) => c.name === docProbe.collection);
  if (!collection) throw new NotFoundError(`Unknown collection "${String(docProbe.collection)}"`);

  const lookup = (key: string, where: string) => {
    const field = Object.hasOwn(collection.fields, key) ? collection.fields[key] : undefined;
    if (!field) throw new ValidationError(`${collection.name}.${key}: undeclared field (${where})`);
    if (!field.localized) throw new ValidationError(`${collection.name}.${key}: shared field cannot be AI-drafted`);
    return field;
  };

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    const field = lookup(key, "fields");
    normalized[key] = value === null ? null : normalizeValue(field, value, key);
  }
  for (const p of input.provenance) lookup(p.fieldPath, "provenance");

  return sql.begin(async (tx): Promise<RecordAiDraftResult> => {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
    // One clock reading after the lock: now() would be the transaction start and could precede a competitor's writes.
    const [{ t }] = (await tx`select clock_timestamp() as t`) as unknown as [{ t: Date }];

    const [src] = await tx`select version from document_localized
      where doc_id = ${input.docId} and locale = ${config.locales.source} and is_head_published`;
    if (!src || src.version !== input.sourceVersion) return { cancelled: "SOURCE_MOVED" };

    // Base = draft head, else published head, else the latest row by version in any state (e.g. after
    // unpublish), else none. Read under the documents lock before any head flag is cleared.
    type Base = { state: string; is_head_draft: boolean; data: Record<string, unknown>; source_hashes: Record<string, string> };
    const [base] = (await tx`select state, is_head_draft, data, source_hashes from document_localized
      where doc_id = ${input.docId} and locale = ${locale}
      order by is_head_draft desc, is_head_published desc, version desc limit 1`) as unknown as Array<Base | undefined>;
    if (base && base.is_head_draft && base.state === "DRAFT_HUMAN") return { cancelled: "DRAFT_HUMAN" };

    const data: Record<string, unknown> = stripTopLevelNulls({ ...(base?.data ?? {}), ...normalized });
    const hashes: Record<string, string> = { ...(base?.source_hashes ?? {}) };
    for (const key of Object.keys(normalized)) {
      if (normalized[key] === null) delete hashes[key];
      else if (Object.hasOwn(input.sourceHashes, key)) hashes[key] = input.sourceHashes[key]!;
    }

    const [heads] = await tx`select coalesce(max(version), 0) as max_version from document_localized
      where doc_id = ${input.docId} and locale = ${locale}`;
    const version = (heads!.max_version as number) + 1;

    await tx`update document_localized set is_head_draft = false
      where doc_id = ${input.docId} and locale = ${locale} and is_head_draft`;
    await tx`insert into document_localized
        (doc_id, locale, version, state, data, source_hashes, is_head_draft, created_at, created_by)
      values (${input.docId}, ${locale}, ${version}, 'DRAFT_AI', ${tx.json(data as Json)},
              ${tx.json(hashes as Json)}, true, ${t}, ${actor})`;

    for (const p of input.provenance) {
      await tx`insert into content_provenance
          (doc_id, locale, version, field_path, job_id, model_id, prompt_version, prompt_tokens,
           completion_tokens, cost_micros, warnings, created_at)
        values (${input.docId}, ${locale}, ${version}, ${p.fieldPath}, ${p.jobId ?? null}, ${p.modelId},
                ${p.promptVersion}, ${p.promptTokens}, ${p.completionTokens}, ${p.costMicros},
                ${p.warnings ?? []}, ${t})`;
    }
    return { version };
  });
}
