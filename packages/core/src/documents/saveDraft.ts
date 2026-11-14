import type { Sql } from "postgres";

type Json = Parameters<Sql["json"]>[0];
import { assertActor, type Ctx } from "../ctx.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { assertLicensed } from "../licence/guard.js";
import { normalizeLocale } from "../schema/locale.js";
import { hashValue } from "../values/hash.js";
import { normalizeValue, stripTopLevelNulls } from "../values/normalize.js";

export type SaveDraftInput = {
  docId: string;
  locale: string | "shared";
  data: Record<string, unknown>;
  expectedVersion?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates a new `DRAFT_HUMAN` head for one scope of a document: `locale: "shared"` for the shared
 * snapshot, or a declared locale for that locale's snapshot. `data` is the complete snapshot for the
 * scope, not a patch; fields not supplied are absent from the new version. Top-level null values are
 * stripped (absence), while nested nulls are kept.
 *
 * The current draft head is cleared and replaced. This is also the human-takeover path over a
 * `DRAFT_AI` or `APPROVED` head. A target-locale save records the current published source hash for
 * each changed or new field and carries the base head's hash forward for unchanged fields, so a
 * re-save does not assert translation freshness.
 *
 * @param ctx engine context; the write must be licensed and the actor NUL-free.
 * @param input document id, scope, complete field data, and optional expected head version.
 * @returns the new version number allocated for the scope.
 * @throws {LicenceError} `LICENCE_REQUIRED` when the evaluation has ended without a key.
 * @throws {ValidationError} for a malformed or undeclared locale, an undeclared or wrongly-scoped
 * field, an invalid value, or U+0000.
 * @throws {NotFoundError} for a malformed, unknown or deleted document, or a collection absent from
 * the config.
 * @throws {ConflictError} when `expectedVersion` does not match the current head (draft head, else
 * published head, else 0).
 * @remarks One transaction that locks the `documents` row and writes one snapshot. No cache, webhook
 * or external effect. History rows are retained; the previous draft head is only unmarked, not
 * deleted.
 */
export async function saveDraft(ctx: Ctx, input: SaveDraftInput): Promise<{ version: number }> {
  await assertLicensed(ctx);
  assertActor(ctx);
  const { config, sql, actor } = ctx;
  const isShared = input.locale === "shared";
  const locale = isShared ? "shared" : normalizeLocale(input.locale);
  if (!isShared) {
    const declared = new Set([config.locales.source, ...Object.keys(config.locales.chains)]);
    if (!declared.has(locale)) throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  }
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);

  // Validation that needs no database access happens after the collection is known, but before any write.
  const [docProbe] = await sql`select collection from documents where id = ${input.docId} and deleted_at is null`;
  if (!docProbe) throw new NotFoundError(`Document "${input.docId}" not found`);
  const collection = config.collections.find((c) => c.name === docProbe.collection);
  if (!collection) throw new NotFoundError(`Unknown collection "${String(docProbe.collection)}"`);

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.data)) {
    const field = Object.hasOwn(collection.fields, key) ? collection.fields[key] : undefined;
    if (!field) throw new ValidationError(`${collection.name}.${key}: undeclared field`);
    if (field.localized === isShared) {
      throw new ValidationError(
        isShared
          ? `${collection.name}.${key}: localized field cannot be saved under "shared"`
          : `${collection.name}.${key}: shared field cannot be saved under a locale`,
      );
    }
    normalized[key] = value === null ? null : normalizeValue(field, value, key);
  }
  const data = stripTopLevelNulls(normalized);

  return sql.begin(async (tx) => {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);

    const table = isShared ? tx`document_shared` : tx`document_localized`;
    const scope = isShared ? tx`` : tx`and locale = ${locale}`;

    const [heads] = await tx`
      select coalesce(max(version), 0) as max_version,
             max(version) filter (where is_head_draft) as draft_version,
             max(version) filter (where is_head_published) as published_version
      from ${table} where doc_id = ${input.docId} ${scope}`;
    const current = (heads!.draft_version ?? heads!.published_version ?? 0) as number;
    if (input.expectedVersion !== undefined && input.expectedVersion !== current) {
      throw new ConflictError(
        `Expected version ${input.expectedVersion} of ${input.docId}/${locale} but the head is ${current}`,
      );
    }
    const version = (heads!.max_version as number) + 1;

    // Base head for the carry-forward below, read BEFORE the draft head is cleared: this locale's draft head,
    // else its published head, else its latest row by version in any state (e.g. after unpublish), else none.
    // A non-head DRAFT_AI row (rejected, or superseded) is never the base, as in recordAiDraft.
    const base = isShared || locale === config.locales.source ? undefined : (await tx`
      select data, source_hashes from document_localized
      where doc_id = ${input.docId} and locale = ${locale} and (is_head_draft or state <> 'DRAFT_AI')
      order by is_head_draft desc, is_head_published desc, version desc limit 1`)[0];

    await tx`update ${table} set is_head_draft = false
      where doc_id = ${input.docId} ${scope} and is_head_draft`;

    if (isShared) {
      await tx`insert into document_shared (doc_id, version, state, data, is_head_draft, created_by)
        values (${input.docId}, ${version}, 'DRAFT_HUMAN', ${tx.json(data as Json)}, true, ${actor})`;
      return { version };
    }

    // Hash vector (spec 6.4): source locale hashes its own values. A target records the hash of the source
    // locale's current published value for each CHANGED or NEW field (none if the source has no value); a
    // field whose value is unchanged against this locale's base head (draft head, else published head)
    // carries the base's stored hash forward, so a re-save never asserts sync (only trackFields does).
    const sourceHashes: Record<string, string> = {};
    if (locale === config.locales.source) {
      for (const [k, v] of Object.entries(data)) sourceHashes[k] = hashValue(v);
    } else {
      const baseData = (base?.data ?? {}) as Record<string, unknown>;
      const baseHashes = (base?.source_hashes ?? {}) as Record<string, string>;
      const [src] = await tx`select data from document_localized
        where doc_id = ${input.docId} and locale = ${config.locales.source} and is_head_published`;
      const srcData = (src?.data ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        if (base && Object.hasOwn(baseData, k) && hashValue(v) === hashValue(baseData[k])) {
          if (Object.hasOwn(baseHashes, k)) sourceHashes[k] = baseHashes[k]!;
        } else if (Object.hasOwn(srcData, k)) {
          sourceHashes[k] = hashValue(srcData[k]);
        }
      }
    }
    await tx`insert into document_localized
        (doc_id, locale, version, state, data, source_hashes, is_head_draft, created_by)
      values (${input.docId}, ${locale}, ${version}, 'DRAFT_HUMAN', ${tx.json(data as Json)},
              ${tx.json(sourceHashes as Json)}, true, ${actor})`;
    return { version };
  });
}
