import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { listGlossary } from "@mogging/ai";
import { approve, approveClean, getDocument, getDraftReview, listDraftHeads, normalizeLocale, rejectDraft } from "@mogging/core";
import type { Ctx, DraftHead, DraftReview } from "@mogging/core";
import { intOption } from "../args.js";
import { applyEdits, parseEditFile, parseJsonEditFile, serializeEditFile } from "../editFile.js";
import { describeError, table } from "../output.js";
import { renderDraftReview } from "../render.js";
import { resolveTarget } from "../target.js";
import { UsageError } from "../types.js";
import type { CommandEnv, CommandResult, CommandSpec, Flags, Io } from "../types.js";
import { draftHeads, isRefusal, labelOf } from "./publish.js";
import { exitRule } from "./worker.js";

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

const MENU = "[a]pprove [r]eject [e]dit [s]kip [q]uit";
const POST_EDIT = "[a]pprove [s]kip";

type Counts = { approved: number; rejected: number; skipped: number; conflicted: number; failed: number };
type Outcome = keyof Counts | "gone" | "stop";
type Pair = { docId: string; locale: string };
type Reader = ReturnType<typeof lineReader>;

/**
 * The reviewer's answers: one `readline` interface over stdin, read ONLY through its `line` and `close` events
 * (`question()` never settles for a line that arrived before it was called and throws once the input has ended).
 */
