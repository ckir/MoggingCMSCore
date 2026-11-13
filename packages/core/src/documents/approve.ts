import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Ctx } from "../ctx.js";
import { ConflictError, NotFoundError, NotPublishableError, ValidationError } from "../errors.js";
import { assertLicensed } from "../licence/guard.js";
import { normalizeLocale } from "../schema/locale.js";
import { hashValue } from "../values/hash.js";
import { normalizeValue, stripTopLevelNulls } from "../values/normalize.js";

type Json = Parameters<Sql["json"]>[0];

export type ApproveInput = {
  docId: string;
  locale: string;
  edits?: Record<string, unknown>;
  rejectFields?: string[];
  acknowledgedWarnings?: string[];
  bulkId?: string;
  /** The draft head version the reviewer saw; any other head version is a ConflictError (as saveDraft's). */
  expectedVersion?: number;
};
export type ApproveCleanInput = { collection?: string; locale?: string };
export type ApproveCleanResult = {
  approved: number;
  skipped: Array<{ docId: string; locale: string; reason: string }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveLocale(ctx: Ctx, input: string): string {
  const { config } = ctx;
  if (input === "shared") throw new ValidationError("AI drafts are translations: locale cannot be \"shared\"");
  const locale = normalizeLocale(input);
  const declared = new Set([config.locales.source, ...Object.keys(config.locales.chains)]);
  if (!declared.has(locale)) throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  if (locale === config.locales.source) {
    throw new ValidationError(`Locale "${locale}" is the source locale: AI drafts are translations`);
  }
  return locale;
}

type Outcome = { version: number } | { skipped: string };

/** Unguarded: its only callers, `approve` and `approveClean`, each call `assertLicensed` first. */
async function approveImpl(ctx: Ctx, input: ApproveInput, cleanOnly: boolean): Promise<Outcome> {
  const { config, sql, actor } = ctx;
  const locale = resolveLocale(ctx, input.locale);
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);
  if (input.bulkId !== undefined && !UUID.test(input.bulkId)) throw new ValidationError("bulkId must be a UUID");

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

  const edits: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.edits ?? {})) {
    const field = lookup(key, "edits");
    edits[key] = value === null ? null : normalizeValue(field, value, key);
  }
  const rejected = new Set<string>();
  for (const key of input.rejectFields ?? []) {
    lookup(key, "rejectFields");
    if (Object.hasOwn(edits, key)) throw new ValidationError(`${collection.name}.${key}: cannot be both edited and rejected`);
    rejected.add(key);
  }

  return sql.begin(async (tx): Promise<Outcome> => {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
    const [{ t }] = (await tx`select clock_timestamp() as t`) as unknown as [{ t: Date }];
    const label = `${input.docId}/${locale}`;

    const [ai] = await tx`select version, state, data, source_hashes, field_warnings from document_localized
      where doc_id = ${input.docId} and locale = ${locale} and is_head_draft`;
    if (!ai) throw new NotPublishableError(`${label} has no draft head to approve`);
    if (ai.state !== "DRAFT_AI") {
      throw new NotPublishableError(`Draft head of ${label} (state ${String(ai.state)}) is not a DRAFT_AI`);
    }
    const aiVersion = ai.version as number;
    if (input.expectedVersion !== undefined && input.expectedVersion !== aiVersion) {
      throw new ConflictError(
        `Expected draft version ${input.expectedVersion} of ${label} but the head is ${aiVersion}`,
      );
    }

    // D-warn (spec 8.4): the draft's distinct warning texts, from its own row (D-fwarn), must be acknowledged
    // exactly, as a set. Fields this call rejects or edits still count, as `review show` lists them.
    const warned = new Set(
      Object.values((ai.field_warnings ?? {}) as Record<string, string[]>).flat().filter((w) => w !== ""),
    );
    if (cleanOnly && warned.size > 0) return { skipped: "has warnings" };
    const acked = new Set(input.acknowledgedWarnings ?? []);
    const missing = [...warned].filter((w) => !acked.has(w));
    if (missing.length > 0) {
      throw new ValidationError(`${label} has ${warned.size} warning(s) not acknowledged: ${missing.join(" | ")}`);
    }
    const unknown = [...acked].filter((w) => !warned.has(w));
    if (unknown.length > 0) {
      throw new ValidationError(`${label} acknowledges unknown warnings: ${unknown.join(" | ")}`);
    }

    // Rows of the AI version are matched by (doc_id, locale, version). Discarded-cost rows have version null.
    const rows = await tx`select * from content_provenance
      where doc_id = ${input.docId} and locale = ${locale} and version = ${aiVersion} order by id`;

    const [pub] = await tx`select data, source_hashes from document_localized
      where doc_id = ${input.docId} and locale = ${locale} and is_head_published`;
    const pubData = (pub?.data ?? {}) as Record<string, unknown>;
    const pubHashes = (pub?.source_hashes ?? {}) as Record<string, string>;

    const data: Record<string, unknown> = { ...(ai.data as Record<string, unknown>) };
    const hashes: Record<string, string> = { ...(ai.source_hashes as Record<string, string>) };
    for (const key of rejected) {
      if (Object.hasOwn(pubData, key)) data[key] = pubData[key];
      else delete data[key];
      if (Object.hasOwn(pubHashes, key)) hashes[key] = pubHashes[key]!;
      else delete hashes[key];
    }
    // A reviewer edit asserts "in sync with the source as of now" (spec 6.4), as saveDraft does.
    const [srcHead] = await tx`select data from document_localized
      where doc_id = ${input.docId} and locale = ${config.locales.source} and is_head_published`;
    const srcData = (srcHead?.data ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(edits)) {
      data[key] = value;
      if (value !== null && Object.hasOwn(srcData, key)) hashes[key] = hashValue(srcData[key]);
      else delete hashes[key];
    }
    const finalData = stripTopLevelNulls(data);

    const [heads] = await tx`select coalesce(max(version), 0) as max_version from document_localized
      where doc_id = ${input.docId} and locale = ${locale}`;
    const version = (heads!.max_version as number) + 1;

    await tx`update document_localized set is_head_draft = false
      where doc_id = ${input.docId} and locale = ${locale} and is_head_draft`;
    // An acknowledged warning is never demanded again for that text: the APPROVED row carries none (D-fwarn).
    await tx`insert into document_localized
        (doc_id, locale, version, state, data, source_hashes, field_warnings, is_head_draft, created_at, created_by)
      values (${input.docId}, ${locale}, ${version}, 'APPROVED', ${tx.json(finalData as Json)},
              ${tx.json(hashes as Json)}, '{}'::jsonb, true, ${t}, ${actor})`;

    const ack = input.acknowledgedWarnings === undefined ? null : input.acknowledgedWarnings;
    for (const r of rows) {
      const path = r.field_path as string | null;
      const isRejected = path !== null && rejected.has(path);
      const isEdited = path !== null && Object.hasOwn(edits, path);
      await tx`insert into content_provenance
          (doc_id, locale, version, field_path, superseded_version, call_id, job_id, model_id, prompt_version,
           prompt_tokens, completion_tokens, cost_micros, edited, discarded, discard_reason, warnings,
           acknowledged_warnings, bulk_id, approved_by, approved_at, created_at)
        values (${input.docId}, ${locale}, ${version}, ${path}, ${r.superseded_version as number | null},
                ${r.call_id as string | null}, ${r.job_id as number | null},
                ${r.model_id as string}, ${r.prompt_version as string}, 0,
                0, 0, ${isEdited},
                ${isRejected}, ${isRejected ? "rejected by reviewer" : null},
                ${r.warnings as string[]}, ${ack}, ${input.bulkId ?? null}, ${actor}, ${t}, ${t})`;
    }
    if (rows.length === 0 && warned.size > 0) {
      // An AI version with no provenance rows (legal) still records who acknowledged which warnings (spec 8.4).
      await tx`insert into content_provenance
          (doc_id, locale, version, field_path, job_id, model_id, prompt_version, prompt_tokens,
           completion_tokens, cost_micros, warnings, acknowledged_warnings, bulk_id, approved_by, approved_at, created_at)
        values (${input.docId}, ${locale}, ${version}, null, null, 'human:approve', '', 0, 0, 0,
                ${[...warned]}, ${[...acked]}, ${input.bulkId ?? null}, ${actor}, ${t}, ${t})`;
    }
    if (cleanOnly) {
      // Bulk-approval marker (spec 8.6): one row per approved draft; consumers count rows per bulk_id.
      await tx`insert into content_provenance
          (doc_id, locale, version, field_path, job_id, model_id, prompt_version, prompt_tokens,
           completion_tokens, cost_micros, bulk_id, approved_by, approved_at, created_at)
        values (${input.docId}, ${locale}, ${version}, null, null, 'human:bulk-approve', '', 0, 0, 0,
                ${input.bulkId ?? null}, ${actor}, ${t}, ${t})`;
    }
    return { version };
  });
}

