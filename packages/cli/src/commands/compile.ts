import { compile } from "@mogging/ai";
import type { AiCtx } from "@mogging/ai";
import { usdOption } from "../args.js";
import { resolveTarget } from "../target.js";
import { UsageError } from "../types.js";
import type { CommandSpec } from "../types.js";
import { parseLocales, workerExit, workerLines } from "./worker.js";

const SHARE_ONE_COLLECTION = "compile targets must share one collection; run compile once per collection";

export const compileSpec: CommandSpec = {
  name: "compile",
  summary: "queue and run every stale or missing translation within a budget",
  usage:
    "mogging compile --locales de,fr --budget <usd> [--collection <c>] [<collection>/<slug> ...] [--json] [--config <path>] [--database-url <url>]",
  options: {
    locales: { type: "string" },
    budget: { type: "string" },
    collection: { type: "string" },
  },
  project: "full",
  needsAi: true,
  arity: [0, Number.POSITIVE_INFINITY],
  validate(flags, positionals) {
    if (parseLocales(flags) === undefined) throw new UsageError("compile: --locales is required");
    if (typeof flags.budget !== "string") throw new UsageError("compile: --budget is required");
    usdOption("budget", flags.budget);

    // `enqueueStale` takes `docIds` only with their collection, so every target must name the same one. The text before
    // the first `/` is read here; `resolveTarget` rejects a malformed or unknown target once the project is open.
    const named = new Set(positionals.filter((p) => p.includes("/")).map((p) => p.slice(0, p.indexOf("/"))));
    if (named.size > 1) throw new UsageError(SHARE_ONE_COLLECTION);
    if (typeof flags.collection === "string" && named.size === 1 && !named.has(flags.collection)) {
      throw new UsageError(SHARE_ONE_COLLECTION);
    }
  },
  async run(env) {
    const { flags } = env;
    const ctx: AiCtx = { ...env.project.ctx, ai: env.project.ai! }; // run() refused a project without `ai` (needsAi)
    const locales = parseLocales(flags)!; // validate() guarantees them
    const budgetUsd = usdOption("budget", flags.budget as string)!;

    const targets = [];
    for (const text of env.positionals) targets.push(await resolveTarget(ctx, text));
    const collection = typeof flags.collection === "string" ? flags.collection : targets[0]?.collection;
    // No targets means no docIds filter at all: an empty list would match nothing.
    const docIds = targets.length > 0 ? targets.map((t) => t.docId) : undefined;

    // In --json mode stdout is one document, so the per-job lines go to stderr.
    const write = env.json ? env.io.err : env.io.out;
    const report = await compile(ctx, {
      locales,
      budgetUsd,
      ...(collection === undefined ? {} : { collection }),
      ...(docIds === undefined ? {} : { docIds }),
      log: (line) => write(`${line}\n`),
    });
    const { enqueue } = report;
    return {
      data: report,
      lines: [
        `enqueued ${enqueue.enqueued}, duplicates ${enqueue.duplicates}, skipped ${enqueue.skipped.length}`,
        ...workerLines(report.worker),
        `pendingJobs ${report.pendingJobs}`,
      ],
      ...workerExit(report.worker),
    };
  },
};
