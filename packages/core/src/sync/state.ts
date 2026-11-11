import type { Sql } from "postgres";
import type { Ctx } from "../ctx.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { normalizeLocale } from "../schema/locale.js";
import { hashValue } from "../values/hash.js";

type Json = Parameters<Sql["json"]>[0];

export type SyncStateKind = "current" | "stale" | "untracked" | "missing" | "orphaned";
export type SyncStateRow = {
  docId: string;
  locale: string;
  field: string;
  state: SyncStateKind;
  sourceVersion: number;
};
export type SyncStateInput = { collection?: string; docId?: string; locale?: string };
export type TrackFieldsInput = { docId: string; locale: string; fields: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function declaredLocales(ctx: Ctx): Set<string> {
  const { config } = ctx;
  return new Set([config.locales.source, ...Object.keys(config.locales.chains)]);
}

/** Normalizes a caller-supplied target locale: declared, not "shared", not the source locale. */
function targetLocale(ctx: Ctx, input: string): string {
  if (input === "shared") throw new ValidationError("Sync state is about translations: locale cannot be \"shared\"");
  const locale = normalizeLocale(input);
  if (!declaredLocales(ctx).has(locale)) throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  if (locale === ctx.config.locales.source) {
    throw new ValidationError(`Locale "${locale}" is the source locale: it has no sync state`);
  }
  return locale;
}

/**
 * Sync state of every (document, declared non-source locale, localized field) pair against the source
 * locale's published head (spec 6.4). One set-based statement, for a single document and for the sweep.
 * Documents without a published source head are not measured (there is no source version to compare to).
 */
export async function getSyncState(ctx: Ctx, input: SyncStateInput = {}): Promise<SyncStateRow[]> {
  const { config, sql } = ctx;
  const source = config.locales.source;
  if (input.collection !== undefined && !config.collections.some((c) => c.name === input.collection)) {
    throw new ValidationError(`Unknown collection "${input.collection}"`);
  }
  const only = input.locale === undefined ? undefined : targetLocale(ctx, input.locale);
  if (input.docId !== undefined && !UUID.test(input.docId)) return [];

  const locales = only === undefined
    ? [...declaredLocales(ctx)].filter((l) => l !== source).sort()
    : [only];
  const decl: Array<{ collection: string; field: string }> = [];
  for (const c of config.collections) {
    for (const [name, f] of Object.entries(c.fields)) if (f.localized) decl.push({ collection: c.name, field: name });
  }

  const rows = await sql`
    with decl as (
      select * from jsonb_to_recordset(${sql.json(decl as Json)}) as x(collection text, field text)
    ), locs as (
      select jsonb_array_elements_text(${sql.json(locales as Json)}) as locale
    )
    select d.id as doc_id, l.locale, f.field, s.version as source_version,
      case
        when not (s.data ? f.field) then 'orphaned'
        when t.data is null or not (t.data ? f.field) then 'missing'
        when not (t.source_hashes ? f.field) then 'untracked'
        when t.source_hashes ->> f.field = s.source_hashes ->> f.field then 'current'
        else 'stale'
      end as state
    from documents d
    join document_localized s on s.doc_id = d.id and s.locale = ${source} and s.is_head_published
    cross join locs l
    left join lateral (
      select h.data, h.source_hashes from document_localized h
      where h.doc_id = d.id and h.locale = l.locale and (h.is_head_published or h.is_head_draft)
      order by h.is_head_published desc limit 1
    ) t on true
    cross join lateral (
      select dc.field from decl dc where dc.collection = d.collection
      union
      select jsonb_object_keys(coalesce(t.data, '{}'::jsonb))
    ) f
    where d.deleted_at is null
      ${input.collection === undefined ? sql`` : sql`and d.collection = ${input.collection}`}
      ${input.docId === undefined ? sql`` : sql`and d.id = ${input.docId}`}
      and (s.data ? f.field or (t.data is not null and t.data ? f.field))
    order by d.id, l.locale, f.field`;

  return rows.map((r) => ({
    docId: r.doc_id as string,
    locale: r.locale as string,
    field: r.field as string,
    state: r.state as SyncStateKind,
    sourceVersion: r.source_version as number,
  }));
}

/**
 * Asserts "in sync with the source as of now" for the named fields of a target locale (spec 6.4): writes
 * the current source hashes into the target's current head row in place (published head, else draft head).
 * No new version; one `human:track` provenance row per field.
 */
export async function trackFields(ctx: Ctx, input: TrackFieldsInput): Promise<void> {
  const { config, sql, actor } = ctx;
  const locale = targetLocale(ctx, input.locale);
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    throw new ValidationError("fields must name at least one field");
  }

  const [docProbe] = await sql`select collection from documents where id = ${input.docId} and deleted_at is null`;
  if (!docProbe) throw new NotFoundError(`Document "${input.docId}" not found`);
  const collection = config.collections.find((c) => c.name === docProbe.collection);
  if (!collection) throw new NotFoundError(`Unknown collection "${String(docProbe.collection)}"`);

  const fields = [...new Set(input.fields)];
  for (const key of fields) {
    const field = typeof key === "string" && Object.hasOwn(collection.fields, key) ? collection.fields[key] : undefined;
    if (!field) throw new ValidationError(`${collection.name}.${String(key)}: undeclared field`);
    if (!field.localized) throw new ValidationError(`${collection.name}.${key}: shared field has no sync state`);
  }

  await sql.begin(async (tx) => {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
    const [{ t }] = (await tx`select date_trunc('milliseconds', clock_timestamp()) as t`) as unknown as [{ t: Date }];

    const [head] = await tx`select id, version, data, source_hashes from document_localized
      where doc_id = ${input.docId} and locale = ${locale} and (is_head_published or is_head_draft)
      order by is_head_published desc limit 1`;
    if (!head) throw new NotFoundError(`${input.docId}/${locale} has no head to track`);
    const [src] = await tx`select data from document_localized
      where doc_id = ${input.docId} and locale = ${config.locales.source} and is_head_published`;
    const srcData = (src?.data ?? {}) as Record<string, unknown>;
    const headData = head.data as Record<string, unknown>;

    const hashes: Record<string, string> = { ...(head.source_hashes as Record<string, string>) };
    for (const key of fields) {
      if (!Object.hasOwn(srcData, key)) throw new ValidationError(`${collection.name}.${key}: cannot track: source has no value`);
      if (!Object.hasOwn(headData, key)) {
        throw new ValidationError(`${collection.name}.${key}: cannot track: ${locale} has no value to assert in sync`);
      }
      hashes[key] = hashValue(srcData[key]);
    }
    await tx`update document_localized set source_hashes = ${tx.json(hashes as Json)} where id = ${head.id as string}`;
    for (const key of fields) {
      await tx`insert into content_provenance
          (doc_id, locale, version, field_path, job_id, model_id, prompt_version, prompt_tokens,
           completion_tokens, cost_micros, approved_by, approved_at, created_at)
        values (${input.docId}, ${locale}, ${head.version as number}, ${key}, null, 'human:track', '', 0, 0, 0,
                ${actor}, ${t}, ${t})`;
    }
  });
}
