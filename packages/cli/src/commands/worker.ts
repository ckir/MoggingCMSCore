import { runWorker, usdToMicros } from "@mogging/ai";
import type { AiCtx, ClaimFilter, WorkerReport } from "@mogging/ai";
import { intOption, usdOption } from "../args.js";
import { UsageError } from "../types.js";
import type { CommandResult, CommandSpec, Flags } from "../types.js";

/** `--locales de,fr`: split on commas and trimmed; an empty entry is a usage error. */
export function parseLocales(flags: Flags): string[] | undefined {
  const text = flags.locales;
  if (typeof text !== "string") return undefined;
  const locales = text.split(",").map((l) => l.trim());
  if (locales.some((l) => l === "")) throw new UsageError(`--locales has an empty entry: "${text}"`);
  return locales;
}

/** The exit rule of Global Constraints: `failed = 0` -> 0; `done = 0` -> 1 (with `error`); both `> 0` -> 4. */
export function exitRule(failed: number, done: number, error: { code: string; message: string }): Pick<CommandResult, "exitCode" | "error"> {
  if (failed === 0) return {};
  if (done > 0) return { exitCode: 4 };
  return { exitCode: 1, error };
}

/**
 * `requeued` jobs went back to the queue after a provider error and `discarded` ones lost their lease (which is also
 * how a running job cancelled by `jobs --cancel` ends), so neither is a success. `budgetRefusals` counts on neither
 * side: those jobs are still pending.
 */
export function workerExit(w: WorkerReport): Pick<CommandResult, "exitCode" | "error"> {
  const failed = w.failed + w.errors + w.requeued + w.discarded;
  const done = w.completed + w.cancelled;
  return exitRule(failed, done, {
    code: "WorkerFailed",
    message: `no job succeeded (failed ${w.failed}, errors ${w.errors}, requeued ${w.requeued}, discarded ${w.discarded})`,
  });
}

/** Money as USD with 6 decimals from micros. */
export const usd = (micros: number): string => (micros / 1_000_000).toFixed(6);

export function workerLines(w: WorkerReport): string[] {
  return [
    `completed ${w.completed}, failed ${w.failed}, cancelled ${w.cancelled}, discarded ${w.discarded}, requeued ${w.requeued}, errors ${w.errors}`,
    `spent ${usd(w.spentMicros)} USD`,
    `budgetRefusals ${w.budgetRefusals}, runBudgetStop ${w.runBudgetStop ? "yes" : "no"}`,
  ];
}

export const workerSpec: CommandSpec = {
  name: "worker",
  summary: "run the translation worker over the queued jobs",
  usage:
    "mogging worker [--once] [--poll-ms <n>] [--budget <usd>] [--collection <c>] [--locales a,b] [--json] [--config <path>] [--database-url <url>]",
  options: {
    once: { type: "boolean" },
    "poll-ms": { type: "string" },
    budget: { type: "string" },
    collection: { type: "string" },
    locales: { type: "string" },
  },
  project: "full",
  needsAi: true,
  usesSignal: true,
  arity: [0, 0],
  validate(flags) {
    // Node's setTimeout treats a delay above 2147483647 as 1 ms, and 0 or less as about 1 ms: a busy loop of queries.
    intOption("poll-ms", typeof flags["poll-ms"] === "string" ? flags["poll-ms"] : undefined, 100, 2147483647);
    usdOption("budget", typeof flags.budget === "string" ? flags.budget : undefined);
    parseLocales(flags);
  },
  async run(env) {
    const { flags } = env;
    const ctx: AiCtx = { ...env.project.ctx, ai: env.project.ai! }; // run() refused a project without `ai` (needsAi)
    const pollMs = intOption("poll-ms", typeof flags["poll-ms"] === "string" ? flags["poll-ms"] : undefined, 100, 2147483647);
    const budget = usdOption("budget", typeof flags.budget === "string" ? flags.budget : undefined);
    const locales = parseLocales(flags);
    const filter: ClaimFilter = {
      ...(typeof flags.collection === "string" ? { collection: flags.collection } : {}),
      ...(locales === undefined ? {} : { locales }),
    };
    // In --json mode stdout is one document, so the per-job lines go to stderr.
    const write = env.json ? env.io.err : env.io.out;
    const report = await runWorker(ctx, {
      once: flags.once === true,
      ...(pollMs === undefined ? {} : { pollMs }),
      ...(budget === undefined ? {} : { runBudgetMicros: usdToMicros(budget) }),
      filter,
      log: (line) => write(`${line}\n`),
      signal: env.signal,
    });
    return { data: report, lines: workerLines(report), ...workerExit(report) };
  },
};
