import { readFileSync } from "node:fs";
import { listGlossary } from "@mogging/ai";
import { approve, approveClean, getDraftReview, listDraftHeads, normalizeLocale, rejectDraft } from "@mogging/core";
import type { Ctx, DraftHead, DraftReview } from "@mogging/core";
import { intOption } from "../args.js";
import { parseEditFile, parseJsonEditFile } from "../editFile.js";
import { describeError, table } from "../output.js";
import { renderDraftReview } from "../render.js";
import { resolveTarget } from "../target.js";
import { UsageError } from "../types.js";
import type { CommandResult, CommandSpec, Flags } from "../types.js";
import { labelOf } from "./publish.js";

type Form = "approve-clean" | "interactive" | "list" | "show" | "approve" | "reject";

const VERBS = ["list", "show", "approve", "reject"] as const;
const STATES = ["DRAFT_AI", "APPROVED", "DRAFT_HUMAN"] as const;
type State = (typeof STATES)[number];
const PAGE_SIZE = 200; // listDraftHeads' maximum

/** Every option of `review` except the global ones; a form that does not list one here refuses it. */
const FORM_OPTIONS = ["collection", "locale", "state", "version", "reject-fields", "edit-file", "ack-warning", "reason"] as const;

/** The routing table: for each form, the options it accepts (the global ones always are). */
const ACCEPTS: Record<Form, readonly string[]> = {
  "approve-clean": ["collection", "locale"],
  interactive: ["collection", "locale"], // with a document (`review <collection>/<slug>`) only `locale`, below
  list: ["collection", "locale", "state"],
  show: ["locale"],
  approve: ["locale", "version", "reject-fields", "edit-file", "ack-warning"],
  reject: ["locale", "version", "reason"],
};

const FORMS_HELP =
  "expected `review [<collection>/<slug>]`, `review list|show|approve|reject ...` or `review --approve-clean`";

type Route = { form: Form; verb?: (typeof VERBS)[number]; accepts: readonly string[] };

function route(flags: Flags, positionals: string[]): Route {
  const first = positionals[0];
  if (flags["approve-clean"] === true) {
    if (first !== undefined) {
      const what = (VERBS as readonly string[]).includes(first) ? "a verb" : "a target";
      throw new UsageError(`review: --approve-clean cannot be combined with ${what} (${first})`);
    }
    return { form: "approve-clean", accepts: ACCEPTS["approve-clean"] };
  }
  if (first === undefined) return { form: "interactive", accepts: ACCEPTS.interactive };
  const verb = VERBS.find((v) => v === first);
  if (verb !== undefined) return { form: verb, verb, accepts: ACCEPTS[verb] };
  if (first.includes("/")) {
    if (positionals.length > 1) throw new UsageError(`review: unexpected argument ${positionals[1]}`);
    return { form: "interactive", accepts: ["locale"] };
  }
  throw new UsageError(`review: unknown form "${first}"; ${FORMS_HELP}`);
}

const labelFor = (r: Route): string =>
  r.form === "approve-clean" ? "review --approve-clean" : r.form === "interactive" ? "interactive review" : `review ${r.form}`;

const text = (flags: Flags, name: string): string | undefined => {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
};

/** `--reject-fields a,b`: split on commas and trimmed; an empty entry is a usage error. */
function rejectFields(flags: Flags): string[] | undefined {
  const raw = text(flags, "reject-fields");
  if (raw === undefined) return undefined;
  const fields = raw.split(",").map((f) => f.trim());
  if (fields.some((f) => f === "")) throw new UsageError(`--reject-fields has an empty entry: "${raw}"`);
  return fields;
}

const versionOf = (flags: Flags): number => intOption("version", text(flags, "version"), 1)!; // validate made it required

/** `--collection` and `--locale` of `list` and `--approve-clean`: declared, or `shared` (a usage error otherwise). */
function scopeOf(ctx: Ctx, flags: Flags): { collection?: string; locale?: string } {
  const collection = text(flags, "collection");
  if (collection !== undefined && !ctx.config.collections.some((c) => c.name === collection)) {
    throw new UsageError(`unknown collection "${collection}" (declared: ${ctx.config.collections.map((c) => c.name).join(", ")})`);
  }
  let locale = text(flags, "locale");
  if (locale !== undefined && locale !== "shared") {
    try {
      locale = normalizeLocale(locale);
    } catch (e) {
      throw new UsageError(`--locale: ${(e as Error).message}`);
    }
    const { source, chains } = ctx.config.locales;
    if (locale !== source && !Object.hasOwn(chains, locale)) {
      throw new UsageError(`--locale "${locale}" is not declared in the config`);
    }
  }
  return { ...(collection === undefined ? {} : { collection }), ...(locale === undefined ? {} : { locale }) };
}

