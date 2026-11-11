import type { Sql } from "postgres";
import type { Collection } from "../schema/collection.js";
import { chainFor, type MoggingConfig } from "../schema/config.js";

/** What the resolve statement needs to know about a collection, derived from the config alone. */
export type ResolvePlan = {
  /** Localized fields with their fallback chain (requested locale first). */
  fields: Array<{ name: string; chain: string[] }>;
  /** Non-localized (shared) field names. */
  sharedFields: string[];
  /** Union of every chain: the locales whose published heads the statement loads. */
  locales: string[];
};

export function planResolve(config: MoggingConfig, collection: Collection, locale: string): ResolvePlan {
  const fields: ResolvePlan["fields"] = [];
  const sharedFields: string[] = [];
  const union = new Set<string>([locale]);
  for (const [name, f] of Object.entries(collection.fields)) {
    if (!f.localized) {
      sharedFields.push(name);
      continue;
    }
    const chain = chainFor(config, locale, collection.name, name);
    for (const l of chain) union.add(l);
    fields.push({ name, chain });
  }
  return { fields, sharedFields, locales: [...union] };
}

export type ResolveRow = {
  id: string;
  shared: Record<string, unknown> | null;
  /** field name -> the first chain locale holding it (non-null), with its value. */
  picks: Record<string, { l: string; v: unknown }>;
};

/**
 * The single resolve statement. Every name and locale travels as a bound jsonb parameter;
 * no identifier or value is interpolated into the SQL text.
 */
export async function runResolve(
  sql: Sql,
  args: { collection: string; plan: ResolvePlan; ids?: string[]; limit?: number; asOf?: Date },
): Promise<ResolveRow[]> {
  const { collection, plan, ids, limit, asOf } = args;
  const spec = sql.json(plan.fields as never);
  const locales = sql.json(plan.locales as never);
  const idList = ids === undefined ? null : sql.json(ids as never);

  const asOfIso = asOf?.toISOString();
  const docVisible = asOfIso === undefined
    ? sql`d.deleted_at is null`
    : sql`(d.deleted_at is null or d.deleted_at > ${asOfIso}::timestamptz)`;
  const sharedPred = asOfIso === undefined
    ? sql`s.is_head_published`
    : sql`s.published_at <= ${asOfIso}::timestamptz and (s.unpublished_at is null or s.unpublished_at > ${asOfIso}::timestamptz)`;
  const locPred = asOfIso === undefined
    ? sql`l.is_head_published`
    : sql`l.published_at <= ${asOfIso}::timestamptz and (l.unpublished_at is null or l.unpublished_at > ${asOfIso}::timestamptz)`;
  const idPred = idList === null
    ? sql``
    : sql`and d.id in (select jsonb_array_elements_text(${idList}::jsonb)::uuid)`;
  const limitFrag = limit === undefined ? sql`` : sql`limit ${limit}`;

  const rows = await sql`
    select t.id, t.shared, t.picks from (
      select d.id, d.created_at, sh.data as shared, ll.n, pk.picks
      from documents d
      left join lateral (
        select s.data from document_shared s where s.doc_id = d.id and ${sharedPred} limit 1
      ) sh on true
      cross join lateral (
        select coalesce(jsonb_object_agg(l.locale, l.data), '{}'::jsonb) as loc, count(*) as n
        from document_localized l
        where l.doc_id = d.id
          and l.locale in (select jsonb_array_elements_text(${locales}::jsonb))
          and ${locPred}
      ) ll
      cross join lateral (
        select coalesce(jsonb_object_agg(f.name, jsonb_build_object('l', p.locale, 'v', p.v)), '{}'::jsonb) as picks
        from jsonb_to_recordset(${spec}::jsonb) as f(name text, chain jsonb)
        cross join lateral (
          select k.locale, ll.loc -> k.locale -> f.name as v
          from jsonb_array_elements_text(f.chain) with ordinality as k(locale, ord)
          where coalesce(jsonb_typeof(ll.loc -> k.locale -> f.name), 'null') <> 'null'
          order by k.ord
          limit 1
        ) p
      ) pk
      where d.collection = ${collection} and ${docVisible} ${idPred}
    ) t
    where ${plan.fields.length > 0 ? sql`t.n > 0` : sql`(t.shared is not null or t.n > 0)`}
    order by t.created_at, t.id
    ${limitFrag}`;
  return rows as unknown as ResolveRow[];
}
