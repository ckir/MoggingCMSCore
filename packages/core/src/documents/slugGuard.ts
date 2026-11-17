import type { Ctx } from "../ctx.js";
import { ValidationError } from "../errors.js";
import type { Tx } from "./publishCore.js";

/**
 * Takes the per-collection slug lock (spec 8) for each distinct collection name, in sorted order, as
 * transaction-scoped advisory locks (`pg_advisory_xact_lock(hashtext('mogging_slug:' || name))`). Sorting means
 * two transactions that lock several collections never wait on each other in opposite orders. The lock is
 * re-entrant within one transaction and is released at commit or rollback. It is always taken AFTER the
 * `documents` row lock(s) of the same transaction (lock order in AGENTS.md).
 *
 * @param tx transaction handle from `sql.begin`.
 * @param collections collection names; duplicates are collapsed.
 * @returns resolves once every lock is held by `tx`.
 */
export async function lockSlugs(tx: Tx, collections: string[]): Promise<void> {
  for (const name of [...new Set(collections)].sort()) {
    await tx`select pg_advisory_xact_lock(hashtext('mogging_slug:' || ${name}::text))`;
  }
}

/**
 * Refuses a shared snapshot whose slug another live document of the same collection already holds. The caller
 * must hold the collection's slug lock (`lockSlugs`) in this transaction, otherwise two writers can both pass.
 * A collection with no `slug` field, or `data` with no string at that key, is never checked. A document's own
 * rows never conflict, soft-deleted documents hold no slug, and only a shared published head or shared draft
 * head counts (an unpublished, superseded or rejected row holds nothing).
 *
 * @param tx transaction handle from `sql.begin`.
 * @param ctx engine context; only the config is read.
 * @param input the collection, the document being written or published, and its normalized shared data.
 * @returns resolves when the slug is free.
 * @throws {ValidationError} when a different live document of the collection holds the same slug.
 */
export async function assertSlugFree(
  tx: Tx,
  ctx: Ctx,
  input: { collection: string; docId: string; data: Record<string, unknown> },
): Promise<void> {
  const collection = ctx.config.collections.find((c) => c.name === input.collection);
  if (!collection) return;
  const field = Object.keys(collection.fields).find((k) => collection.fields[k]!.kind === "slug");
  if (field === undefined) return;
  const value = Object.hasOwn(input.data, field) ? input.data[field] : undefined;
  if (typeof value !== "string") return;
  const [clash] = await tx`
    select 1 as x
    from document_shared s join documents d on d.id = s.doc_id
    where d.collection = ${input.collection} and d.deleted_at is null and d.id <> ${input.docId}
      and (s.is_head_published or s.is_head_draft)
      and s.data ->> ${field}::text = ${value}
    limit 1`;
  if (clash) {
    throw new ValidationError(
      `Slug "${value}" is already used by another document in collection "${input.collection}"`,
    );
  }
}
