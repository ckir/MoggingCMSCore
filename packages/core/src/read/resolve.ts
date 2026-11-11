import type { Sql } from "postgres";
import type { Ctx } from "../ctx.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { Collection } from "../schema/collection.js";
import { normalizeLocale } from "../schema/locale.js";
import { planResolve, runResolve } from "./query.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolveInput = { collection: string; locale: string; ids?: string[]; limit?: number; asOf?: Date };
export type ResolvedDocument = {
  id: string;
  data: Record<string, unknown>;
  fellBack: Record<string, string>;
  missing: string[];
};

function collectionOf(ctx: Ctx, name: string): Collection {
  const col = ctx.config.collections.find((c) => c.name === name);
  if (!col) throw new NotFoundError(`Unknown collection "${String(name)}"`);
  return col;
}

function declaredLocale(ctx: Ctx, input: string): string {
  const locale = normalizeLocale(input);
  const { config } = ctx;
  const declared = new Set([config.locales.source, ...Object.keys(config.locales.chains)]);
  if (!declared.has(locale)) throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  return locale;
}

function checkLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new ValidationError("limit must be a positive integer");
  }
}

/**
 * Resolves published content for a locale with per-field fallback (spec 6.2, 7.3), optionally as of a
 * past instant (spec 6.3). One SQL statement regardless of the number of documents.
 * A document is returned when it has a visible published snapshot in any locale of the union of the chains;
 * a collection with no localized fields is returned on its shared head alone. A document of a collection with
 * localized fields whose only published snapshot is the shared one is omitted (spec 6.6). Fields no snapshot
 * supplies are simply absent (localized ones are listed in `missing`).
 */
export async function resolve(ctx: Ctx, input: ResolveInput): Promise<ResolvedDocument[]> {
  const col = collectionOf(ctx, input.collection);
  const locale = declaredLocale(ctx, input.locale);
  checkLimit(input.limit);
  const ids = input.ids?.filter((i) => typeof i === "string" && UUID.test(i));
  if (ids !== undefined && ids.length === 0) return [];
  const plan = planResolve(ctx.config, col, locale);
  const rows = await runResolve(ctx.sql, {
    collection: col.name, plan,
    ...(ids !== undefined ? { ids } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
  });
  return rows.map((row) => {
    const data: Record<string, unknown> = {};
    const fellBack: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of plan.sharedFields) {
      const v = row.shared !== null && Object.hasOwn(row.shared, name) ? row.shared[name] : undefined;
      if (v !== undefined && v !== null) data[name] = v;
    }
    for (const { name } of plan.fields) {
      const pick = Object.hasOwn(row.picks, name) ? row.picks[name] : undefined;
      if (!pick) {
        missing.push(name);
        continue;
      }
      data[name] = pick.v;
      if (pick.l !== locale) fellBack[name] = pick.l;
    }
    return { id: row.id, data, fellBack, missing };
  });
}

/**
 * Spec 6.6: applies the fallback rule to the target document and reports where it resolved.
 * The target resolves in the first locale of `locale`'s default chain (locale, then its configured
 * fallbacks) that has a published head for it; null when none, or the document is unknown/deleted.
 */
export async function resolveReference(
  ctx: Ctx, input: { docId: string; locale: string },
): Promise<{ id: string; resolvedLocale: string } | null> {
  const locale = declaredLocale(ctx, input.locale);
  if (!UUID.test(input.docId)) return null;
  const { chains } = ctx.config.locales;
  const chain = [locale, ...(Object.hasOwn(chains, locale) ? chains[locale]! : [])];
  const [row] = await ctx.sql`
    select
      (select l.locale
        from document_localized l
        join jsonb_array_elements_text(${ctx.sql.json(chain as never)}::jsonb) with ordinality as k(locale, ord)
          on k.locale = l.locale
        where l.doc_id = d.id and l.is_head_published
        order by k.ord
        limit 1) as resolved,
      exists (select 1 from document_shared s where s.doc_id = d.id and s.is_head_published) as has_shared,
      d.collection
    from documents d
    where d.id = ${input.docId} and d.deleted_at is null`;
  if (!row) return null;
  if (row.resolved) return { id: input.docId, resolvedLocale: row.resolved as string };
  // No localized head in the chain. A collection with localized fields has nothing to render, so the target
  // does not resolve; a shared-only collection (no localized fields) resolves on its shared head.
  const hasLocalized = Object.values(collectionOf(ctx, row.collection as string).fields).some((f) => f.localized);
  return !hasLocalized && row.has_shared ? { id: input.docId, resolvedLocale: locale } : null;
}

