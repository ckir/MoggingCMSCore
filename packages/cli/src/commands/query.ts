import { getDocument, NotFoundError, resolve } from "@mogging/core";
import type { Collection, Ctx, ResolvedDocument } from "@mogging/core";
import { intOption } from "../args.js";
import { escapeControl } from "../output.js";
import { resolveTarget } from "../target.js";
import { UsageError } from "../types.js";
import type { CommandResult, CommandSpec, Flags } from "../types.js";
import { labelOf, scopeLocale } from "./publish.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

const valueText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

const limitOf = (flags: Flags): number | undefined =>
  intOption("limit", typeof flags.limit === "string" ? flags.limit : undefined, 1, MAX_LIMIT);

/** `<slug-or-id>  <the first text field>`. */
function listLine(col: Collection, doc: ResolvedDocument): string {
  const slugField = Object.keys(col.fields).find((k) => col.fields[k]!.kind === "slug");
  const slug = slugField === undefined ? undefined : doc.data[slugField];
  const title = Object.entries(doc.data).find(([k, v]) => col.fields[k]?.kind === "text" && typeof v === "string")?.[1];
  const label = typeof slug === "string" ? slug : doc.id;
  return escapeControl(typeof title === "string" ? `${label}  ${title}` : label);
}

/** One line per field: shared ones say so; localized ones name the locale the value came from. */
function documentLines(col: Collection, doc: ResolvedDocument, locale: string): string[] {
  const lines = Object.entries(doc.data).map(([field, value]) => {
    if (col.fields[field]?.localized !== true) return escapeControl(`${field} [shared]: ${valueText(value)}`);
    const from = doc.fellBack[field];
    return escapeControl(
      `${field} [${from ?? locale}${from === undefined ? "" : ` (fell back from ${locale})`}]: ${valueText(value)}`,
    );
  });
  if (doc.missing.length > 0) lines.push(`missing: ${doc.missing.join(", ")}`);
  return lines;
}

async function rawDocument(ctx: Ctx, collection: string, docId: string, label: string, only: string | undefined): Promise<CommandResult> {
  const doc = await getDocument(ctx, { collection, docId });
  if (doc === null) throw new NotFoundError(`Document "${label}" not found`);
  const lines: string[] = [];
  for (const [locale, pair] of [["shared", doc.shared] as const, ...Object.entries(doc.locales)]) {
    if (only !== undefined && locale !== only) continue;
    if (pair.published !== null) lines.push(`${locale} published v${pair.published.version}`);
    if (pair.draft !== null) lines.push(`${locale} draft v${pair.draft.version} ${pair.draft.state}`);
  }
  return { data: doc, lines };
}

export const querySpec: CommandSpec = {
  name: "query",
  summary: "read published content, with locale fallback (read-only)",
  usage:
    "mogging query <collection>[/<slug>] [--locale <l>] [--raw] [--limit <n>] [--json] [--config <path>] [--database-url <url>]",
  options: { locale: { type: "string" }, raw: { type: "boolean" }, limit: { type: "string" } },
  project: "full",
  arity: [1, 1],
  validate(flags, positionals) {
    limitOf(flags);
    if (flags.raw === true && !positionals[0]!.includes("/")) {
      throw new UsageError("query: --raw needs a document: <collection>/<slug>");
    }
  },
  async run(env) {
    const { ctx } = env.project;
    const text = env.positionals[0]!;
    const locale = typeof env.flags.locale === "string" ? env.flags.locale : ctx.config.locales.source;

    if (!text.includes("/")) {
      const col = ctx.config.collections.find((c) => c.name === text);
      const docs = await resolve(ctx, { collection: text, locale, limit: limitOf(env.flags) ?? DEFAULT_LIMIT });
      return { data: docs, lines: docs.map((d) => listLine(col!, d)) }; // resolve refused an unknown collection
    }

    const resolved = await resolveTarget(ctx, text);
    const label = labelOf(resolved);
    if (env.flags.raw === true) {
      const only = typeof env.flags.locale === "string" ? scopeLocale(ctx, env.flags.locale) : undefined;
      return rawDocument(ctx, resolved.collection, resolved.docId, label, only);
    }
    const [doc] = await resolve(ctx, { collection: resolved.collection, locale, ids: [resolved.docId] });
    if (doc === undefined) throw new NotFoundError(`${label} has no published content in ${locale}`);
    const col = ctx.config.collections.find((c) => c.name === resolved.collection)!;
    return { data: doc, lines: documentLines(col, doc, locale) };
  },
};