/** The field kinds of a collection, by field name (what the renderer and edit files need). */
function kindsOf(ctx: Ctx, collection: string): Record<string, string> {
  const found = ctx.config.collections.find((c) => c.name === collection);
  return Object.fromEntries(Object.entries(found?.fields ?? {}).map(([name, field]) => [name, field.kind]));
}

const nameOf = (err: unknown): unknown => (typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined);

/** A returned exit 1: nothing threw, and `--json` still gets `data: null` and the `error`. */
const failure = (err: unknown, message: string): CommandResult => ({
  data: null, lines: [], exitCode: 1, error: { code: describeError(err).code, message },
});

/** By `name`, never `instanceof` (the user's config may load a second copy of core). */
async function draftReviewOf(
  ctx: Ctx, docId: string, locale: string, label: string,
): Promise<{ review: DraftReview } | { none: CommandResult }> {
  try {
    return { review: await getDraftReview(ctx, { docId, locale }) };
  } catch (err) {
    if (nameOf(err) !== "NotFoundError") throw err;
    return { none: failure(err, `no draft for ${label} ${locale}`) };
  }
}

/** A draft replaced after it was seen: the message core gives, then what to do about it. */
function staleResult(err: unknown): CommandResult | undefined {
  if (nameOf(err) !== "ConflictError") return undefined;
  return failure(err, `${describeError(err).message}; run \`mogging review show\` again`);
}

async function listAll(ctx: Ctx, state: State, scope: { collection?: string; locale?: string }): Promise<DraftHead[]> {
  const items: DraftHead[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await listDraftHeads(ctx, { state, ...scope, limit: PAGE_SIZE, ...(after === undefined ? {} : { after }) });
    items.push(...page.items);
    if (page.next === null) return items;
    after = page.next;
  }
}

