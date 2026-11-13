import type { Ctx } from "../ctx.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { normalizeLocale } from "../schema/locale.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = ["DRAFT_AI", "APPROVED", "DRAFT_HUMAN"] as const;
const MAX_LIMIT = 200;

export type DraftHead = {
  docId: string;
  collection: string;
  slug: string | null;
  locale: string;
  version: number;
  state: string;
  createdAt: Date;
  createdBy: string;
  warningCount: number;
};

export type ReviewField = {
  path: string;
  source: unknown;
  previous: unknown;
  previousFrom: "superseded" | "published" | null;
  draft: unknown;
  warnings: string[];
  edited: boolean;
  sourceChanged: boolean;
};

export type DraftReview = {
  docId: string;
  collection: string;
  slug: string | null;
  locale: string;
  version: number;
  state: string;
  sourceLocale: string;
  sourceVersion: number | null;
  supersededVersion: number | null;
  fields: ReviewField[];
};

type FieldWarnings = Record<string, string[]>;

const distinctWarnings = (fw: unknown): number => new Set(Object.values((fw ?? {}) as FieldWarnings).flat()).size;

/**
 * Draft heads (DRAFT_AI, APPROVED, DRAFT_HUMAN) of live documents, localized and shared, in keyset order on
 * (doc_id, locale). `after` is the opaque cursor "<docId>:<locale>" of the last item seen. Unguarded read.
 */
export async function listDraftHeads(
  ctx: Ctx,
  input: { state?: "DRAFT_AI" | "APPROVED" | "DRAFT_HUMAN"; collection?: string; locale?: string; limit?: number; after?: string } = {},
): Promise<{ items: DraftHead[]; next: string | null }> {
  const { sql, config } = ctx;
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  if (input.state !== undefined && !STATES.includes(input.state)) {
    throw new ValidationError(`state must be one of ${STATES.join(", ")}`);
  }
  if (input.collection !== undefined && !config.collections.some((c) => c.name === input.collection)) {
    throw new ValidationError(`Unknown collection "${input.collection}"`);
  }
  const locale = input.locale === undefined ? undefined : input.locale === "shared" ? "shared" : normalizeLocale(input.locale);

  const stateFrag = input.state === undefined ? sql`` : sql`and h.state = ${input.state}`;
  const collectionFrag = input.collection === undefined ? sql`` : sql`and h.collection = ${input.collection}`;
  const localeFrag = locale === undefined ? sql`` : sql`and h.locale = ${locale}`;
  let afterFrag = sql``;
  if (input.after !== undefined) {
    const cut = input.after.indexOf(":");
    const docId = input.after.slice(0, cut);
    const afterLocale = input.after.slice(cut + 1);
    if (cut < 0 || !UUID.test(docId) || afterLocale === "") throw new ValidationError(`Malformed cursor "${input.after}"`);
    afterFrag = sql`and (h.doc_id, h.locale) > (${docId}::uuid, ${afterLocale}::text)`;
  }

  const rows = await sql`
    select h.* from (
      select l.doc_id, x.collection, l.locale, l.version, l.state, l.created_at, l.created_by, l.field_warnings,
        (select s.data->>'slug' from document_shared s
          where s.doc_id = l.doc_id and (s.is_head_published or s.is_head_draft)
          order by s.is_head_published desc limit 1) as slug
      from document_localized l join documents x on x.id = l.doc_id
      where l.is_head_draft and x.deleted_at is null
      union all
      select s.doc_id, x.collection, 'shared'::text as locale, s.version, s.state, s.created_at, s.created_by,
        '{}'::jsonb as field_warnings,
        (select p.data->>'slug' from document_shared p
          where p.doc_id = s.doc_id and (p.is_head_published or p.is_head_draft)
          order by p.is_head_published desc limit 1) as slug
      from document_shared s join documents x on x.id = s.doc_id
      where s.is_head_draft and x.deleted_at is null
    ) h
    where true ${stateFrag} ${collectionFrag} ${localeFrag} ${afterFrag}
    order by h.doc_id, h.locale
    limit ${limit + 1}`;
  const items: DraftHead[] = rows.slice(0, limit).map((r) => ({
    docId: r.doc_id as string,
    collection: r.collection as string,
    slug: (r.slug ?? null) as string | null,
    locale: r.locale as string,
    version: r.version as number,
    state: r.state as string,
    createdAt: r.created_at as Date,
    createdBy: r.created_by as string,
    warningCount: distinctWarnings(r.field_warnings),
  }));
  const last = items[items.length - 1];
  return { items, next: rows.length > limit && last ? `${last.docId}:${last.locale}` : null };
}

