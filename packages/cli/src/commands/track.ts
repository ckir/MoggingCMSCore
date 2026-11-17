import { getDocuments, getSyncState, trackFields } from "@mogging/core";
import { resolveTarget } from "../target.js";
import { UsageError } from "../types.js";
import type { CommandEnv, CommandResult, CommandSpec, Flags } from "../types.js";

/** `--fields a,b`: split on commas and trimmed; an empty entry (`a,,b`, `a,`, `""`) is a usage error. */
function parseFields(flags: Flags): string[] | undefined {
  const text = flags.fields;
  if (typeof text !== "string") return undefined;
  const fields = text.split(",").map((f) => f.trim());
  if (fields.some((f) => f === "")) throw new UsageError(`--fields has an empty entry: "${text}"`);
  return fields;
}

const COLLECTION_USAGE =
  "mogging track --collection <c> --locale <l> [--dry-run] [--json] [--config <path>] [--database-url <url>]";

/** What one document of a whole-collection run tracks (or would track). */
type TrackedDocument = { docId: string; slug: string | null; locale: string; fields: string[] };

/**
 * The whole-collection form of `track`: every `untracked` field of every live document of the collection, in one
 * `getSyncState` sweep, one `trackFields` call per document (none in a dry run).
 *
 * @param env the command environment.
 * @param collection the declared collection name.
 * @param locale the target locale as typed.
 * @returns the command result: `data` is `{ tracked }`, the lines name each field.
 */
async function trackCollection(env: CommandEnv, collection: string, locale: string): Promise<CommandResult> {
  const { ctx } = env.project;
  const dryRun = env.flags["dry-run"] === true;
  const rows = await getSyncState(ctx, { collection, locale });

  const byDoc = new Map<string, string[]>();
  for (const r of rows) {
    if (r.state !== "untracked") continue;
    const list = byDoc.get(r.docId) ?? [];
    list.push(r.field);
    byDoc.set(r.docId, list);
  }

  // `getDocuments` takes at most 1000 ids per call.
  const ids = [...byDoc.keys()];
  const slugOf = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 1000) {
    for (const doc of await getDocuments(ctx, { collection, docIds: ids.slice(i, i + 1000) })) {
      const slug = doc.shared.published?.data.slug ?? doc.shared.draft?.data.slug;
      slugOf.set(doc.id, typeof slug === "string" ? slug : null);
    }
  }

  const tracked: TrackedDocument[] = ids.map((docId) => ({
    docId, slug: slugOf.get(docId) ?? null, locale, fields: byDoc.get(docId)!,
  }));
  const nameOf = (d: TrackedDocument) => d.slug ?? d.docId;
  tracked.sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));

  if (!dryRun) for (const d of tracked) await trackFields(ctx, { docId: d.docId, locale, fields: d.fields });

  const verb = dryRun ? "would track" : "tracked";
  const lines = dryRun ? ["dry run: nothing was written"] : [];
  if (tracked.length === 0) lines.push(`nothing untracked in ${collection} (${locale})`);
  for (const d of tracked) for (const f of d.fields) lines.push(`${verb} ${collection}/${nameOf(d)} ${locale} ${f}`);
  return { data: { tracked }, lines };
}

export const trackSpec: CommandSpec = {
  name: "track",
  summary: "assert that translated fields are in sync with the source",
  usage:
    "mogging track <collection>/<slug> --locale <l> [--fields a,b] [--json] [--config <path>] [--database-url <url>]\n" +
    `       ${COLLECTION_USAGE}`,
  options: {
    locale: { type: "string" },
    fields: { type: "string" },
    collection: { type: "string" },
    "dry-run": { type: "boolean" },
  },
  project: "full",
  arity: [0, 1],
  validate(flags, positionals) {
    if (typeof flags.locale !== "string") throw new UsageError("track: --locale is required");
    parseFields(flags);
    const whole = typeof flags.collection === "string";
    if (!whole && positionals.length === 0) {
      throw new UsageError("track: give <collection>/<slug> or --collection <c>");
    }
    if (whole && positionals.length > 0) {
      throw new UsageError("track: give <collection>/<slug> or --collection <c>, not both");
    }
    if (whole && flags.fields !== undefined) throw new UsageError("track: --fields needs <collection>/<slug>");
    if (!whole && flags["dry-run"] === true) throw new UsageError("track: --dry-run needs --collection");
  },
  checkLoaded(flags, _positionals, loaded) {
    const name = flags.collection;
    if (typeof name === "string" && !loaded.config.collections.some((c) => c.name === name)) {
      throw new UsageError(
        `unknown collection "${name}" (declared: ${loaded.config.collections.map((c) => c.name).join(", ")})`,
      );
    }
  },
  async run(env) {
    const { ctx } = env.project;
    const locale = env.flags.locale as string; // validate() guarantees it
    if (typeof env.flags.collection === "string") return trackCollection(env, env.flags.collection, locale);
    const target = await resolveTarget(ctx, env.positionals[0]!);
    const label = `${target.collection}/${target.slug ?? target.docId}`;

    let fields = parseFields(env.flags);
    if (fields === undefined) {
      const rows = await getSyncState(ctx, { collection: target.collection, docId: target.docId, locale });
      fields = rows.filter((r) => r.state === "untracked").map((r) => r.field);
      if (fields.length === 0) return { data: null, lines: [`nothing untracked for ${label} (${locale})`] };
    }
    await trackFields(ctx, { docId: target.docId, locale, fields });
    return { data: null, lines: fields.map((f) => `tracked ${label} ${locale} ${f}`) };
  },
};
