import { listProvenance } from "@mogging/ai";
import type { ProvenanceRow } from "@mogging/ai";
import { intOption } from "../args.js";
import { table } from "../output.js";
import { resolveTarget } from "../target.js";
import type { CommandSpec } from "../types.js";
import { PAGE_SIZE, allPages } from "./jobs.js";
import { usd } from "./worker.js";

const row = (p: ProvenanceRow): string[] => [
  String(p.id),
  p.locale,
  p.version === null ? "-" : String(p.version),
  p.fieldPath ?? "-",
  p.jobId === null ? "-" : String(p.jobId),
  p.modelId,
  `${p.promptTokens}/${p.completionTokens}`,
  usd(p.costMicros),
  p.discarded ? "yes" : "-",
  p.discardReason === null ? "-" : p.discardReason.replace(/\s+/g, " ").trim(),
];

export const provenanceSpec: CommandSpec = {
  name: "provenance",
  summary: "list the AI provenance rows of a document, discarded calls included",
  usage:
    "mogging provenance <collection>/<slug> [--locale <l>] [--discarded-only] [--limit <n>] [--json] [--config <path>] [--database-url <url>]",
  options: {
    locale: { type: "string" },
    "discarded-only": { type: "boolean" },
    limit: { type: "string" },
  },
  project: "full",
  arity: [1, 1],
  validate(flags) {
    intOption("limit", typeof flags.limit === "string" ? flags.limit : undefined, 1, PAGE_SIZE);
  },
  async run(env) {
    const { ctx } = env.project;
    const { flags } = env;
    const target = await resolveTarget(ctx, env.positionals[0]!);
    const limit = intOption("limit", typeof flags.limit === "string" ? flags.limit : undefined, 1, PAGE_SIZE);
    const filters = {
      docId: target.docId,
      ...(typeof flags.locale === "string" ? { locale: flags.locale } : {}),
      ...(flags["discarded-only"] === true ? { discardedOnly: true } : {}),
    };

    // Without --limit every row (spec 9.2): the core call stops at 200 by default, so page through it.
    const rows =
      limit !== undefined
        ? await listProvenance(ctx, { ...filters, limit })
        : await allPages((afterId) =>
            listProvenance(ctx, { ...filters, limit: PAGE_SIZE, ...(afterId === undefined ? {} : { afterId }) }),
          );
    const lines =
      rows.length === 0
        ? []
        : table(rows.map(row), ["id", "locale", "version", "field", "job", "model", "tokens", "cost_usd", "discarded", "reason"]);
    return { data: rows, lines };
  },
};
