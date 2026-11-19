import { assertActor, type Ctx } from "../ctx.js";
import { NotFoundError } from "../errors.js";
import { assertLicensed } from "../licence/guard.js";
import { publishWithinTx, resolveLocale } from "./publishCore.js";
import type { PublishInput, Tx } from "./publishCore.js";

export type { PublishInput };
export type UnpublishInput = { docId: string; locale: string | "shared" };

/**
 * The guard-once handle of a write run: the engine config and the NUL-free actor, and deliberately no `sql`, so
 * code that holds it can write only through a transaction it is given. Produced by `beginWriteRun`
 * (`@mogging/core/internal`) after the licence and actor guards have run once.
 */
export type WriteRun = Readonly<Pick<Ctx, "config" | "actor">>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Publishes one scope head. Without `version`, it takes the current draft head and accepts only
 * `DRAFT_HUMAN` or `APPROVED`; a `DRAFT_AI` head is refused. With `version`, it targets that exact
 * row: the current draft head (a normal flip) or a historical `PUBLISHED` row that is not the
 * current published head (a republish).
 *
 * Publishing a draft flips the row to `PUBLISHED` and clears the previous published head, stamping
 * its `unpublished_at`. Republishing inserts a copy as the next version and leaves the original
 * row's publication window intact for `asOf` reads; any draft head is untouched. One
 * millisecond-granular timestamp is read from the database after the document lock.
 *
 * @param ctx engine context; licence-guarded write with a NUL-free actor.
 * @param input document, scope (`"shared"` or a declared locale), and optional explicit version.
 * @returns nothing; success is the committed state change.
 * @throws {LicenceError} when the evaluation has ended without a key.
 * @throws {ValidationError} for a malformed or undeclared locale, a NUL actor, or a target that lacks a required
 * field of its scope.
 * @throws {NotFoundError} for a malformed, unknown or deleted document, or a missing version.
 * @throws {NotPublishableError} when the target cannot be published (for example a `DRAFT_AI` head).
 * @remarks One transaction; it publishes exactly one scope. Publishing several locales or the shared
 * scope is several calls and is not atomic across them. No cache, webhook or search indexing runs.
 */
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

/**
 * Publishes one scope head inside a transaction the caller owns, for a write run that has already passed the
 * licence and actor guards once (`beginWriteRun`). It does what {@link publish} does after its guards: validates the
 * locale and the document id, locks the document unless the caller already holds that lock, reads one
 * millisecond-granular database timestamp, and publishes with the collection the caller knows.
 *
 * @param tx transaction handle from `sql.begin`; this function never commits or rolls back.
 * @param run the write run from `beginWriteRun`; no guard runs here.
 * @param input document, scope (`"shared"` or a declared locale), and optional explicit version.
 * @param opts `collection`: the document's collection, as the caller knows it (it replaces the row read);
 * `alreadyLocked`: true when `tx` already holds the `documents` row lock (for example through
 * `saveDraftWithinTx`), which skips the lock select and with it the existence and soft-delete check.
 * @returns nothing; success is the state change in `tx`.
 * @throws {ValidationError} for a malformed or undeclared locale, or a target that lacks a required field of its scope.
 * @throws {NotFoundError} for a malformed id, or (when not `alreadyLocked`) an unknown or deleted document, or a missing version.
 * @throws {NotPublishableError} when the target cannot be published (for example a `DRAFT_AI` head).
 * @remarks The clock is read once per call, after the lock. With `alreadyLocked: true` the caller vouches for the
 * lock; nothing here verifies it.
 */
export async function publishWithinRun(
  tx: Tx,
  run: WriteRun,
  input: PublishInput,
  opts: { collection: string; alreadyLocked: boolean },
): Promise<void> {
  resolveLocale(run, input.locale);
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);
  if (!opts.alreadyLocked) {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
  }
  const [{ t }] = (await tx`select date_trunc('milliseconds', clock_timestamp()) as t`) as unknown as [{ t: Date }];
  await publishWithinTx(tx, run, input, t.toISOString(), { collection: opts.collection });
}

/**
 * Takes one scope offline: clears its published head and stamps `unpublished_at` /
 * `unpublished_by`, leaving the draft head untouched. A scope with no published head is a no-op.
 * The row keeps `state = PUBLISHED`, so the version can be republished later.
 *
 * Not licence-guarded: publishing is gated, taking content offline is not. The actor is still
 * validated for U+0000.
 *
 * @param ctx engine context; the actor must be NUL-free.
 * @param input document and scope (`"shared"` or a declared locale).
 * @returns nothing; success is the committed state change.
 * @throws {ValidationError} for an undeclared or malformed locale, or a NUL actor.
 * @throws {NotFoundError} for a malformed, unknown or deleted document.
 * @remarks One transaction under the document lock. No external effect. Reads immediately see the
 * fallback behaviour; a later `publish` with that explicit `version` can restore the same row.
 */
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
