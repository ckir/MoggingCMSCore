import type { Ctx } from "../ctx.js";
import { ConflictError, NotFoundError, NotPublishableError, StaleReleaseError, ValidationError } from "../errors.js";
import { assertLicensed } from "../licence/guard.js";
import { publishWithinTx } from "../documents/publishCore.js";
import { normalizeLocale } from "../schema/locale.js";

export type CreateReleaseInput = { name: string };
export type AddToReleaseInput = { releaseId: string; docId: string; locale: string | "shared"; version: number };
export type RemoveFromReleaseInput = { releaseId: string; docId: string; locale: string | "shared" };
export type PublishReleaseInput = { releaseId: string; allowStale?: boolean };
export type StaleReleaseItem = { docId: string; locale: string; fields: string[] };
/** Machine-readable payload of a StaleReleaseError, attached as `err.items`. */
export type StaleReleaseErrorWithItems = StaleReleaseError & { items: StaleReleaseItem[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIGINT_ID = /^[0-9]{1,18}$/;

// Locale handling duplicates saveDraft.ts / publish.ts on purpose (not shared-code yet).
function resolveLocale(ctx: Ctx, input: string): { isShared: boolean; locale: string } {
  if (input === "shared") return { isShared: true, locale: "shared" };
  const locale = normalizeLocale(input);
  const { config } = ctx;
  const declared = new Set([config.locales.source, ...Object.keys(config.locales.chains)]);
  if (!declared.has(locale)) throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  return { isShared: false, locale };
}

function releaseIdOf(id: string): string {
  if (typeof id !== "string" || !BIGINT_ID.test(id)) throw new NotFoundError(`Release "${String(id)}" not found`);
  return id;
}

/** Creates an empty release. The id is a bigint column, returned as a decimal string. Names are unique. */
export async function createRelease(ctx: Ctx, input: CreateReleaseInput): Promise<{ id: string }> {
  const { sql, actor } = ctx;
  if (typeof input.name !== "string" || input.name.trim() === "") throw new ValidationError("Release name is required");
  try {
    const [row] = await sql`insert into releases (name, created_by) values (${input.name}, ${actor}) returning id`;
    return { id: String(row!.id) };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new ConflictError(`Release "${input.name}" already exists`);
    throw e;
  }
}

export type ReleaseSummary = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
  allowStale: boolean;
  itemCount: number;
};

/** Every release with its item count, ordered by id. Unguarded read. */
export async function listReleases(ctx: Ctx): Promise<ReleaseSummary[]> {
  // count(*) is a bigint, which postgres.js returns as a string: cast it.
  const rows = await ctx.sql`select r.id, r.name, r.created_by, r.created_at, r.published_at, r.allow_stale,
      count(i.release_id)::int as item_count
    from releases r left join release_items i on i.release_id = r.id
    group by r.id
    order by r.id`;
  return rows.map((r) => ({
    id: String(r.id),
    name: r.name as string,
    createdBy: r.created_by as string,
    createdAt: r.created_at as Date,
    publishedAt: (r.published_at ?? null) as Date | null,
    allowStale: r.allow_stale as boolean,
    itemCount: r.item_count as number,
  }));
}

/**
 * Adds the CURRENT draft head (DRAFT_HUMAN or APPROVED) of a (document, locale) or the shared snapshot to a
 * release. Lock order everywhere: release row, then document rows.
 */
export async function addToRelease(ctx: Ctx, input: AddToReleaseInput): Promise<void> {
  const { sql } = ctx;
  const { isShared, locale } = resolveLocale(ctx, input.locale);
  const releaseId = releaseIdOf(input.releaseId);
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);

  await sql.begin(async (tx) => {
    const [rel] = await tx`select id, published_at from releases where id = ${releaseId} for update`;
    if (!rel) throw new NotFoundError(`Release "${releaseId}" not found`);
    if (rel.published_at !== null) throw new ValidationError("release already published");
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);

    const table = isShared ? tx`document_shared` : tx`document_localized`;
    const scope = isShared ? tx`` : tx`and locale = ${locale}`;
    const label = `${input.docId}/${locale}`;
    const [row] = await tx`select state, is_head_draft from ${table}
      where doc_id = ${input.docId} ${scope} and version = ${input.version}`;
    if (!row) throw new NotFoundError(`Version ${String(input.version)} of ${label} not found`);
    if (!row.is_head_draft || (row.state !== "DRAFT_HUMAN" && row.state !== "APPROVED")) {
      throw new NotPublishableError(
        `Version ${input.version} of ${label} (state ${String(row.state)}) is not a publishable draft head`,
      );
    }
    const itemLocale = isShared ? null : locale;
    // An item already there at ANOTHER version would make publishRelease refuse later (its version is no longer
    // the draft head) until removeFromRelease takes it out, so say so now; the same version stays the "already in" error.
    const [held] = await tx`select draft_version from release_items
      where release_id = ${releaseId} and doc_id = ${input.docId} and coalesce(locale, '') = ${itemLocale ?? ""}`;
    if (held && held.draft_version !== input.version) {
      throw new ConflictError(
        `${label} is in release ${releaseId} at version ${String(held.draft_version)}; the current head is version ${input.version}`,
      );
    }
    const inserted = await tx`insert into release_items (release_id, doc_id, locale, draft_version, added_by)
      values (${releaseId}, ${input.docId}, ${itemLocale}, ${input.version}, ${ctx.actor})
      on conflict do nothing returning 1 as x`;
    if (inserted.length === 0) throw new ValidationError(`${label} is already in release ${releaseId}`);
  });
}

