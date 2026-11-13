import { getDocument, NotFoundError } from "@mogging/core";
import type { Ctx } from "@mogging/core";
import { UsageError } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves `<collection>/<slug-or-id>`. The text splits at the FIRST `/`, so a nested slug (`docs/guide/setup`) keeps
 * its own slashes; a UUID after the collection is a document id, anything else is a slug (lowercased, as stored).
 * A soft-deleted document is refused as an unknown one unless `allowDeleted` is true (`release remove`).
 */
export async function resolveTarget(
  ctx: Ctx,
  text: string,
  options: { allowDeleted?: boolean } = {},
): Promise<{ collection: string; docId: string; slug: string | null }> {
  const cut = text.indexOf("/");
  const collection = cut === -1 ? "" : text.slice(0, cut);
  const rest = cut === -1 ? "" : text.slice(cut + 1);
  if (collection === "" || rest === "") {
    throw new UsageError(`invalid target "${text}": expected <collection>/<slug or id>`);
  }
  if (!ctx.config.collections.some((c) => c.name === collection)) {
    throw new NotFoundError(`Unknown collection "${collection}"`);
  }
  const doc = UUID.test(rest)
    ? await getDocument(ctx, { collection, docId: rest.toLowerCase() })
    : await getDocument(ctx, { collection, slug: rest.toLowerCase() });
  // `getDocument` returns a soft-deleted document too (it carries `deletedAt`); a target names one only on request
  if (doc === null || (doc.deletedAt !== null && options.allowDeleted !== true)) throw new NotFoundError(`Document "${collection}/${rest}" not found`);
  const slug = doc.shared.published?.data.slug ?? doc.shared.draft?.data.slug;
  return { collection, docId: doc.id, slug: typeof slug === "string" ? slug : null };
}