export const reviewSpec: CommandSpec = {
  name: "review",
  summary: "review AI drafts: list, show, approve, reject, or approve the clean ones",
  usage:
    "mogging review [<collection>/<slug>] [--locale <l>] [--collection <c>]   (interactive)\n" +
    "       mogging review list [--collection <c>] [--locale <l>] [--state DRAFT_AI|APPROVED|DRAFT_HUMAN] [--json]\n" +
    "       mogging review show <collection>/<slug> --locale <l> [--json]\n" +
    "       mogging review approve <collection>/<slug> --locale <l> --version <n> [--reject-fields a,b] [--edit-file <path>] [--ack-warning <text>]... [--json]\n" +
    "       mogging review reject <collection>/<slug> --locale <l> --version <n> [--reason <text>] [--json]\n" +
    "       mogging review --approve-clean [--collection <c>] [--locale <l>] [--json]\n" +
    "       (every form takes [--config <path>] [--database-url <url>])",
  options: {
    "approve-clean": { type: "boolean" },
    collection: { type: "string" },
    locale: { type: "string" },
    state: { type: "string" },
    version: { type: "string" },
    "reject-fields": { type: "string" },
    "edit-file": { type: "string" },
    "ack-warning": { type: "string", multiple: true },
    reason: { type: "string" },
  },
  project: "full",
  // Exactly the interactive forms consume the abort signal.
  usesSignal: (flags, positionals) =>
    flags["approve-clean"] !== true && (positionals.length === 0 || positionals[0]!.includes("/")),
  arity: [0, 2],
  validate(flags, positionals) {
    const r = route(flags, positionals);
    const label = labelFor(r);
    for (const name of FORM_OPTIONS) {
      if (flags[name] !== undefined && !r.accepts.includes(name)) throw new UsageError(`${label}: --${name} does not apply`);
    }
    if (r.form === "interactive") {
      if (flags.json === true) throw new UsageError("interactive review has no --json form (use `review list|show|approve|reject --json`)");
      return;
    }
    if (r.form === "approve-clean") return;
    if (r.form === "list") {
      if (positionals.length > 1) throw new UsageError(`review list: unexpected argument ${positionals[1]}`);
      const state = text(flags, "state");
      if (state !== undefined && !(STATES as readonly string[]).includes(state.toUpperCase())) {
        throw new UsageError(`--state must be one of ${STATES.join(", ")}, got "${state}"`);
      }
      return;
    }
    // show, approve, reject: one target, a locale, and for approve and reject the version that was seen
    if (positionals.length < 2) throw new UsageError(`${label}: missing <collection>/<slug>`);
    if (positionals.length > 2) throw new UsageError(`${label}: unexpected argument ${positionals[2]}`);
    if (text(flags, "locale") === undefined) throw new UsageError(`${label}: --locale is required`);
    if (r.form === "approve" || r.form === "reject") {
      if (text(flags, "version") === undefined) {
        throw new UsageError(`${label}: --version <n> is required (the version \`mogging review list\` or \`show\` printed)`);
      }
      versionOf(flags);
    }
    if (r.form === "approve") rejectFields(flags);
  },
  async run(env) {
    const { ctx } = env.project;
    const { flags, positionals } = env;
    const r = route(flags, positionals);

    if (r.form === "interactive") {
      // Task 8: the interactive review replaces this.
      return {
        data: null, lines: [], exitCode: 1,
        error: { code: "NotImplemented", message: "interactive review is implemented in the next task" },
      };
    }

    if (r.form === "approve-clean") {
      const result = await approveClean(ctx, scopeOf(ctx, flags));
      return {
        data: result,
        lines: [`approved ${result.approved}`, ...result.skipped.map((s) => `skipped ${s.docId} ${s.locale}: ${s.reason}`)],
      };
    }

    if (r.form === "list") {
      const state = (text(flags, "state")?.toUpperCase() ?? "DRAFT_AI") as State;
      const items = await listAll(ctx, state, scopeOf(ctx, flags));
      const rows = items.map((h) => [labelOf(h), h.locale, `v${h.version}`, h.state, String(h.warningCount)]);
      return {
        data: { items, next: null },
        lines: items.length === 0 ? [`no ${state} drafts`] : table(rows, ["target", "locale", "version", "state", "warnings"]),
      };
    }

    const locale = text(flags, "locale")!; // validate required it
    const resolved = await resolveTarget(ctx, positionals[1]!);
    const label = labelOf(resolved);

    if (r.form === "show") {
      const found = await draftReviewOf(ctx, resolved.docId, locale, label);
      if ("none" in found) return found.none;
      const { review } = found;
      const glossary = await listGlossary(ctx, { sourceLocale: review.sourceLocale, targetLocale: review.locale });
      const lines = renderDraftReview(review, kindsOf(ctx, review.collection), {
        width: env.io.width ?? 100, color: env.io.color, glossary,
      });
      return { data: review, lines };
    }

    const expectedVersion = versionOf(flags);
    if (r.form === "reject") {
      const reason = text(flags, "reason");
      try {
        const result = await rejectDraft(ctx, { docId: resolved.docId, locale, expectedVersion, ...(reason === undefined ? {} : { reason }) });
        return { data: result, lines: [`rejected ${label} ${locale} v${result.version}`] };
      } catch (err) {
        const stale = staleResult(err);
        if (stale === undefined) throw err;
        return stale;
      }
    }

    // approve. The CLI adds no warning check of its own: core refuses a draft whose warnings are not all acknowledged.
    let edits: Record<string, unknown> = {};
    const editFile = text(flags, "edit-file");
    if (editFile !== undefined) {
      const content = readFileSync(editFile, "utf8");
      const found = await draftReviewOf(ctx, resolved.docId, locale, label);
      if ("none" in found) return found.none;
      const parse = editFile.toLowerCase().endsWith(".json") ? parseJsonEditFile : parseEditFile;
      edits = parse(content, found.review, kindsOf(ctx, found.review.collection)); // only the CHANGED fields
    }
    const reject = rejectFields(flags);
    const ack = flags["ack-warning"];
    try {
      const result = await approve(ctx, {
        docId: resolved.docId,
        locale,
        expectedVersion,
        ...(Object.keys(edits).length === 0 ? {} : { edits }),
        ...(reject === undefined ? {} : { rejectFields: reject }),
        ...(Array.isArray(ack) ? { acknowledgedWarnings: ack } : {}),
      });
      return { data: result, lines: [`approved ${label} ${locale} v${result.version}`] };
    } catch (err) {
      const stale = staleResult(err);
      if (stale === undefined) throw err;
      return stale;
    }
  },
};