/** Approves the DRAFT_AI head of (doc, locale) into a new APPROVED draft head (spec 6.3). */
export async function approve(ctx: Ctx, input: ApproveInput): Promise<{ version: number }> {
  await assertLicensed(ctx);
  const out = await approveImpl(ctx, input, false);
  if ("skipped" in out) throw new Error("unreachable"); // cleanOnly=false never skips
  return out;
}

/** Bulk path (spec 8.6): approves every warning-free DRAFT_AI head in scope under one shared bulkId. */
export async function approveClean(ctx: Ctx, input: ApproveCleanInput = {}): Promise<ApproveCleanResult> {
  await assertLicensed(ctx); // once per bulk call, before the scan; approveImpl itself is unguarded
  const { config, sql } = ctx;
  const locale = input.locale === undefined ? undefined : resolveLocale(ctx, input.locale);
  if (input.collection !== undefined && !config.collections.some((c) => c.name === input.collection)) {
    throw new ValidationError(`Unknown collection "${input.collection}"`);
  }
  const bulkId = randomUUID();
  const candidates = await sql`select d.doc_id, d.locale from document_localized d
    join documents x on x.id = d.doc_id
    where d.is_head_draft and d.state = 'DRAFT_AI' and x.deleted_at is null
      ${input.collection === undefined ? sql`` : sql`and x.collection = ${input.collection}`}
      ${locale === undefined ? sql`` : sql`and d.locale = ${locale}`}
    order by d.doc_id, d.locale`;

  const result: ApproveCleanResult = { approved: 0, skipped: [] };
  for (const c of candidates) {
    const docId = c.doc_id as string;
    const loc = c.locale as string;
    try {
      // The warnings check re-runs inside the approval transaction, under the document lock.
      const out = await approveImpl(ctx, { docId, locale: loc, bulkId }, true);
      if ("skipped" in out) result.skipped.push({ docId, locale: loc, reason: out.skipped });
      else result.approved++;
    } catch (e) {
      // The head changed between the scan and the lock (a human saved over it, or it was approved meanwhile).
      if (e instanceof NotPublishableError) result.skipped.push({ docId, locale: loc, reason: "no longer a DRAFT_AI head" });
      else throw e;
    }
  }
  return result;
}