function lineReader(io: Io, signal: AbortSignal) {
  const rl = createInterface({ input: io.stdin, terminal: false, crlfDelay: Infinity });
  const queue: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  let closed = false;
  const settle = (line: string | null) => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.(line);
  };
  rl.on("line", (line) => {
    if (waiting === undefined) queue.push(line);
    else settle(line);
  });
  rl.on("close", () => {
    closed = true;
    settle(null);
  });
  const onAbort = () => settle(null);
  signal.addEventListener("abort", onAbort);
  return {
    /** Discards what was typed ahead, prints `text`, and resolves with the next line, or `null` at end of input or abort. */
    async prompt(text: string): Promise<string | null> {
      queue.length = 0;
      if (closed || signal.aborted) return null;
      io.out(`${text} `);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    /** Runs `fn` (the editor) with the input paused, then lets what arrived meanwhile flush into the queue to be discarded. */
    async paused<T>(fn: () => Promise<T>): Promise<T> {
      rl.pause();
      try {
        return await fn();
      } finally {
        rl.resume();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    close() {
      signal.removeEventListener("abort", onAbort);
      rl.close();
    },
  };
}

/** The pending `DRAFT_AI` pairs in scope: those of one document, or the pages of `listDraftHeads` as they are reached. */
async function* pendingPairs(
  ctx: Ctx, scope: { collection?: string; locale?: string }, target: { collection: string; docId: string } | undefined,
): AsyncGenerator<Pair> {
  if (target !== undefined) {
    const doc = await getDocument(ctx, { collection: target.collection, docId: target.docId });
    if (doc === null) return;
    for (const h of draftHeads(doc, scope.locale)) {
      if (h.locale !== "shared" && h.draft.state === "DRAFT_AI") yield { docId: doc.id, locale: h.locale };
    }
    return;
  }
  let after: string | undefined;
  for (;;) {
    const page = await listDraftHeads(ctx, { state: "DRAFT_AI", ...scope, limit: PAGE_SIZE, ...(after === undefined ? {} : { after }) });
    for (const h of page.items) yield { docId: h.docId, locale: h.locale };
    if (page.next === null) return;
    after = page.next;
  }
}

const summaryLine = (c: Counts): string =>
  `approved ${c.approved}, rejected ${c.rejected}, skipped ${c.skipped}, conflicted ${c.conflicted}, failed ${c.failed}`;

/** One pair, from its review to its outcome; `stop` ends the whole session (`q`, end of input, abort). */
async function reviewPair(env: CommandEnv, reader: Reader, pair: Pair, say: (...lines: string[]) => void): Promise<Outcome> {
  const { ctx } = env.project;
  let review: DraftReview;
  try {
    review = await getDraftReview(ctx, pair);
  } catch (err) {
    if (nameOf(err) !== "NotFoundError") throw err;
    return "gone"; // the draft went away since the list was read
  }
  if (review.state !== "DRAFT_AI") return "gone";
  const label = `${labelOf(review)} ${review.locale}`;
  const kinds = kindsOf(ctx, review.collection);
  const glossary = await listGlossary(ctx, { sourceLocale: review.sourceLocale, targetLocale: review.locale });
  const show = (r: DraftReview) =>
    say("", ...renderDraftReview(r, kinds, { width: env.io.width ?? 100, color: env.io.color, glossary }));
  show(review);

  const warnings = [...new Set(review.fields.flatMap((f) => f.warnings).filter((w) => w !== ""))];
  /** One prompt per distinct warning text; `undefined` unless every one was answered `y`. */
  const acknowledge = async (): Promise<string[] | undefined> => {
    for (const w of warnings) {
      if ((await reader.prompt(`acknowledge "${w}"? [y/n]`))?.trim() !== "y") return undefined;
    }
    return warnings;
  };

  /** Runs `approve` or `rejectDraft`; `keep` is the edit file, which survives anything but a success. */
  const attempt = async (call: () => Promise<{ version: number }>, done: "approved" | "rejected", keep?: string): Promise<Outcome> => {
    try {
      const result = await call();
      say(`${done} ${label} v${result.version}`);
      return done;
    } catch (err) {
      const refusal = isRefusal(err);
      const outcome = nameOf(err) === "ConflictError" ? "conflicted" : "failed";
      if (refusal) say(`${outcome} ${label}: ${describeError(err).message}`);
      if (keep !== undefined) say(`edit file kept: ${keep}`);
      if (!refusal) throw err;
      return outcome;
    }
  };

  const approveArgs = (acks: string[], edits: Record<string, unknown>) => ({
    ...pair,
    expectedVersion: review.version,
    ...(Object.keys(edits).length === 0 ? {} : { edits }),
    ...(acks.length === 0 ? {} : { acknowledgedWarnings: acks }),
  });

  /** The `e` key. Returns `menu` when the step failed before its prompt: the reviewer is back at the menu. */
  const editStep = async (): Promise<Outcome | "menu"> => {
    let dir: string | undefined;
    let file: string | undefined;
    let edits: Record<string, unknown>;
    try {
      const content = serializeEditFile(review, kinds);
      dir = await mkdtemp(join(tmpdir(), "mogging-review-"));
      const written = join(dir, "edit.md");
      await writeFile(written, content, { flag: "wx", mode: 0o600 });
      file = written;
      await reader.paused(() => env.deps.editor(written));
      edits = parseEditFile(await readFile(written, "utf8"), review, kinds);
    } catch (err) {
      say(describeError(err).message);
      if (file !== undefined) say(`edit file kept: ${file}`);
      else if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      return "menu";
    }
    const kept = file!;
    const removeFile = () => rm(dir!, { recursive: true, force: true });
    show(applyEdits(review, edits));
    for (;;) {
      const answer = (await reader.prompt(POST_EDIT))?.trim();
      if (answer === undefined) {
        say(`edit file kept: ${kept}`);
        return "stop";
      }
      if (answer === "s") {
        await removeFile();
        say(`skipped ${label}`);
        return "skipped";
      }
      if (answer === "a") {
        const acks = await acknowledge();
        if (acks === undefined) continue;
        const outcome = await attempt(() => approve(ctx, approveArgs(acks, edits)), "approved", kept);
        if (outcome === "approved") await removeFile();
        return outcome;
      }
    }
  };

  for (;;) {
    const answer = (await reader.prompt(MENU))?.trim();
    if (answer === undefined || answer === "q") return "stop";
    if (answer === "s") {
      say(`skipped ${label}`);
      return "skipped";
    }
    if (answer === "a") {
      const acks = await acknowledge();
      if (acks === undefined) continue;
      return attempt(() => approve(ctx, approveArgs(acks, {})), "approved");
    }
    if (answer === "r") {
      const reason = await reader.prompt("reason (optional, enter to skip):");
      if (reason === null) return "stop";
      const text = reason.trim();
      return attempt(
        () => rejectDraft(ctx, { ...pair, expectedVersion: review.version, ...(text === "" ? {} : { reason: text }) }),
        "rejected",
      );
    }
    if (answer === "e") {
      const outcome = await editStep();
      if (outcome !== "menu") return outcome;
    }
  }
}

/** The interactive review: every pending AI draft in scope, one at a time, each decided by a person. */
async function interactiveReview(env: CommandEnv): Promise<CommandResult> {
  const { ctx } = env.project;
  const scope = scopeOf(ctx, env.flags);
  const first = env.positionals[0];
  const target = first === undefined ? undefined : await resolveTarget(ctx, first);
  const say = (...lines: string[]) => env.io.out(lines.map((l) => `${l}\n`).join(""));
  const counts: Counts = { approved: 0, rejected: 0, skipped: 0, conflicted: 0, failed: 0 };
  let reviewed = 0;
  const reader = lineReader(env.io, env.signal);
  try {
    for await (const pair of pendingPairs(ctx, scope, target)) {
      if (env.signal.aborted) break;
      const outcome = await reviewPair(env, reader, pair, say);
      if (outcome === "stop") {
        reviewed += 1; // a pair was shown, so there was something to review
        break;
      }
      if (outcome === "gone") continue;
      reviewed += 1;
      counts[outcome] += 1;
    }
  } catch (err) {
    say(summaryLine(counts)); // a licence refusal (or any other error) still ends with the summary, then propagates
    throw err;
  } finally {
    reader.close();
  }
  if (reviewed === 0) return { data: counts, lines: ["nothing to review"] };
  return {
    data: counts,
    lines: [summaryLine(counts)],
    ...exitRule(counts.conflicted + counts.failed, counts.approved + counts.rejected, {
      code: "ReviewFailed", message: `no draft was approved or rejected (conflicted ${counts.conflicted}, failed ${counts.failed})`,
    }),
  };
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
  validate(flags, positionals, io) {
    const r = route(flags, positionals);
    const label = labelFor(r);
    for (const name of FORM_OPTIONS) {
      if (flags[name] !== undefined && !r.accepts.includes(name)) throw new UsageError(`${label}: --${name} does not apply`);
    }
    if (r.form === "interactive") {
      if (flags.json === true) throw new UsageError("interactive review has no --json form (use `review list|show|approve|reject --json`)");
      if (!io.isTTY) {
        throw new UsageError("interactive review needs a terminal; use review list|show|approve|reject or --approve-clean");
      }
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

    if (r.form === "interactive") return interactiveReview(env);

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
