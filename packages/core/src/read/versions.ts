import type { Ctx } from "../ctx.js";
import { ValidationError } from "../errors.js";
import { bulkIds, collectionOf, declaredLocale } from "./resolve.js";

/** One published `document_localized` row: the current published head or a past published version. */
export type PublishedVersion = { docId: string; version: number; data: Record<string, unknown> };

/**
 * Lists every (document, locale) pair that has at least one `document_localized` row in ANY state, head or not.
 * A rejected draft or an unpublished locale keeps its rows with no head flag, so a heads-only read such as
 * {@link getDocument} cannot see them; this is spec 5.3's "no row of any state" test. One query. Ids of unknown
 * documents, of another collection and malformed ids contribute nothing; deleted documents are included.
 *
 * @param ctx engine context (read; the actor is not used).
 * @param input the collection and at most 1000 document ids (callers with more call in chunks).
 * @returns the pairs, ordered by `docId` then `locale`.
 * @throws {NotFoundError} for an undeclared collection.
 * @throws {ValidationError} when `docIds` holds more than 1000 ids.
 */
export async function listLocaleRows(
  ctx: Ctx, input: { collection: string; docIds: string[] },
): Promise<Array<{ docId: string; locale: string }>> {
  const col = collectionOf(ctx, input.collection);
  const ids = bulkIds(input.docIds);
  if (ids.length === 0) return [];
  const { sql } = ctx;
  const rows = await sql`
    select distinct l.doc_id, l.locale
    from document_localized l
    join documents d on d.id = l.doc_id
    where d.collection = ${col.name}
      and l.doc_id in (select jsonb_array_elements_text(${sql.json(ids as never)}::jsonb)::uuid)
    order by l.doc_id, l.locale`;
  return rows.map((r) => ({ docId: r.doc_id as string, locale: r.locale as string }));
}

/**
 * Lists every `document_localized` row in state `PUBLISHED` for the given documents and one locale: the current
 * published head and the history behind it, republish copies included (an unpublished row keeps state
 * `PUBLISHED`). Draft-only rows are absent. One query. Deleted documents are included.
 *
 * @param ctx engine context (read; the actor is not used).
 * @param input the collection, a declared locale (normalized; the source locale is allowed) and at most 1000
 *   document ids (callers with more call in chunks).
 * @returns the versions, ordered by `docId`, then `version` descending.
 * @throws {NotFoundError} for an undeclared collection.
 * @throws {ValidationError} for `"shared"`, a malformed or undeclared locale, or more than 1000 ids.
 */
export async function listPublishedVersions(
  ctx: Ctx, input: { collection: string; locale: string; docIds: string[] },
): Promise<PublishedVersion[]> {
  const col = collectionOf(ctx, input.collection);
  if (input.locale === "shared") throw new ValidationError('locale cannot be "shared": only localized scopes have versions here');
  const locale = declaredLocale(ctx, input.locale);
  const ids = bulkIds(input.docIds);
  if (ids.length === 0) return [];
  const { sql } = ctx;
  const rows = await sql`
    select l.doc_id, l.version, l.data
    from document_localized l
    join documents d on d.id = l.doc_id
    where d.collection = ${col.name} and l.locale = ${locale} and l.state = 'PUBLISHED'
      and l.doc_id in (select jsonb_array_elements_text(${sql.json(ids as never)}::jsonb)::uuid)
    order by l.doc_id, l.version desc`;
  return rows.map((r) => ({ docId: r.doc_id as string, version: r.version as number, data: r.data as Record<string, unknown> }));
}
