import { assertActor, type Ctx } from "../ctx.js";
import { NotFoundError } from "../errors.js";
import { assertLicensed } from "../licence/guard.js";
import { publishWithinTx, resolveLocale } from "./publishCore.js";
import type { PublishInput } from "./publishCore.js";

export type { PublishInput };
export type UnpublishInput = { docId: string; locale: string | "shared" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Publishes the draft head (or republishes a previously published row by version); spec 6.3 flip rule. */
export async function publish(ctx: Ctx, input: PublishInput): Promise<void> {
  await assertLicensed(ctx);
  assertActor(ctx);
  const { sql } = ctx;
  resolveLocale(ctx, input.locale);
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);

  await sql.begin(async (tx) => {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
    // One millisecond-granular instant per transaction, read after the lock (spec 6.3 time travel:
    // JS Dates are ms precision, so stored stamps must be too; intervals touch exactly).
    const [{ t }] = (await tx`select date_trunc('milliseconds', clock_timestamp()) as t`) as unknown as [{ t: Date }];
    await publishWithinTx(tx, ctx, input, t.toISOString());
  });
}

/** Clears the published head and stamps unpublished_at and unpublished_by; no-op when nothing is published. Draft head untouched. */
export async function unpublish(ctx: Ctx, input: UnpublishInput): Promise<void> {
  assertActor(ctx);
  const { sql } = ctx;
  const { isShared, locale } = resolveLocale(ctx, input.locale);
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);

  await sql.begin(async (tx) => {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
    // One millisecond-granular instant per transaction, read after the lock (spec 6.3 time travel:
    // JS Dates are ms precision, so stored stamps must be too; intervals touch exactly).
    const [{ t }] = (await tx`select date_trunc('milliseconds', clock_timestamp()) as t`) as unknown as [{ t: Date }];
    const stamp = t.toISOString();
    const table = isShared ? tx`document_shared` : tx`document_localized`;
    const scope = isShared ? tx`` : tx`and locale = ${locale}`;
    await tx`update ${table} set is_head_published = false, unpublished_at = ${stamp}::timestamptz, unpublished_by = ${ctx.actor}
      where doc_id = ${input.docId} ${scope} and is_head_published`;
  });
}
