import type { Ctx } from "../ctx.js";
import { NotFoundError, NotPublishableError, ValidationError } from "../errors.js";
import { normalizeLocale } from "../schema/locale.js";
import { assertSlugFree, lockSlugs } from "./slugGuard.js";

export type PublishInput = { docId: string; locale: string | "shared"; version?: number };

// Locale handling duplicates saveDraft.ts on purpose (that file is not shared-code yet).
export function resolveLocale(ctx: Pick<Ctx, "config">, input: string): { isShared: boolean; locale: string } {
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
 * The spec 6.3 flip rule, run inside a caller's transaction. The caller must already hold the
 * `documents` row lock and passes the one millisecond-granular instant (ISO string) read after the
 * lock, so every row in a multi-item publication shares one timestamp.
 *
 * Without `input.version`, the scope's current draft head is the target. With a version, the target
 * is that exact row, which may be the draft head or a historical `PUBLISHED` row (republish). Any
 * other row is refused. The old published head is cleared first because the partial unique index
 * allows only one; a draft-head publish flips that row, while a republish inserts a copy as the next
 * version and leaves the original row's publication window intact. The copy carries the normalized
 * data and source hashes but not the `field_warnings` map. A draft head is untouched by a republish.
 *
 * @param tx transaction handle from `sql.begin`; this function never commits or rolls back.
 * @param ctx the config and actor only (a full engine context also fits); used for the actor and locale validation.
 * @param input document, scope and optional explicit version.
 * @param stamp millisecond-granular ISO instant, already truncated and read after the row lock.
 * @param opts optional `collection`: the document's collection name when the caller already knows it. It stands
 * in for the `documents` row's collection EVERYWHERE this function uses it (the required-field check, the
 * shared-scope slug lock and the duplicate-slug check) and the `select collection from documents` read is skipped.
 * Omitted, the collection is read from the `documents` row, as before. The caller must pass the document's true
 * collection: the hint is trusted, not verified.
 * @returns resolves when the rows are updated inside `tx`.
 * @throws {NotFoundError} when the scope has no snapshots or the requested version does not exist.
 * @throws {NotPublishableError} when the target is neither a publishable draft head nor a
 * historical published row.
 * @throws {ValidationError} for an undeclared or malformed locale, a target that lacks a required field of its
 * scope, or (shared scope) when the target's slug is held by another live document of the collection (checked
 * under the collection's slug lock).
 * @remarks Does not check the licence, actor validity, document existence, `deleted_at`, or the
 * release state: callers own those checks. No external side effects.
 */
export async function publishWithinTx(
  tx: Tx,
  ctx: Pick<Ctx, "config" | "actor">,
  input: PublishInput,
  stamp: string,
  opts?: { collection?: string },
): Promise<void> {
  const { actor } = ctx;
  const { isShared, locale } = resolveLocale(ctx, input.locale);
  const table = isShared ? tx`document_shared` : tx`document_localized`;
  const scope = isShared ? tx`` : tx`and locale = ${locale}`;
  const label = `${input.docId}/${locale}`;

  const [any] = await tx`select 1 as x from ${table} where doc_id = ${input.docId} ${scope} limit 1`;
  if (!any) throw new NotFoundError(`No snapshots for ${label}`);

  let target:
    | { version: number; state: string; is_head_draft: boolean; is_head_published: boolean; data: Record<string, unknown> }
    | undefined;
  if (input.version === undefined) {
    [target] = await tx`select version, state, is_head_draft, is_head_published, data from ${table}
      where doc_id = ${input.docId} ${scope} and is_head_draft`;
    if (!target) throw new NotPublishableError(`${label} has no draft head to publish`);
  } else {
    [target] = await tx`select version, state, is_head_draft, is_head_published, data from ${table}
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

  // The collection comes from the caller's hint when given, else from the documents row (the input carries none). A
  // document whose collection is no longer in the config is not checked for required fields (as assertSlugFree does).
  let collectionName: string | undefined = opts?.collection;
  if (collectionName === undefined) {
    const [docRow] = await tx`select collection from documents where id = ${input.docId}`;
    collectionName = docRow ? (docRow.collection as string) : undefined;
  }
  const collection = collectionName === undefined ? undefined : ctx.config.collections.find((c) => c.name === collectionName);

  // A head is published only with every top-level required field of its scope present (empty values count).
  if (collection) {
    const missing = Object.entries(collection.fields)
      .filter(([name, f]) => f.required && f.localized !== isShared && (!Object.hasOwn(target!.data, name) || target!.data[name] === null))
      .map(([name]) => name);
    if (missing.length > 0) {
      // A target locale's AI draft never carries a field the AI cannot translate: point at the way to supply it.
      const remedy = !isShared && locale !== ctx.config.locales.source
        ? " (an AI draft never carries a field it cannot translate; supply it with an approve edit or saveDraft)"
        : "";
      throw new ValidationError(
        `Cannot publish version ${target.version} of ${label}: missing required field${missing.length === 1 ? "" : "s"} ${missing.join(", ")}${remedy}`,
      );
    }
  }

  // Shared scope: the slug the target would publish must still be free (spec 8). The slug lock is re-entrant and
  // comes after the documents row lock.
  if (isShared && collectionName !== undefined) {
    await lockSlugs(tx, ctx, [collectionName]);
    await assertSlugFree(tx, ctx, { collection: collectionName, docId: input.docId, data: target.data });
  }

  // Clear the old published head first: the partial unique index allows only one.
  await tx`update ${table} set is_head_published = false, unpublished_at = ${stamp}::timestamptz, unpublished_by = ${actor}
    where doc_id = ${input.docId} ${scope} and is_head_published`;
  if (isRepublish) {
    // Republishing an earlier version inserts a COPY as a new version, so the original row keeps its own
    // publication window and `asOf` reads inside that window stay exact. The draft head (if any) is untouched.
    const [{ next }] = (await tx`select coalesce(max(version), 0) + 1 as next from ${table}
      where doc_id = ${input.docId} ${scope}`) as unknown as [{ next: number }];
    if (isShared) {
      await tx`insert into document_shared
          (doc_id, version, state, data, is_head_published, created_at, created_by, published_at, published_by)
        select doc_id, ${next}, 'PUBLISHED', data, true, ${stamp}::timestamptz, ${actor}, ${stamp}::timestamptz, ${actor}
        from document_shared where doc_id = ${input.docId} and version = ${target.version}`;
    } else {
      await tx`insert into document_localized
          (doc_id, locale, version, state, data, source_hashes, is_head_published, created_at, created_by, published_at, published_by)
        select doc_id, locale, ${next}, 'PUBLISHED', data, source_hashes, true, ${stamp}::timestamptz, ${actor},
               ${stamp}::timestamptz, ${actor}
        from document_localized where doc_id = ${input.docId} and locale = ${locale} and version = ${target.version}`;
    }
    return;
  }
  // Draft head: becomes the published head (flip, no copy: spec 6.3).
  await tx`update ${table} set state = 'PUBLISHED', is_head_published = true, is_head_draft = false,
      published_at = ${stamp}::timestamptz, published_by = ${actor}, unpublished_at = null, unpublished_by = null
    where doc_id = ${input.docId} ${scope} and version = ${target.version}`;
}
