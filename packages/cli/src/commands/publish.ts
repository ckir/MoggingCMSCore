import { getDocument, listReleases, normalizeLocale, NotFoundError, publish, publishRelease, ValidationError } from "@mogging/core";
import type { Ctx, DocumentRecord, Snapshot, StaleReleaseItem } from "@mogging/core";
import { describeError } from "../output.js";
import { resolveTarget } from "../target.js";
import { UsageError } from "../types.js";
import type { CommandResult, CommandSpec } from "../types.js";
import { exitRule } from "./worker.js";

/** One head's outcome in the `{ items }` data of `publish`, `unpublish` and `release add`; `outcome` is the word the line prints. */
export type Item = { target: string; locale: string; outcome: string; version?: number; message?: string };

/** The errors core raises to refuse one head; anything else (a licence refusal, a database failure) ends the loop. */
const REFUSALS = new Set(["ValidationError", "ConflictError", "NotPublishableError", "NotFoundError"]);

/** By `name`, never `instanceof`: the user's config may load a second copy of `@mogging/core`. */
export const isRefusal = (err: unknown): err is Error =>
  typeof err === "object" && err !== null && REFUSALS.has((err as { name?: unknown }).name as string);

export const aiDraftMessage = (target: string, locale: string): string =>
  `${target} ${locale} is an unapproved AI draft: run \`mogging review\` first`;

export const labelOf = (t: { collection: string; docId: string; slug: string | null }): string =>
  `${t.collection}/${t.slug ?? t.docId}`;

/** `shared` or the normalized, declared locale: core's own check, made before any head is looked at. */
export function scopeLocale(ctx: Ctx, text: string): string {
  if (text === "shared") return text;
  const locale = normalizeLocale(text);
  const { source, chains } = ctx.config.locales;
  if (locale !== source && !Object.hasOwn(chains, locale)) {
    throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  }
  return locale;
}

/** The draft heads of a document, the shared snapshot first, then the locales; `only` restricts them to one. */
export function draftHeads(doc: DocumentRecord, only: string | undefined): Array<{ locale: string; draft: Snapshot }> {
  return [["shared", doc.shared] as const, ...Object.entries(doc.locales)]
    .filter(([locale]) => only === undefined || locale === only)
    .flatMap(([locale, pair]) => (pair.draft === null ? [] : [{ locale, draft: pair.draft }]));
}

/** `DRAFT_AI` is the only draft state besides these two: it must be reviewed (approved) first, never published. */
export const isPublishable = (draft: { state: string }): boolean => draft.state === "DRAFT_HUMAN" || draft.state === "APPROVED";

export function refusal(target: string, locale: string, message: string, version?: number): Item {
  return { target, locale, outcome: "refused", ...(version === undefined ? {} : { version }), message };
}

export function itemLine(item: Item): string {
  if (item.outcome === "refused") return `refused: ${item.message}`;
  return `${item.outcome} ${item.target} ${item.locale}${item.version === undefined ? "" : ` v${item.version}`}`;
}

/**
 * The result of a multi-item command: `refused` items are `failed`, every other one is `done` (Global Constraints),
 * and `whenEmpty` are the lines when nothing was attempted.
 */
export function itemsResult(items: Item[], errorCode: string, whenEmpty: string[]): CommandResult {
  const refused = items.flatMap((i) => (i.outcome === "refused" && i.message !== undefined ? [i.message] : []));
  return {
    data: { items },
    lines: items.length === 0 ? whenEmpty : items.map(itemLine),
    ...exitRule(refused.length, items.length - refused.length, {
      code: errorCode,
      message: refused.join("; "),
    }),
  };
}

export async function releaseIdOf(ctx: Ctx, name: string): Promise<string> {
  const found = (await listReleases(ctx)).find((r) => r.name === name);
  if (found === undefined) throw new NotFoundError(`Release "${name}" not found`);
  return found.id;
}

/**
 * `publish --release` and `release publish`. A stale release is a result, not a throw, so `--json` carries the
 * stale items in `data.stale`.
 */
export async function publishNamedRelease(ctx: Ctx, name: string, allowStale: boolean): Promise<CommandResult> {
  const releaseId = await releaseIdOf(ctx, name);
  try {
    await publishRelease(ctx, { releaseId, allowStale });
  } catch (err) {
    const items = (err as { items?: unknown }).items;
    if ((err as { name?: unknown }).name !== "StaleReleaseError" || !Array.isArray(items)) throw err;
    const stale = items as StaleReleaseItem[];
    return {
      data: { stale },
      lines: stale.map((s) => `${s.docId} ${s.locale} ${s.fields.join(",")}`),
      exitCode: 1,
      error: describeError(err),
    };
  }
  return { data: null, lines: [`published release ${name}`] };
}

export const publishSpec: CommandSpec = {
  name: "publish",
  summary: "publish a document, or a named release",
  usage:
    "mogging publish <collection>/<slug> [--locale <l>] [--json] [--config <path>] [--database-url <url>]\n" +
    "       mogging publish --release <name> [--allow-stale] [--json] [--config <path>] [--database-url <url>]",
  options: { locale: { type: "string" }, release: { type: "string" }, "allow-stale": { type: "boolean" } },
  project: "full",
  arity: [0, 1],
  validate(flags, positionals) {
    if (typeof flags.release === "string") {
      if (positionals.length > 0) throw new UsageError("publish: give a target or --release, not both");
      if (flags.locale !== undefined) throw new UsageError("publish: --locale does not apply to --release");
    } else {
      if (flags["allow-stale"] === true) throw new UsageError("publish: --allow-stale only applies to --release");
      if (positionals.length === 0) {
        throw new UsageError("publish: a target (<collection>/<slug>) or --release <name> is required");
      }
    }
  },
  async run(env) {
    const { ctx } = env.project;
    if (typeof env.flags.release === "string") {
      return publishNamedRelease(ctx, env.flags.release, env.flags["allow-stale"] === true);
    }

    const only = typeof env.flags.locale === "string" ? scopeLocale(ctx, env.flags.locale) : undefined;
    const resolved = await resolveTarget(ctx, env.positionals[0]!);
    const target = labelOf(resolved);
    const doc = await getDocument(ctx, { collection: resolved.collection, docId: resolved.docId });
    if (doc === null) throw new NotFoundError(`Document "${target}" not found`);

    const items: Item[] = [];
    for (const { locale, draft } of draftHeads(doc, only)) {
      if (!isPublishable(draft)) {
        items.push(refusal(target, locale, aiDraftMessage(target, locale), draft.version));
        continue;
      }
      try {
        // The version pins what was looked at: a head replaced in the meantime is refused, not published.
        await publish(ctx, { docId: doc.id, locale, version: draft.version });
        items.push({ target, locale, outcome: "published", version: draft.version });
      } catch (err) {
        if (!isRefusal(err)) throw err; // a LicenceError ends the loop and reaches `run` (exit 3)
        items.push(refusal(target, locale, err.message, draft.version));
      }
    }
    return itemsResult(items, "PublishFailed", [`${target} nothing to publish`]);
  },
};
