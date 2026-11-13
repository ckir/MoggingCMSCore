import { getSyncState, trackFields } from "@mogging/core";
import { resolveTarget } from "../target.js";
import { UsageError } from "../types.js";
import type { CommandSpec, Flags } from "../types.js";

/** `--fields a,b`: split on commas and trimmed; an empty entry (`a,,b`, `a,`, `""`) is a usage error. */
function parseFields(flags: Flags): string[] | undefined {
  const text = flags.fields;
  if (typeof text !== "string") return undefined;
  const fields = text.split(",").map((f) => f.trim());
  if (fields.some((f) => f === "")) throw new UsageError(`--fields has an empty entry: "${text}"`);
  return fields;
}

export const trackSpec: CommandSpec = {
  name: "track",
  summary: "assert that translated fields are in sync with the source",
  usage:
    "mogging track <collection>/<slug> --locale <l> [--fields a,b] [--json] [--config <path>] [--database-url <url>]",
  options: { locale: { type: "string" }, fields: { type: "string" } },
  project: "full",
  arity: [1, 1],
  validate(flags) {
    if (typeof flags.locale !== "string") throw new UsageError("track: --locale is required");
    parseFields(flags);
  },
  async run(env) {
    const { ctx } = env.project;
    const locale = env.flags.locale as string; // validate() guarantees it
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
