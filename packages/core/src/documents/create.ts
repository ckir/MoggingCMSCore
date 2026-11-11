import { NotFoundError } from "../errors.js";
import type { Ctx } from "../ctx.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createDocument(ctx: Ctx, input: { collection: string }): Promise<{ id: string }> {
  if (!ctx.config.collections.some((c) => c.name === input.collection)) {
    throw new NotFoundError(`Unknown collection "${input.collection}"`);
  }
  const [row] = await ctx.sql`insert into documents (collection) values (${input.collection}) returning id`;
  return { id: row!.id as string };
}

/** Soft delete: spec 6.3 time-travel treats the document as absent from `deleted_at` on. */
export async function deleteDocument(ctx: Ctx, input: { docId: string }): Promise<void> {
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);
  await ctx.sql.begin(async (tx) => {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
    const [{ t }] = (await tx`select date_trunc('milliseconds', clock_timestamp()) as t`) as unknown as [{ t: Date }];
    await tx`update documents set deleted_at = ${t.toISOString()}::timestamptz where id = ${input.docId}`;
  });
}