/**
 * Takes the (document, locale) or shared item out of an unpublished release. Locks the release row only: the
 * documents row stays unlocked, so the item of a soft-deleted document can still be removed. An emptied release
 * stays. Not licence-guarded; records nothing.
 */
export async function removeFromRelease(ctx: Ctx, input: RemoveFromReleaseInput): Promise<void> {
  const { sql } = ctx;
  const { isShared, locale } = resolveLocale(ctx, input.locale);
  const releaseId = releaseIdOf(input.releaseId);
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);

  await sql.begin(async (tx) => {
    const [rel] = await tx`select id, published_at from releases where id = ${releaseId} for update`;
    if (!rel) throw new NotFoundError(`Release "${releaseId}" not found`);
    if (rel.published_at !== null) throw new ValidationError("release already published");
    const removed = await tx`delete from release_items
      where release_id = ${releaseId} and doc_id = ${input.docId} and coalesce(locale, '') = ${isShared ? "" : locale}
      returning 1 as x`;
    if (removed.length === 0) throw new NotFoundError(`${input.docId}/${locale} is not in release ${releaseId}`);
  });
}

/**
 * Publishes every item of a release in one transaction (spec 7.2, 8.1). Lock order: release row, then the
 * involved `documents` rows in ascending id. Stale re-check judges each localized item's own draft row
 * against the source as it will be after the flip (the in-release source item's draft, else the current
 * published source head); the flip is `publishWithinTx` (spec 6.3) with one stamp.
 */
