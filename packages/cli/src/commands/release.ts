import { addToRelease, createRelease, getDocument, listDraftHeads, listReleases, NotFoundError } from "@mogging/core";
import type { Ctx, DraftHead } from "@mogging/core";
import { table } from "../output.js";
import { resolveTarget } from "../target.js";
import { UsageError } from "../types.js";
import type { CommandResult, CommandSpec, Flags } from "../types.js";
import {
  aiDraftMessage, draftHeads, isPublishable, isRefusal, itemsResult, labelOf, publishNamedRelease, refusal, releaseIdOf,
  scopeLocale,
} from "./publish.js";
import type { Item } from "./publish.js";

const VERBS = ["create", "list", "add", "publish"] as const;
type Verb = (typeof VERBS)[number];

/** The options each verb takes; one given to another verb is a usage error, never silently ignored. */
const OPTIONS_OF: Record<Verb, string[]> = {
  create: [],
  list: [],
  add: ["locale", "all-approved", "collection"],
  publish: ["allow-stale"],
};
const VERB_OPTIONS = ["locale", "all-approved", "collection", "allow-stale"];

/** One draft head to add, or (`head: null`) a named target that has none in scope. */
type Entry = { docId: string; target: string; locale: string; head: { state: string; version: number } | null };

/** Adds one entry; every refusal core raises for it is an item, so the run reaches its summary. */
async function addEntry(ctx: Ctx, releaseId: string, entry: Entry, only: string | undefined): Promise<Item> {
  const { target, locale, head } = entry;
  if (head === null) {
    return refusal(target, locale, `${target}${only === undefined ? "" : ` ${only}`} has no draft head to add`);
  }
  const { version } = head;
  if (!isPublishable(head)) return refusal(target, locale, aiDraftMessage(target, locale), version);
  try {
    await addToRelease(ctx, { releaseId, docId: entry.docId, locale, version });
    return { target, locale, outcome: "added", version };
  } catch (err) {
    if (!isRefusal(err)) throw err;
    if (err.name === "ValidationError" && /is already in release/.test(err.message)) {
      return { target, locale, outcome: "already in release", version };
    }
    return refusal(target, locale, err.message, version);
  }
}

/** Every APPROVED head from `listDraftHeads`, page after page. */
async function approvedHeads(ctx: Ctx, flags: Flags, only: string | undefined): Promise<DraftHead[]> {
  const heads: DraftHead[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await listDraftHeads(ctx, {
      state: "APPROVED",
      limit: 200,
      ...(typeof flags.collection === "string" ? { collection: flags.collection } : {}),
      ...(only === undefined ? {} : { locale: only }),
      ...(after === undefined ? {} : { after }),
    });
    heads.push(...page.items);
    if (page.next === null) return heads;
    after = page.next;
  }
}

async function add(ctx: Ctx, name: string, targets: string[], flags: Flags): Promise<CommandResult> {
  const releaseId = await releaseIdOf(ctx, name);
  const only = typeof flags.locale === "string" ? scopeLocale(ctx, flags.locale) : undefined;

  // Every target is looked up before anything is added, so an unknown one fails the run with nothing half done.
  const entries: Entry[] = [];
  if (flags["all-approved"] === true) {
    for (const h of await approvedHeads(ctx, flags, only)) {
      entries.push({
        docId: h.docId,
        target: labelOf({ collection: h.collection, docId: h.docId, slug: h.slug }),
        locale: h.locale,
        head: { state: h.state, version: h.version },
      });
    }
  }
  for (const text of targets) {
    const resolved = await resolveTarget(ctx, text);
    const target = labelOf(resolved);
    const doc = await getDocument(ctx, { collection: resolved.collection, docId: resolved.docId });
    if (doc === null) throw new NotFoundError(`Document "${target}" not found`);
    const heads = draftHeads(doc, only);
    if (heads.length === 0) entries.push({ docId: doc.id, target, locale: only ?? "-", head: null });
    for (const { locale, draft } of heads) {
      entries.push({ docId: doc.id, target, locale, head: { state: draft.state, version: draft.version } });
    }
  }

  const items: Item[] = [];
  for (const entry of entries) items.push(await addEntry(ctx, releaseId, entry, only));
  return itemsResult(items, "ReleaseAddFailed", ["nothing to add"]);
}

export const releaseSpec: CommandSpec = {
  name: "release",
  summary: "create, list, fill and publish releases",
  usage: [
    "mogging release create <name> [--json]",
    "       mogging release list [--json]",
    "       mogging release add <name> [<collection>/<slug> ...] [--locale <l>] [--all-approved] [--collection <c>] [--json]",
    "       mogging release publish <name> [--allow-stale] [--json]",
    "       (every form also takes [--config <path>] [--database-url <url>])",
  ].join("\n"),
  options: {
    locale: { type: "string" },
    "all-approved": { type: "boolean" },
    collection: { type: "string" },
    "allow-stale": { type: "boolean" },
  },
  project: "full",
  arity: [1, Infinity],
  validate(flags, positionals) {
    const [verb, ...rest] = positionals;
    if (!(VERBS as readonly string[]).includes(verb!)) {
      throw new UsageError(`release: unknown verb "${verb}" (expected ${VERBS.join(", ")})`);
    }
    const v = verb as Verb;
    for (const option of VERB_OPTIONS) {
      if (flags[option] !== undefined && !OPTIONS_OF[v].includes(option)) {
        throw new UsageError(`release ${v}: --${option} does not apply`);
      }
    }
    if (v === "create" && rest.length !== 1) throw new UsageError("release create: expected exactly one <name>");
    if (v === "publish" && rest.length !== 1) throw new UsageError("release publish: expected exactly one <name>");
    if (v === "list" && rest.length !== 0) throw new UsageError("release list: takes no arguments");
    if (v === "add") {
      if (rest.length === 0) throw new UsageError("release add: expected <name> and targets or --all-approved");
      if (flags["all-approved"] === true && rest.length > 1) {
        throw new UsageError("release add: give targets or --all-approved, not both");
      }
      if (flags["all-approved"] !== true && rest.length === 1) {
        throw new UsageError("release add: give at least one <collection>/<slug> target or --all-approved");
      }
      if (flags.collection !== undefined && flags["all-approved"] !== true) {
        throw new UsageError("release add: --collection only applies to --all-approved");
      }
    }
  },
  async run(env) {
    const { ctx } = env.project;
    const [verb, name, ...targets] = env.positionals as [Verb, string, ...string[]];
    switch (verb) {
      case "create": {
        const result = await createRelease(ctx, { name });
        return { data: result, lines: [`created release ${name} (id ${result.id})`] };
      }
      case "list": {
        const releases = await listReleases(ctx);
        const rows = releases.map((r) => [
          r.id, r.name, String(r.itemCount), r.publishedAt === null ? "-" : r.publishedAt.toISOString(), r.createdBy,
        ]);
        const lines = releases.length === 0 ? ["no releases"] : table(rows, ["id", "name", "items", "published", "created by"]);
        return { data: releases, lines };
      }
      case "add":
        return add(ctx, name, targets, env.flags);
      case "publish":
        return publishNamedRelease(ctx, name, env.flags["allow-stale"] === true);
    }
  },
};
