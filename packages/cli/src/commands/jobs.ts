import { cancelJobs, listJobs, retryJobs } from "@mogging/ai";
import type { AiCtx, BudgetRow, JobRow } from "@mogging/ai";
import { intOption } from "../args.js";
import { table } from "../output.js";
import { UsageError } from "../types.js";
import type { CommandSpec, Flags } from "../types.js";
import { exitRule, usd } from "./worker.js";

/** The page size of `listJobs` and `listProvenance` (their maximum); without it they stop at 200 rows. */
export const PAGE_SIZE = 1000;

/** The `ai_jobs.state` values (`0001_engine.sql`), in the order the counts line lists them. */
const STATES = ["QUEUED", "RUNNING", "FAILED", "CANCELLED", "COMPLETED"] as const;

/** Every page of a listing: `fetch(afterId)` is called with the last id seen until a page is short. */
export async function allPages<T extends { id: number }>(
  fetch: (afterId: number | undefined) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let afterId: number | undefined;
  for (;;) {
    const page = await fetch(afterId);
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
    afterId = page[page.length - 1]!.id;
  }
}

/** A comma list of ids, each read through `intOption` (so `0x10`, `1e1` and an empty entry are usage errors). */
function parseIds(name: "retry" | "cancel", flags: Flags): number[] | undefined {
  const text = flags[name];
  if (typeof text !== "string") return undefined;
  return text.split(",").map((id) => intOption(name, id, 1)!);
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const jobRow = (j: JobRow): string[] => [
  String(j.id),
  `${j.collection}/${j.docId}`,
  j.locale,
  j.state,
  String(j.attempts),
  j.lockedBy ?? "-",
  j.lockedUntil === null ? "-" : j.lockedUntil.toISOString(),
  j.errorMessage === null ? "-" : oneLine(j.errorMessage),
];

const budgetLine = (b: BudgetRow): string =>
  `budget ${b.scope}: spent ${usd(b.spentMicros)} USD, in-flight ${usd(b.inFlightMicros)} USD, cap ${usd(b.capMicros)} USD`;

export const jobsSpec: CommandSpec = {
  name: "jobs",
  summary: "list the translation jobs and budgets, or retry or cancel jobs",
  usage:
    "mogging jobs [--state <s>] [--collection <c>] [--limit <n>] [--retry <id,...>] [--cancel <id,...>] [--json] [--config <path>] [--database-url <url>]",
  options: {
    state: { type: "string" },
    collection: { type: "string" },
    limit: { type: "string" },
    retry: { type: "string" },
    cancel: { type: "string" },
  },
  project: "full",
  needsAi: true,
  arity: [0, 0],
  validate(flags) {
    if (typeof flags.state === "string" && !(STATES as readonly string[]).includes(flags.state.toUpperCase())) {
      throw new UsageError(`--state must be one of ${STATES.map((s) => s.toLowerCase()).join(", ")}, got "${flags.state}"`);
    }
    intOption("limit", typeof flags.limit === "string" ? flags.limit : undefined, 1, PAGE_SIZE);
    const retry = parseIds("retry", flags);
    const cancel = parseIds("cancel", flags);
    if (retry !== undefined && cancel !== undefined) throw new UsageError("jobs: --retry and --cancel cannot be combined");
  },
  async run(env) {
    const { flags } = env;
    const ctx: AiCtx = { ...env.project.ctx, ai: env.project.ai! }; // run() refused a project without `ai` (needsAi)

    const retry = parseIds("retry", flags);
    if (retry !== undefined) {
      const result = await retryJobs(ctx, { ids: retry });
      return {
        data: result,
        lines: [`retried ${result.retried}`, ...result.skipped.map((s) => `skipped ${s.id}: ${s.reason}`)],
        ...exitRule(result.skipped.length, result.retried, {
          code: "RetryFailed",
          message: `no job was retried: ${result.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}`,
        }),
      };
    }
    const cancel = parseIds("cancel", flags);
    if (cancel !== undefined) {
      const result = await cancelJobs(ctx, { ids: cancel });
      return { data: result, lines: [`cancelled ${result.cancelled} of ${new Set(cancel).size}`] };
    }

    const filters = {
      ...(typeof flags.state === "string" ? { state: flags.state.toUpperCase() } : {}),
      ...(typeof flags.collection === "string" ? { collection: flags.collection } : {}),
    };
    const limit = intOption("limit", typeof flags.limit === "string" ? flags.limit : undefined, 1, PAGE_SIZE);
    let jobs: JobRow[];
    let budgets: BudgetRow[] = [];
    if (limit !== undefined) {
      ({ jobs, budgets } = await listJobs(ctx, { ...filters, limit }));
    } else {
      jobs = await allPages(async (afterId) => {
        const page = await listJobs(ctx, { ...filters, limit: PAGE_SIZE, ...(afterId === undefined ? {} : { afterId }) });
        budgets = page.budgets;
        return page.jobs;
      });
    }

    const lines = [STATES.map((s) => `${s.toLowerCase()} ${jobs.filter((j) => j.state === s).length}`).join(", ")];
    if (jobs.length > 0) {
      lines.push(
        ...table(jobs.map(jobRow), ["id", "doc", "locale", "state", "attempts", "lease holder", "lease expiry", "error"]),
      );
    }
    lines.push(...budgets.map(budgetLine));
    return { data: { jobs, budgets }, lines };
  },
};