/**
 * The reviewer's view of the draft head of (doc, locale): per field the draft text, the text it replaces, the
 * source text and the warnings it still carries. Unguarded read. Throws NotFoundError when the document or its
 * draft head does not exist.
 */
export async function getDraftReview(ctx: Ctx, input: { docId: string; locale: string }): Promise<DraftReview> {
  const { sql, config } = ctx;
  if (input.locale === "shared") throw new ValidationError("Shared drafts have no review view: locale cannot be \"shared\"");
  const locale = normalizeLocale(input.locale);
  const sourceLocale = config.locales.source;
  if (locale !== sourceLocale && !Object.hasOwn(config.locales.chains, locale)) {
    throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  }
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);

  const [doc] = await sql`select d.collection,
      (select s.data->>'slug' from document_shared s
        where s.doc_id = d.id and (s.is_head_published or s.is_head_draft)
        order by s.is_head_published desc limit 1) as slug
    from documents d where d.id = ${input.docId} and d.deleted_at is null`;
  if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
  const [draft] = await sql`select version, state, data, source_hashes, field_warnings from document_localized
    where doc_id = ${input.docId} and locale = ${locale} and is_head_draft`;
  if (!draft) throw new NotFoundError(`${input.docId}/${locale} has no draft head`);
  const version = draft.version as number;

  const [published] = await sql`select data from document_localized
    where doc_id = ${input.docId} and locale = ${locale} and is_head_published`;
  const [source] = await sql`select version, data, source_hashes from document_localized
    where doc_id = ${input.docId} and locale = ${sourceLocale} and is_head_published`;
  const provenance = await sql`select field_path, edited, superseded_version, model_id from content_provenance
    where doc_id = ${input.docId} and locale = ${locale} and version = ${version} order by id`;
  // Marker rows (human:track, human:bulk-approve, ...) carry no superseded version; only AI-call rows do.
  const supersededRow = provenance.find((p) => !(p.model_id as string).startsWith("human:") && p.superseded_version !== null);
  const supersededVersion = supersededRow ? (supersededRow.superseded_version as number) : null;
  const [superseded] = supersededVersion === null ? [] : await sql`select data from document_localized
    where doc_id = ${input.docId} and locale = ${locale} and version = ${supersededVersion}`;

  const data = draft.data as Record<string, unknown>;
  const hashes = draft.source_hashes as Record<string, string>;
  const warnings = (draft.field_warnings ?? {}) as FieldWarnings;
  const srcData = (source?.data ?? {}) as Record<string, unknown>;
  const srcHashes = (source?.source_hashes ?? {}) as Record<string, string>;
  const supersededData = (superseded?.data ?? {}) as Record<string, unknown>;
  const publishedData = (published?.data ?? {}) as Record<string, unknown>;
  const editedPaths = new Set(provenance.filter((p) => p.edited === true).map((p) => p.field_path as string));

  const fields: ReviewField[] = Object.keys(data).sort().map((path) => {
    let previous: unknown;
    let previousFrom: ReviewField["previousFrom"] = null;
    if (superseded && Object.hasOwn(supersededData, path)) {
      previous = supersededData[path];
      previousFrom = "superseded";
    } else if (published && Object.hasOwn(publishedData, path)) {
      previous = publishedData[path];
      previousFrom = "published";
    }
    return {
      path,
      source: Object.hasOwn(srcData, path) ? srcData[path] : undefined,
      previous,
      previousFrom,
      draft: data[path],
      warnings: warnings[path] ?? [],
      edited: editedPaths.has(path),
      // The stale test of sync/state.ts applied to the stored columns: a missing source hash counts as different,
      // a draft with no recorded hash for the field is not stale.
      sourceChanged: Object.hasOwn(hashes, path) && hashes[path] !== srcHashes[path],
    };
  });

  return {
    docId: input.docId,
    collection: doc.collection as string,
    slug: (doc.slug ?? null) as string | null,
    locale,
    version,
    state: draft.state as string,
    sourceLocale,
    sourceVersion: source ? (source.version as number) : null,
    supersededVersion,
    fields,
  };
}
