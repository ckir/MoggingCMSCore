import { NotFoundError } from "../errors.js";
import { assertActor, type Ctx } from "../ctx.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates a document shell in a declared collection and returns its UUID. No content snapshot is
 * created, so the document is invisible to `resolve` until a shared and/or localized snapshot is
 * published. The collection name is stored as text; the config remains the schema of record.
 *
 * Not licence-guarded. Only the actor is validated (NUL-free), and a single insert needs no
 * transaction.
 *
 * @param ctx engine context.
 * @param input name of a collection present in `ctx.config`.
 * @returns the new document id.
 * @throws {NotFoundError} for an unknown collection.
 * @throws {ValidationError} when the actor contains U+0000.
 * @remarks One `insert ... returning`; no snapshots, provenance or release rows are created.
 */
export async function createDocument(ctx: Ctx, input: { collection: string }): Promise<{ id: string }> {
  assertActor(ctx);
  if (!ctx.config.collections.some((c) => c.name === input.collection)) {
    throw new NotFoundError(`Unknown collection "${input.collection}"`);
  }
  const [row] = await ctx.sql`insert into documents (collection, created_by) values (${input.collection}, ${ctx.actor}) returning id`;
  return { id: row!.id as string };
}

/**
 * Soft-deletes a document: stamps `deleted_at` / `deleted_by` and leaves every snapshot, AI job,
 * provenance row and release item in place. Reads treat the document as absent from `deleted_at`
 * onward, and a time-travel read with an earlier `asOf` still sees it.
 *
 * Not licence-guarded, and there is no restore API: restoring means writing to the row outside the
 * SDK. Deleting an already-deleted document raises `NotFoundError` rather than succeeding silently.
 *
 * @param ctx engine context; the actor must be NUL-free.
 * @param input id of a live document.
 * @returns nothing; success is the committed state change.
 * @throws {NotFoundError} for a malformed id, an unknown document, or one already deleted.
 * @throws {ValidationError} when the actor contains U+0000.
 * @remarks One transaction that locks the `documents` row and reads a millisecond-granular
 * timestamp. No rows cascade and nothing external runs. A release item for the document survives,
 * but `publishRelease` will then refuse while the document stays deleted.
 */
export async function deleteDocument(ctx: Ctx, input: { docId: string }): Promise<void> {
  assertActor(ctx);
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);
  await ctx.sql.begin(async (tx) => {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
    const [{ t }] = (await tx`select date_trunc('milliseconds', clock_timestamp()) as t`) as unknown as [{ t: Date }];
    await tx`update documents set deleted_at = ${t.toISOString()}::timestamptz, deleted_by = ${ctx.actor} where id = ${input.docId}`;
  });
}
