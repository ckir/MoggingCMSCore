// The unlisted `@mogging/core/internal` subpath: the guard-once write run and the within-transaction writers that
// `@mogging/markdown`'s bulk import uses. It is NOT part of the public surface pinned by test/api.test.ts and may change
// between minor versions; application code uses the main entry.
import { assertActor, type Ctx } from "./ctx.js";
import type { WriteRun } from "./documents/publish.js";
import { assertLicensed } from "./licence/guard.js";

export { publishWithinRun } from "./documents/publish.js";
export type { WriteRun, PublishInput } from "./documents/publish.js";
export { saveDraftWithinTx } from "./documents/saveDraft.js";
export type { SaveDraftInput } from "./documents/saveDraft.js";
export type { Tx } from "./documents/publishCore.js";

/**
 * Runs the write entry guards once for a whole run of writes and returns the handle the within-transaction writers
 * take: `assertLicensed(ctx)` first (a licence refusal wins), then `assertActor(ctx)`. The two guards then do not
 * repeat per document.
 *
 * @param ctx engine context; its `sql` is used for the licence read only and is not kept.
 * @returns a frozen `{ config, actor }` with no `sql`, so a holder can write only through a transaction it is given.
 * @throws {LicenceError} when the evaluation has ended without a key.
 * @throws {ValidationError} for an actor containing U+0000.
 * @remarks One read-only licence query. The returned handle is a snapshot: later changes to `ctx` do not reach it.
 */
export async function beginWriteRun(ctx: Ctx): Promise<WriteRun> {
  await assertLicensed(ctx);
  assertActor(ctx);
  return Object.freeze({ config: ctx.config, actor: ctx.actor });
}
