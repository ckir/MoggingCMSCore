import type { Ctx } from "../ctx.js";
import { NotFoundError, NotPublishableError, ValidationError } from "../errors.js";
import { normalizeLocale } from "../schema/locale.js";

export type PublishInput = { docId: string; locale: string | "shared"; version?: number };
export type UnpublishInput = { docId: string; locale: string | "shared" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Locale handling duplicates saveDraft.ts on purpose (that file is not shared-code yet).
function resolveLocale(ctx: Ctx, input: string): { isShared: boolean; locale: string } {
  if (input === "shared") return { isShared: true, locale: "shared" };
  const locale = normalizeLocale(input);
  const { config } = ctx;
  const declared = new Set([config.locales.source, ...Object.keys(config.locales.chains)]);
  if (!declared.has(locale)) throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  return { isShared: false, locale };
}

/** Transaction handle as handed out by `sql.begin`. */
export type Tx = Parameters<Parameters<Ctx["sql"]["begin"]>[1]>[0];

/**
 * The spec 6.3 flip rule, run inside a caller's transaction. The caller must already hold the `documents`
 * row lock and passes the one millisecond-granular instant (ISO string) read after the lock.
 */
export async function publishWithinTx(tx: Tx, ctx: Ctx, input: PublishInput, stamp: string): Promise<void> {
  const { actor } = ctx;
  const { isShared, locale } = resolveLocale(ctx, input.locale);
  const table = isShared ? tx`document_shared` : tx`document_localized`;
  const scope = isShared ? tx`` : tx`and locale = ${locale}`;
  const label = `${input.docId}/${locale}`;

  const [any] = await tx`select 1 as x from ${table} where doc_id = ${input.docId} ${scope} limit 1`;
  if (!any) throw new NotFoundError(`No snapshots for ${label}`);

  let target: { version: number; state: string; is_head_draft: boolean; is_head_published: boolean } | undefined;
  if (input.version === undefined) {
    [target] = await tx`select version, state, is_head_draft, is_head_published from ${table}
      where doc_id = ${input.docId} ${scope} and is_head_draft`;
    if (!target) throw new NotPublishableError(`${label} has no draft head to publish`);
  } else {
    [target] = await tx`select version, state, is_head_draft, is_head_published from ${table}
      where doc_id = ${input.docId} ${scope} and version = ${input.version}`;
    if (!target) throw new NotFoundError(`Version ${input.version} of ${label} not found`);
  }

  const isDraftHead = target.is_head_draft && (target.state === "DRAFT_HUMAN" || target.state === "APPROVED");
  const isRepublish = target.state === "PUBLISHED" && !target.is_head_published;
  if (!isDraftHead && !isRepublish) {
    throw new NotPublishableError(
      `Version ${target.version} of ${label} (state ${target.state}) cannot be published`,
    );
  }

  // Clear the old published head first: the partial unique index allows only one.
  await tx`update ${table} set is_head_published = false, unpublished_at = ${stamp}::timestamptz
    where doc_id = ${input.docId} ${scope} and is_head_published`;
  // Draft head: becomes the published head. Republish: draft head (if any) is left untouched.
  await tx`update ${table} set state = 'PUBLISHED', is_head_published = true, is_head_draft = false,
      published_at = ${stamp}::timestamptz, published_by = ${actor}, unpublished_at = null
    where doc_id = ${input.docId} ${scope} and version = ${target.version}`;
}

/** Publishes the draft head (or republishes a previously published row by version); spec 6.3 flip rule. */
export async function publish(ctx: Ctx, input: PublishInput): Promise<void> {
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

/** Clears the published head and stamps unpublished_at; no-op when nothing is published. Draft head untouched. */
export async function unpublish(ctx: Ctx, input: UnpublishInput): Promise<void> {
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
    await tx`update ${table} set is_head_published = false, unpublished_at = ${stamp}::timestamptz
      where doc_id = ${input.docId} ${scope} and is_head_published`;
  });
}