export type Snapshot = {
  version: number;
  state: string;
  data: Record<string, unknown>;
  sourceHashes: Record<string, string>;
  createdAt: Date;
  createdBy: string;
  publishedAt: Date | null;
  publishedBy: string | null;
};
export type HeadPair = { published: Snapshot | null; draft: Snapshot | null };
export type DocumentRecord = {
  id: string;
  collection: string;
  createdAt: Date;
  deletedAt: Date | null;
  shared: HeadPair;
  locales: Record<string, HeadPair>;
};

function toSnapshot(r: Record<string, unknown>): Snapshot {
  return {
    version: r.version as number,
    state: r.state as string,
    data: r.data as Record<string, unknown>,
    sourceHashes: (r.source_hashes ?? {}) as Record<string, string>,
    createdAt: r.created_at as Date,
    createdBy: r.created_by as string,
    publishedAt: (r.published_at ?? null) as Date | null,
    publishedBy: (r.published_by ?? null) as string | null,
  };
}

/** Raw heads (published and draft) for the shared snapshot and every locale, no fallback applied. */
export async function getDocument(
  ctx: Ctx, input: { collection: string; docId?: string; slug?: string },
): Promise<DocumentRecord | null> {
  const col = collectionOf(ctx, input.collection);
  const hasId = input.docId !== undefined;
  const hasSlug = input.slug !== undefined;
  if (hasId === hasSlug) throw new ValidationError("getDocument needs exactly one of docId or slug");
  const sql: Sql = ctx.sql;

  let doc: Record<string, unknown> | undefined;
  if (hasId) {
    if (!UUID.test(input.docId!)) return null;
    [doc] = await sql`select id, collection, created_at, deleted_at from documents
      where id = ${input.docId!} and collection = ${col.name}`;
  } else {
    [doc] = await sql`select d.id, d.collection, d.created_at, d.deleted_at
      from documents d
      join document_shared s on s.doc_id = d.id and (s.is_head_published or s.is_head_draft)
      where d.collection = ${col.name} and s.data->>'slug' = ${input.slug!}
      order by (d.deleted_at is not null), s.is_head_published desc, d.created_at, d.id
      limit 1`;
  }
  if (!doc) return null;
  const id = doc.id as string;
  const sharedRows = await sql`select * from document_shared where doc_id = ${id} and (is_head_published or is_head_draft)`;
  const locRows = await sql`select * from document_localized where doc_id = ${id} and (is_head_published or is_head_draft) order by locale`;

  const pairOf = (rows: Array<Record<string, unknown>>): HeadPair => {
    const pub = rows.find((r) => r.is_head_published);
    const draft = rows.find((r) => r.is_head_draft);
    return { published: pub ? toSnapshot(pub) : null, draft: draft ? toSnapshot(draft) : null };
  };
  const byLocale = new Map<string, Array<Record<string, unknown>>>();
  for (const r of locRows as unknown as Array<Record<string, unknown>>) {
    const list = byLocale.get(r.locale as string) ?? [];
    list.push(r);
    byLocale.set(r.locale as string, list);
  }
  const locales: Record<string, HeadPair> = {};
  for (const [loc, rows] of byLocale) locales[loc] = pairOf(rows);
  return {
    id,
    collection: doc.collection as string,
    createdAt: doc.created_at as Date,
    deletedAt: (doc.deleted_at ?? null) as Date | null,
    shared: pairOf(sharedRows as unknown as Array<Record<string, unknown>>),
    locales,
  };
}

/** Keyset pagination by (created_at, id); `after` is the last id seen, `next` is null when exhausted. */
export async function listDocuments(
  ctx: Ctx, input: { collection: string; limit?: number; after?: string; includeDeleted?: boolean },
): Promise<{ items: Array<{ id: string; slug: string | null; createdAt: Date }>; next: string | null }> {
  const col = collectionOf(ctx, input.collection);
  checkLimit(input.limit);
  const limit = input.limit ?? 50;
  const { sql } = ctx;
  if (input.after !== undefined && !UUID.test(input.after)) throw new ValidationError(`Malformed cursor "${input.after}"`);
  const afterFrag = input.after === undefined
    ? sql``
    : sql`and (d.created_at, d.id) > (select a.created_at, a.id from documents a where a.id = ${input.after})`;
  const deletedFrag = input.includeDeleted ? sql`` : sql`and d.deleted_at is null`;
  const rows = await sql`
    select d.id, d.created_at,
      (select s.data->>'slug' from document_shared s
        where s.doc_id = d.id and (s.is_head_published or s.is_head_draft)
        order by s.is_head_published desc limit 1) as slug
    from documents d
    where d.collection = ${col.name} ${deletedFrag} ${afterFrag}
    order by d.created_at, d.id
    limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const items = page.map((r) => ({ id: r.id as string, slug: (r.slug ?? null) as string | null, createdAt: r.created_at as Date }));
  return { items, next: rows.length > limit ? items[items.length - 1]!.id : null };
}
