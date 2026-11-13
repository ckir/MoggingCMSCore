import { getDocument, NotFoundError, unpublish } from "@mogging/core";
import { resolveTarget } from "../target.js";
import { UsageError } from "../types.js";
import type { CommandSpec } from "../types.js";
import { itemLine, labelOf, scopeLocale } from "./publish.js";
import type { Item } from "./publish.js";

export const unpublishSpec: CommandSpec = {
  name: "unpublish",
  summary: "take a locale (or the shared snapshot) of a document offline",
  usage: "mogging unpublish <collection>/<slug> --locale <l> [--json] [--config <path>] [--database-url <url>]",
  options: { locale: { type: "string" } },
  project: "full",
  arity: [1, 1],
  validate(flags) {
    if (typeof flags.locale !== "string") throw new UsageError("unpublish: --locale is required (use shared for the shared snapshot)");
  },
  async run(env) {
    const { ctx } = env.project;
    const locale = scopeLocale(ctx, env.flags.locale as string); // validate() guarantees it
    const resolved = await resolveTarget(ctx, env.positionals[0]!);
    const target = labelOf(resolved);
    const doc = await getDocument(ctx, { collection: resolved.collection, docId: resolved.docId });
    if (doc === null) throw new NotFoundError(`Document "${target}" not found`);

    const pair = locale === "shared" ? doc.shared : doc.locales[locale];
    await unpublish(ctx, { docId: doc.id, locale });
    // Already offline is the wanted state, so it is done, not a failure (Global Constraints).
    const items: Item[] = [{ target, locale, outcome: pair?.published ? "unpublished" : "not published" }];
    return { data: { items }, lines: items.map(itemLine) };
  },
};