export async function publishRelease(ctx: Ctx, input: PublishReleaseInput): Promise<void> {
  await assertLicensed(ctx);
  const { sql, actor, config } = ctx;
  const releaseId = releaseIdOf(input.releaseId);
  const source = config.locales.source;

  await sql.begin(async (tx) => {
    const [rel] = await tx`select id, published_at from releases where id = ${releaseId} for update`;
    if (!rel) throw new NotFoundError(`Release "${releaseId}" not found`);
    if (rel.published_at !== null) throw new ValidationError("release already published");

    const items = await tx`select doc_id, locale, draft_version from release_items
      where release_id = ${releaseId} order by doc_id, locale nulls first`;
    if (items.length === 0) throw new ValidationError("release is empty");

    // Ascending id order in ONE statement; the array binds as a single parameter (postgres.js v4 JSON text).
    const docIds = [...new Set(items.map((i) => i.doc_id as string))];
    const locked = await tx`select id from documents
      where id in ${tx(docIds)} and deleted_at is null order by id for update`;
    if (locked.length !== docIds.length) {
      const have = new Set(locked.map((r) => r.id as string));
      throw new NotFoundError(`Document "${docIds.find((d) => !have.has(d))}" not found`);
    }
    // One ms-granular instant, read once after the locks.
    const [{ t }] = (await tx`select date_trunc('milliseconds', clock_timestamp()) as t`) as unknown as [{ t: Date }];
    const stamp = t.toISOString();

    // Every item must still be the draft head in a publishable state (publishWithinTx alone would also accept
    // a historical PUBLISHED version as a republish).
    for (const item of items) {
      const isShared = item.locale === null;
      const label = `${item.doc_id}/${isShared ? "shared" : item.locale}`;
      const [row] = await tx`select state, is_head_draft from ${isShared ? tx`document_shared` : tx`document_localized`}
        where doc_id = ${item.doc_id} ${isShared ? tx`` : tx`and locale = ${item.locale}`} and version = ${item.draft_version}`;
      if (!row || !row.is_head_draft || (row.state !== "DRAFT_HUMAN" && row.state !== "APPROVED")) {
        throw new NotPublishableError(`Release item ${label} version ${item.draft_version} is no longer a publishable draft head`);
      }
    }

    // Stale re-check: fields of the item's own draft snapshot whose recorded source hash differs from the hash
    // of the source as it will be once the release is live: the in-release source item's draft row when the
    // release also carries this document's source-locale item, else the current published source head. Same
    // predicate as getSyncState's 'stale': the target has a stored hash for the field (else 'untracked') and it
    // is distinct from the source's (a missing source hash is therefore never 'current'). Source-locale and
    // shared items have nothing to compare to.
    const staleRows = await tx`
      select ri.doc_id, ri.locale, array_agg(k.key order by k.key) as fields
      from release_items ri
      join document_localized t on t.doc_id = ri.doc_id and t.locale = ri.locale and t.version = ri.draft_version
      left join release_items si on si.release_id = ri.release_id and si.doc_id = ri.doc_id and si.locale = ${source}
      join document_localized s on s.doc_id = ri.doc_id and s.locale = ${source}
        and (case when si.draft_version is not null then s.version = si.draft_version else s.is_head_published end)
      cross join lateral jsonb_object_keys(t.data) as k(key)
      where ri.release_id = ${releaseId} and ri.locale is not null and ri.locale <> ${source}
        and s.data ? k.key and t.source_hashes ? k.key
        and t.source_hashes ->> k.key is distinct from s.source_hashes ->> k.key
      group by ri.doc_id, ri.locale
      order by ri.doc_id, ri.locale`;
    const stale: StaleReleaseItem[] = staleRows.map((r) => ({
      docId: r.doc_id as string, locale: r.locale as string, fields: r.fields as string[],
    }));
    if (stale.length > 0 && input.allowStale !== true) {
      const list = stale.map((s) => `${s.docId}/${s.locale} (${s.fields.join(", ")})`).join("; ");
      throw Object.assign(
        new StaleReleaseError(`Release ${releaseId} has stale items: ${list}`),
        { items: stale },
      );
    }

    for (const item of items) {
      await publishWithinTx(
        tx, ctx,
        { docId: item.doc_id as string, locale: (item.locale as string | null) ?? "shared", version: item.draft_version as number },
        stamp,
      );
    }
    await tx`update releases set published_at = ${stamp}::timestamptz, published_by = ${actor},
        allow_stale = ${input.allowStale === true}
      where id = ${releaseId}`;
  });
}
