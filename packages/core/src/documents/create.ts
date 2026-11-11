import { NotFoundError } from "../errors.js";
import type { Ctx } from "../ctx.js";

export async function createDocument(ctx: Ctx, input: { collection: string }): Promise<{ id: string }> {
  if (!ctx.config.collections.some((c) => c.name === input.collection)) {
    throw new NotFoundError(`Unknown collection "${input.collection}"`);
  }
  const [row] = await ctx.sql`insert into documents (collection) values (${input.collection}) returning id`;
  return { id: row!.id as string };
}

/** Soft delete: spec 6.3 time-travel treats the document as absent from `deleted_at` on. */
export async function deleteDocument(ctx: Ctx, input: { docId: string }): Promise<void> {
  const rows = await ctx.sql`update documents set deleted_at = now()
    where id = ${input.docId} and deleted_at is null returning id`;
  if (rows.length === 0) throw new NotFoundError(`Document "${input.docId}" not found`);
}
