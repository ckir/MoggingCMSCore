import fs from "node:fs";
import path from "node:path";
import type { Sql } from "postgres";
import {
  ValidationError, createDocument, deleteDocument, getDocuments, hashValue, listDocuments, listLocaleRows,
  listPublishedVersions, normalizeValue,
} from "@mogging/core";
import type { Collection, Ctx, DocumentRecord, HeadPair } from "@mogging/core";
import { beginWriteRun, publishWithinRun, saveDraftWithinTx } from "@mogging/core/internal";
import type { Tx, WriteRun } from "@mogging/core/internal";
import type {
  FileMessage, FileOutcome, ImportInput, ImportReport, SafetyStop, StarlightImportOptions,
} from "../import.js";
import { classifyEarlier, classifyHeads, missingLocalized } from "./classify.js";
import type { FileClass } from "./classify.js";
import { rebaseTree, rebaseValueAt } from "./rebase.js";
import type { StarlightLayout } from "./layout.js";
import { readStarlightFile, splitPage } from "./frontMatter.js";
import { scanDocs } from "./scan.js";
import type { Scan, ScannedFile } from "./scan.js";
import type { RichTextRoot } from "../tree.js";

type Rec = Record<string, unknown>;

/** The most documents one `listDocuments` page returns here (and so the most one `getDocuments` call reads). */
const PAGE = 200;

/** One scope (`shared` or the source locale) of a page, with the data the file says it must hold. */
type ScopePlan = {
  locale: string;
  data: Rec;
  /** What the apply phase does with this scope: nothing, publish the existing draft head, or save and publish. */
  act: "none" | "publish" | "save";
};

/** A readable source page: its canonical values and the document it matched (the locale pass reads these). */
type SourcePage = {
  file: ScannedFile;
  /** The front matter's `title` when it is a string. */
  title: string | null;
  /** The document whose published or draft slug is the file's slug, or `null` for a new page. */
  record: DocumentRecord | null;
  /** The shared values, `slug` included, canonical. */
  shared: Rec;
  /** The source-locale values, canonical. */
  localized: Rec;
  /** A new page the run does not create (a `draft: true` file, or held back by the safety stop). */
  skipped: boolean;
};

/** A source page with something to write and what the run will do with each scope. */
type PagePlan = {
  file: ScannedFile;
  /** The document whose published or draft slug is the file's slug, or `null` for a new page. */
  record: DocumentRecord | null;
  scopes: ScopePlan[];
};

/** Everything phase 1 computed. Phase 2 (and a later locale pass) only reads it and fills `outcomes`. */
type Plan = {
  ctx: Ctx;
  options: StarlightImportOptions;
  col: Collection;
  scan: Scan;
  outcomes: Map<string, FileOutcome>;
  warnings: FileMessage[];
  errors: Map<string, string>;
  /** Every readable source page, written or not. */
  pages: SourcePage[];
  /** Pages with something to write (a new document, a save or a publish). */
  writes: PagePlan[];
  /** Documents the prune soft-deletes, in slug order. */
  prune: Array<{ id: string; slug: string }>;
  stop: SafetyStop | null;
  unsupported: string[];
  /** The live documents by published slug, then by draft slug (the locale pass finds a page's document here). */
  bySlug: Map<string, DocumentRecord>;
  /** The guard-once write run, created lazily by {@link writeRun} at the first write; `null` until then. */
  run: Promise<WriteRun> | null;
};

/**
 * The write run of this import: runs the licence and actor guards on the first call and returns the same promise
 * afterwards, so one import makes at most one successful licence read. A `LicenceError` stays cached (the import
 * aborts on it); any other failure (a database error on the licence read, a NUL actor) is not cached, so the next
 * call runs the guards again and one failed read costs one file. Never called for a dry run, an all-unchanged run
 * or a prune-only run, and never from inside a per-file loop's transaction.
 *
 * @param plan the plan whose context the guards read.
 * @returns the run handle (config and actor only).
 * @throws {LicenceError} when the evaluation has ended without a key.
 * @throws {ValidationError} for an actor containing U+0000.
 * @throws {Error} a database error from the licence read.
 */
function writeRun(plan: Plan): Promise<WriteRun> {
  plan.run ??= beginWriteRun(plan.ctx).catch((e: unknown) => {
    if (!isNamed(e, "LicenceError")) plan.run = null;
    throw e;
  });
  return plan.run;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Name-based error test: a user config may load a second copy of core (AGENTS.md, CLI). */
const isNamed = (e: unknown, name: string): boolean => e instanceof Error && e.name === name;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isPlain(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** The slug a snapshot holds, or `null`. */
function slugOf(s: { data: Rec } | null): string | null {
  return s !== null && typeof s.data["slug"] === "string" ? s.data["slug"] : null;
}

/** Whether a draft head can be published as it is (`DRAFT_AI` never can, spec 3). */
const publishable = (state: string): boolean => state === "DRAFT_HUMAN" || state === "APPROVED";

/**
 * Brings the values of a file to the stored canonical form: the body's image sources and ESM specifiers and the
 * layout's `fileRefs` are rebased from the file to `toPath` (`img.png` becomes `./img.png`; an English file is
 * rebased to itself, a locale file to its English page), then every value is normalized again (`normalizeValue` also
 * refuses a NUL).
 *
 * @returns the canonical shared and localized values and the rebasing errors (an `mdxjsEsm` block that did not parse).
 */
export function canonical(
  layout: StarlightLayout, col: Collection, filePath: string, shared: Rec, localized: Rec, toPath: string = filePath,
): { shared: Rec; localized: Rec; errors: string[] } {
  const errors: string[] = [];
  const bodyName = Object.entries(col.fields).find(([, f]) => f.body)?.[0];
  const fix = (scope: Rec, isLocalized: boolean): Rec => {
    const out: Rec = {};
    for (const [k, v] of Object.entries(scope)) {
      let value = v;
      if (k === bodyName && isPlain(value)) {
        const r = rebaseTree(value as unknown as RichTextRoot, filePath, toPath);
        errors.push(...r.errors);
        value = r.tree;
      }
      if (isLocalized) {
        for (const ref of layout.fileRefs) {
          const [head, ...leaf] = ref.split(".") as [string, ...string[]];
          if (head === k) value = rebaseValueAt(value, leaf, filePath, toPath);
        }
      }
      out[k] = normalizeValue(col.fields[k]!, value, k);
    }
    return out;
  };
  return { shared: fix(shared, false), localized: fix(localized, true), errors };
}

/** Decides what the apply phase does with one scope given its current heads. */
function decide(pair: HeadPair | undefined, data: Rec): ScopePlan["act"] {
  const published = pair?.published ?? null;
  const draft = pair?.draft ?? null;
  if (Object.keys(data).length === 0 && published === null && draft === null) return "none";
  const hash = hashValue(data);
  if (published !== null && hashValue(published.data) === hash) return "none";
  if (draft !== null && publishable(draft.state) && hashValue(draft.data) === hash) return "publish";
  return "save";
}

/**
 * Phase 1 for the source pages: scans the docs folder, reads every source file, reads the collection's documents a
 * page at a time, and computes every outcome, the safety stop and the prune list. Nothing is written.
 */
async function planSource(ctx: Ctx, input: ImportInput & { starlight: StarlightImportOptions }): Promise<Plan> {
  const options = input.starlight;
  const { layout } = options;
  let st: fs.Stats | null = null;
  try { st = fs.statSync(input.dir); } catch { st = null; }
  if (st === null || !st.isDirectory()) throw new ValidationError(`import directory not found: ${input.dir}`);
  const col = ctx.config.collections.find((c) => c.name === layout.collection);
  if (col === undefined) throw new ValidationError(`Starlight layout: unknown collection "${layout.collection}"`);

  const sourceLocale = ctx.config.locales.source;
  const scan = scanDocs(input.dir, layout, ctx.config);
  const srcUnsupported = scan.unsupported.filter((u) => u.locale === sourceLocale);
  const srcLinks = scan.symlinks.filter((l) => l.locale === sourceLocale);
  if (scan.sources.length === 0) {
    throw new ValidationError(`no source file found under ${layout.docsDir} (a wrong directory or an empty checkout?)`);
  }

  const warnings: FileMessage[] = [...scan.warnings];
  const unsupported = scan.unsupported.map((u) => u.path).sort(byText);
  if (unsupported.length > 0) {
    warnings.push({
      file: layout.docsDir,
      message: `${unsupported.length} file(s) with a Starlight extension Mogging does not import (only .md and .mdx): ${unsupported.join(", ")}`,
    });
  }

  const outcomes = new Map<string, FileOutcome>();
  const errors = new Map<string, string>();
  const setOutcome = (file: string, outcome: FileOutcome["outcome"], docId: string | null, published = false): void => {
    outcomes.set(file, { file, docId, outcome, published });
  };

  // ---- Read the source files --------------------------------------------------------------------------------
  const sources = [...scan.sources].sort((a, b) => byText(a.path, b.path));
  const readable: Array<{ file: ScannedFile; title: string | null; draft: boolean; shared: Rec; localized: Rec }> = [];
  const unreadable: string[] = [];
  for (const f of sources) {
    if (f.error !== null) { errors.set(f.path, f.error); unreadable.push(f.path); continue; }
    try {
      const english = readStarlightFile(fs.readFileSync(path.join(input.dir, ...f.path.split("/")), "utf8"));
      const split = splitPage(layout, col, english, f.ext === ".mdx" ? "mdx" : "md");
      const canon = canonical(layout, col, f.path, split.shared, split.localized);
      if (canon.errors.length > 0) throw new ValidationError(canon.errors[0]!);
      for (const w of split.warnings) warnings.push({ file: f.path, message: w });
      readable.push({
        file: f,
        title: typeof english.data["title"] === "string" ? english.data["title"] : null,
        draft: english.data["draft"] === true,
        shared: canon.shared,
        localized: canon.localized,
      });
    } catch (e) {
      errors.set(f.path, msg(e));
      unreadable.push(f.path);
    }
  }
  for (const l of srcLinks) unreadable.push(l.path);

  // ---- Read the collection's documents, a page at a time ------------------------------------------------------
  const records: DocumentRecord[] = [];
  for (let after: string | undefined;;) {
    const page = await listDocuments(ctx, { collection: col.name, limit: PAGE, after, includeDeleted: false });
    if (page.items.length > 0) {
      records.push(...(await getDocuments(ctx, { collection: col.name, docIds: page.items.map((i) => i.id) })));
    }
    if (page.next === null) break;
    after = page.next;
  }
  const live = records.filter((r) => r.deletedAt === null);
  type Doc = { rec: DocumentRecord; pub: string | null; draft: string | null };
  const docs: Doc[] = live.map((rec) => ({ rec, pub: slugOf(rec.shared.published), draft: slugOf(rec.shared.draft) }))
    .filter((d) => d.pub !== null || d.draft !== null);
  const byPub = new Map<string, Doc>();
  const byDraft = new Map<string, Doc>();
  for (const d of docs) {
    if (d.pub !== null && !byPub.has(d.pub)) byPub.set(d.pub, d);
    if (d.draft !== null && !byDraft.has(d.draft)) byDraft.set(d.draft, d);
  }

  // A file claims the document holding its slug as the published slug first, then (an interrupted rename) as the
  // draft slug; a document is claimed by one file only.
  const claimed = new Map<Doc, string>();
  const docOf = new Map<string, Doc>();
  for (const via of [byPub, byDraft]) {
    for (const f of sources) {
      if (f.slug === "" || docOf.has(f.path)) continue;
      const d = via.get(f.slug);
      if (d !== undefined && !claimed.has(d)) { claimed.set(d, f.path); docOf.set(f.path, d); }
    }
  }

  // ---- Gone and new ---------------------------------------------------------------------------------------------
  // A document is found when its published or draft slug has a source file in ANY state: read, errored, colliding,
  // another Starlight extension, a file link; or lies under a linked folder (never followed).
  const seen = new Set<string>();
  for (const f of sources) if (f.slug !== "") seen.add(f.slug);
  for (const u of srcUnsupported) seen.add(u.slug);
  for (const l of srcLinks) if (l.kind === "file") seen.add(l.slug);
  const folders = srcLinks.filter((l) => l.kind === "folder").map((l) => `${l.slug}/`);
  const found = (slug: string | null): boolean =>
    slug !== null && (seen.has(slug) || folders.some((p) => slug.startsWith(p)));
  const titleOf = (rec: DocumentRecord): string | null => {
    const t = rec.locales[sourceLocale]?.published?.data["title"];
    return typeof t === "string" ? t : null;
  };
  const gone = docs.filter((d) => !found(d.pub) && !found(d.draft))
    .map((d) => ({ doc: d, slug: (d.pub ?? d.draft)! }))
    .sort((a, b) => byText(a.slug, b.slug));
  const fresh = readable.filter((r) => !docOf.has(r.file.path));
  const added = fresh.map((r) => ({ file: r.file.path, slug: r.file.slug, title: r.title }));

  // Prune never runs past a source entry it could not read (a new `draft: true` page is not one).
  if (options.prune === true && unreadable.length > 0) {
    throw new ValidationError(
      `prune refused: these source entries could not be read, so no document can be called gone: ${unreadable.sort(byText).join(", ")}`,
    );
  }

  let stop: SafetyStop | null = null;
  if (gone.length > 0 && added.length > 0 && options.acceptNewAndGone !== true) {
    stop = {
      gone: gone.map((g) => ({ slug: g.slug, title: titleOf(g.doc.rec) })),
      added,
      command: gone.length === 1 && added.length === 1 ? `mogging rename ${gone[0]!.slug} ${added[0]!.slug}` : null,
    };
  }
  const prune = options.prune === true && stop === null ? gone.map((g) => ({ id: g.doc.rec.id, slug: g.slug })) : [];

  // ---- Outcomes ---------------------------------------------------------------------------------------------------
  for (const f of sources) {
    if (errors.has(f.path)) setOutcome(f.path, "error", docOf.get(f.path)?.rec.id ?? null);
  }
  const writes: PagePlan[] = [];
  const pages: SourcePage[] = [];
  const slugField = col.fields["slug"]!;
  for (const r of readable) {
    const filePath = r.file.path;
    const doc = docOf.get(filePath) ?? null;
    const shared: Rec = { slug: normalizeValue(slugField, r.file.slug, "slug"), ...r.shared };
    const skipped = doc === null && (r.draft || stop !== null);
    pages.push({ file: r.file, title: r.title, record: doc?.rec ?? null, shared, localized: r.localized, skipped });
    if (skipped) { setOutcome(filePath, "skipped", null); continue; }
    const scopes: ScopePlan[] = [
      { locale: "shared", data: shared, act: decide(doc?.rec.shared, shared) },
      { locale: sourceLocale, data: r.localized, act: decide(doc?.rec.locales[sourceLocale], r.localized) },
    ];
    if (doc === null) {
      // A new document: saved and published, except a localized scope with nothing in it.
      for (const s of scopes) s.act = Object.keys(s.data).length === 0 && s.locale !== "shared" ? "none" : "save";
    }
    const acts = scopes.some((s) => s.act !== "none");
    if (!acts) { setOutcome(filePath, "unchanged", doc!.rec.id, false); continue; }
    setOutcome(filePath, doc === null ? "created" : "updated", doc?.rec.id ?? null, true);
    writes.push({ file: r.file, record: doc?.rec ?? null, scopes });
  }

  const bySlug = new Map<string, DocumentRecord>();
  for (const [slug, d] of byPub) bySlug.set(slug, d.rec);
  for (const [slug, d] of byDraft) if (!bySlug.has(slug)) bySlug.set(slug, d.rec);

  return { ctx, options, col, scan, outcomes, warnings, errors, pages, writes, prune, stop, unsupported, bySlug, run: null };
}

/**
 * Phase 2 for the source pages: one transaction per page (the document if new, the saves, then the publishes), then
 * the prune. A page that fails becomes an `error` outcome and the run goes on; a licence error aborts it.
 */
async function applySource(plan: Plan): Promise<void> {
  const { ctx, col } = plan;
  const inTx = <T>(fn: (tx: Tx, tctx: Ctx) => Promise<T>): Promise<T> =>
    ctx.sql.begin(async (tx) => fn(tx, { ...ctx, sql: tx as unknown as Sql })) as Promise<T>;

  for (const page of plan.writes) {
    try {
      // The guards run here, once per import, before the page's transaction opens (a refusal leaves no document row).
      const run = await writeRun(plan);
      const docId = await inTx(async (tx, tctx) => {
        const id = page.record?.id ?? (await createDocument(tctx, { collection: col.name })).id;
        let locked = false;
        for (const s of page.scopes) {
          if (s.act === "save") {
            await saveDraftWithinTx(tx, run, { docId: id, locale: s.locale, data: s.data }, col.name);
            locked = true;
          }
        }
        for (const s of page.scopes) {
          if (s.act !== "none") {
            await publishWithinRun(tx, run, { docId: id, locale: s.locale }, { collection: col.name, alreadyLocked: locked });
            locked = true;
          }
        }
        return id;
      });
      plan.outcomes.set(page.file.path, { file: page.file.path, docId, outcome: page.record === null ? "created" : "updated", published: true });
    } catch (e) {
      if (isNamed(e, "LicenceError")) throw e;
      plan.errors.set(page.file.path, msg(e));
      plan.outcomes.set(page.file.path, { file: page.file.path, docId: page.record?.id ?? null, outcome: "error", published: false });
    }
  }

  for (const doc of plan.prune) {
    try {
      await deleteDocument(ctx, { docId: doc.id });
    } catch (e) {
      // Already deleted by a concurrent prune: the goal is met.
      if (!isNamed(e, "NotFoundError")) throw e;
    }
  }
}

/** The most document ids one `listLocaleRows` or `listPublishedVersions` call takes. */
const CHUNK = 1000;

const FOLLOWS = "export will write the English value the next time it writes this file";

/** What the apply phase does with one locale file. */
type LocaleAct =
  | { kind: "none" }
  | { kind: "save"; untracked: boolean; publish: boolean }
  | { kind: "publish" };

/** A locale file with the document it belongs to and what the run does with it. */
type LocaleItem = {
  file: ScannedFile;
  /** The document, or `null` for a page this run creates (its id is read from the page's outcome at apply). */
  record: DocumentRecord | null;
  /** The source file of a page the run creates; `null` when `record` is set. */
  pageFile: string | null;
  data: Rec;
  act: LocaleAct;
};

/** Everything the locale pass computed. */
type LocalePlan = {
  items: LocaleItem[];
  /** Project-relative paths of the files that equal an earlier published version, sorted. */
  behind: string[];
};

/** Whether `v` holds something: any value but `undefined`, `null` and an empty object. */
const present = (v: unknown): boolean => v !== undefined && v !== null && !(isPlain(v) && Object.keys(v).length === 0);

/** Whether two values (either may be absent) are equal as canonical JSON. */
const sameValue = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined ? a === b : hashValue({ v: a }) === hashValue({ v: b });

/**
 * The value of the front-matter key `draft` in a canonical shared record: the field a plain layout entry maps it to,
 * else the passthrough's `draft` key.
 *
 * @returns `true`/`false` when the record carries it as a boolean, otherwise `undefined`.
 */
function draftOf(layout: StarlightLayout, shared: Rec): boolean | undefined {
  const entry = layout.entries.find((e) => e.kind === "plain" && e.path.length === 1 && e.path[0] === "draft");
  const v = entry !== undefined && entry.kind === "plain"
    ? shared[entry.field]
    : isPlain(shared[layout.passthrough]) ? (shared[layout.passthrough] as Rec)["draft"] : undefined;
  return typeof v === "boolean" ? v : undefined;
}

/**
 * The follows-English report of one locale file (spec 5.9): every key whose value the file sets and English does
 * not set the same way, once per key, and every unmapped key only the file has. The draft key and the union toggles
 * are handled by their own rules. Each message starts with `<key>: `.
 */
function followsReport(
  layout: StarlightLayout, file: { shared: Rec; localized: Rec }, english: Rec,
): string[] {
  const out: string[] = [];
  for (const e of layout.entries) {
    const key = e.path.join(".");
    if (e.kind === "plain") {
      if (e.localized || key === "draft") continue;
      if (Object.hasOwn(file.shared, e.field) && !sameValue(file.shared[e.field], english[e.field])) out.push(`${key}: ${FOLLOWS}`);
    } else {
      // `true` means "use the generated link", the same as absent (spec 5.9): only `false` is a setting.
      const fileToggle = file.shared[e.toggle] === false ? false : undefined;
      const englishToggle = english[e.toggle] === false ? false : undefined;
      const fileHas = Object.hasOwn(file.shared, e.toggle) || present(file.localized[e.value]);
      if (fileHas && fileToggle !== englishToggle) out.push(`${key}: ${FOLLOWS}`);
    }
  }
  const own = file.shared[layout.passthrough];
  const theirs = english[layout.passthrough];
  if (isPlain(own)) {
    for (const k of Object.keys(own).sort(byText)) {
      if (k === "draft") continue;
      if (!isPlain(theirs) || !Object.hasOwn(theirs, k)) {
        out.push(`${k}: not mapped by the layout; export drops it when it rewrites this file`);
      } else if (!sameValue(own[k], theirs[k])) {
        out.push(`${k}: ${FOLLOWS}`);
      }
    }
  }
  return out;
}

/**
 * Phase 1 for the locale files (spec 5.3, 5.4, 5.9): finds each file's document, reads and canonicalizes it,
 * classifies it (against the heads of the plan's page reads, then, for the files that matched neither head and whose
 * locale has rows, against the earlier published versions in one batched read per locale), applies `--restore`, the
 * follows-English report and the locale-draft rule, and decides what the apply phase does. Nothing is written.
 */
async function planLocales(
  plan: Plan, input: ImportInput & { starlight: StarlightImportOptions },
): Promise<LocalePlan> {
  const { ctx, col, scan, options } = plan;
  const { layout } = options;
  const sourceLocale = ctx.config.locales.source;
  const files = [...scan.locales].sort((a, b) => byText(a.path, b.path));
  const restore = new Set(options.restore ?? []);
  // A `--restore` path that names no scanned locale file (a typo, an absolute or `./` path, an English file) would
  // otherwise be ignored without a word: it is an error, listed under the path as given.
  const scannedPaths = new Set(files.map((f) => f.path));
  for (const p of [...restore].sort(byText)) {
    if (!scannedPaths.has(p)) plan.errors.set(p, "restore: no locale file at this path");
  }
  const pageBySlug = new Map<string, SourcePage>(plan.pages.map((p) => [p.file.slug, p]));
  const sourcePathBySlug = new Map<string, string>(scan.sources.filter((s) => s.slug !== "").map((s) => [s.slug, s.path]));
  const sourceBase = layout.sourceDir === null ? layout.docsDir : `${layout.docsDir}/${layout.sourceDir}`;
  const pruned = new Set(plan.prune.map((p) => p.id));
  const setOutcome = (file: string, outcome: FileOutcome["outcome"], docId: string | null): void => {
    plan.outcomes.set(file, { file, docId, outcome, published: false });
  };

  type Cand = {
    file: ScannedFile;
    page: SourcePage | null;
    record: DocumentRecord | null;
    localized: Rec;
    shared: Rec;
  };
  const cands: Cand[] = [];
  for (const f of files) {
    if (f.error !== null) { plan.errors.set(f.path, f.error); setOutcome(f.path, "error", null); continue; }
    // (1) the document: a page of this run (new pages included), else a live document holding the slug.
    const page = pageBySlug.get(f.slug) ?? null;
    let record: DocumentRecord | null = null;
    let live = false;
    if (page !== null) {
      live = !page.skipped;
      record = page.record;
    } else {
      const found = plan.bySlug.get(f.slug);
      if (found !== undefined && !pruned.has(found.id)) { record = found; live = true; }
    }
    if (!live) {
      plan.warnings.push({ file: f.path, message: `no live document for the slug "${f.slug}"; the file is not imported` });
      setOutcome(f.path, "skipped", null);
      continue;
    }
    // (2) read, split, un-rebase to the English page's place.
    try {
      const english = sourcePathBySlug.get(f.slug) ?? `${sourceBase}/${f.rel}`;
      const parsed = readStarlightFile(fs.readFileSync(path.join(input.dir, ...f.path.split("/")), "utf8"));
      const split = splitPage(layout, col, parsed, f.ext === ".mdx" ? "mdx" : "md");
      const canon = canonical(layout, col, f.path, split.shared, split.localized, english);
      if (canon.errors.length > 0) throw new ValidationError(canon.errors[0]!);
      for (const w of split.warnings) plan.warnings.push({ file: f.path, message: w });
      cands.push({ file: f, page, record, localized: canon.localized, shared: canon.shared });
    } catch (e) {
      plan.errors.set(f.path, msg(e));
      setOutcome(f.path, "error", record?.id ?? null);
    }
  }

  // The (document, locale) pairs that have a row of any state: one call per chunk of documents.
  const ids = [...new Set(cands.flatMap((c) => (c.record === null ? [] : [c.record.id])))];
  const rows = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const r of await listLocaleRows(ctx, { collection: col.name, docIds: ids.slice(i, i + CHUNK) })) {
      rows.add(`${r.docId}\0${r.locale}`);
    }
  }
  const hasRows = (c: Cand): boolean => c.record !== null && rows.has(`${c.record.id}\0${c.file.locale}`);

  // (3) classify against the heads; the earlier-version pass only for the files that matched neither head.
  const classes = new Map<Cand, FileClass>();
  const needEarlier = new Map<string, Cand[]>();
  for (const c of cands) {
    const pair = c.record?.locales[c.file.locale];
    const first = classifyHeads(layout, col, c.localized, {
      published: pair?.published?.data ?? null, draft: pair?.draft?.data ?? null,
    });
    if (first !== null) classes.set(c, first);
    else if (!hasRows(c)) classes.set(c, "hand work");
    else needEarlier.set(c.file.locale, [...(needEarlier.get(c.file.locale) ?? []), c]);
  }
  for (const [locale, group] of needEarlier) {
    const byDoc = new Map<string, Rec[]>();
    const docIds = [...new Set(group.map((c) => c.record!.id))];
    for (let i = 0; i < docIds.length; i += CHUNK) {
      for (const v of await listPublishedVersions(ctx, { collection: col.name, locale, docIds: docIds.slice(i, i + CHUNK) })) {
        byDoc.set(v.docId, [...(byDoc.get(v.docId) ?? []), v.data]);
      }
    }
    for (const c of group) classes.set(c, classifyEarlier(layout, col, c.localized, byDoc.get(c.record!.id) ?? []));
  }

  const items: LocaleItem[] = [];
  const behind: string[] = [];
  const unionValues = layout.entries.flatMap((e) => (e.kind === "union" ? [e.value] : []));
  for (const c of cands) {
    const f = c.file;
    const pair = c.record?.locales[f.locale];
    const warn = (message: string): void => { plan.warnings.push({ file: f.path, message }); };
    let cls = classes.get(c)!;

    // (4) --restore.
    const restored = restore.has(f.path);
    if (restored && cls === "published") warn("already current: the file equals the published translation; nothing was restored");
    if (restored && cls === "behind") cls = "hand work";
    if (cls === "behind") behind.push(f.path);

    // (5) the follows-English report.
    const english = c.page?.shared ?? c.record?.shared.published?.data ?? {};
    for (const m of followsReport(layout, c, english)) warn(m);

    // (6) the locale-draft rule.
    const fileDraft = draftOf(layout, c.shared);
    const englishDraft = draftOf(layout, english) === true;
    const localeDraft = fileDraft === true && !englishDraft;
    if (localeDraft && (cls === "hand work" || cls === "pending")) {
      warn("draft: the file says draft: true while the English page does not; its translation is kept as an unpublished draft and is not published while the flag stays");
    } else if (localeDraft && cls === "published") {
      warn(`draft: ${FOLLOWS}; a published translation is not withdrawn by this flag, run \`mogging unpublish --locale\` to withdraw it`);
    } else if (fileDraft !== undefined && fileDraft !== englishDraft) {
      warn(`draft: ${FOLLOWS}`);
    }

    // (7) and (8) what to write. A translation that lacks a field English has (spec 5.4's completeness rule, the one
    // export applies) is never published: a zero-byte file must not replace a good published translation.
    const missingFor = (cand: Cand): string[] =>
      missingLocalized(layout, col, cand.page?.localized ?? cand.record?.locales[sourceLocale]?.published?.data ?? {}, cand.localized);
    let act: LocaleAct = { kind: "none" };
    const dayOne = !hasRows(c);
    if (cls === "hand work" && !(dayOne && Object.keys(c.localized).length === 0)) {
      for (const name of unionValues) {
        if (present(c.localized[name])) continue;
        // The newer head carries it: the draft head when it is a human or approved draft, else the published head.
        // A DRAFT_AI head is never a source (AI text must not reach a human draft without `approve`).
        const head = pair?.draft != null && pair.draft.state !== "DRAFT_AI" ? pair.draft : pair?.published;
        const kept = head?.data[name];
        if (present(kept)) c.localized[name] = kept;
      }
      const missing = missingFor(c);
      if (missing.length > 0) warn(`incomplete translation (missing ${missing.join(", ")}); saved as an unpublished draft`);
      const draft = pair?.draft ?? null;
      const published = pair?.published ?? null;
      if (draft !== null) {
        const lost = draft.state !== "DRAFT_HUMAN" || published === null || draft.version > published.version;
        if (lost) {
          warn(`replaced ${draft.state === "DRAFT_HUMAN" ? "unpublished" : "pending"} ${draft.state} draft v${draft.version} for ${f.locale}`);
        }
      }
      act = { kind: "save", untracked: dayOne, publish: !localeDraft && missing.length === 0 && (dayOne || input.publish === true) };
    } else if (cls === "pending" && input.publish === true && !localeDraft && pair?.draft?.state === "DRAFT_HUMAN") {
      const missing = missingFor(c);
      if (missing.length === 0) act = { kind: "publish" };
      else warn(`incomplete translation (missing ${missing.join(", ")}); the pending draft is not published`);
    }

    items.push({ file: f, record: c.record, pageFile: c.record === null ? c.page!.file.path : null, data: c.localized, act });
    setOutcome(f.path, act.kind === "none" ? "unchanged" : "updated", c.record?.id ?? null);
    if (act.kind === "publish" || (act.kind === "save" && act.publish)) plan.outcomes.get(f.path)!.published = true;
  }
  return { items, behind: behind.sort(byText) };
}

/**
 * Phase 2 for the locale files: one transaction per file (the save, then the publish), after the source pages are
 * written, so a new page's document exists. The write run is created once, before the first file, and only when some
 * file will write. A `LicenceError` from creating it propagates and nothing is written for the locale files. Any
 * other guard failure (a database error on the licence read, a NUL actor) is held and thrown inside each writing
 * file's own try, so each such file becomes an `error` outcome and the import still returns its report. A file whose
 * write fails becomes an `error` outcome and the run goes on.
 *
 * @throws {LicenceError} when the evaluation has ended without a key.
 */
async function applyLocales(plan: Plan, lp: LocalePlan): Promise<void> {
  const { ctx } = plan;
  const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    ctx.sql.begin(async (tx) => fn(tx)) as Promise<T>;
  // The run is created before any item, and only when at least one item will write: it has something to do and its
  // document exists (a record, or a page this run created). An all-unchanged run never reads the licence, and a
  // refusal aborts the import here, before any locale file is written.
  const writes = (i: LocaleItem): boolean => {
    if (i.act.kind === "none") return false;
    if (i.record !== null) return true;
    const source = plan.outcomes.get(i.pageFile!);
    return source !== undefined && source.outcome !== "error" && source.docId !== null;
  };
  let run: WriteRun | null = null;
  let runError: unknown = null;
  if (lp.items.some(writes)) {
    try {
      run = await writeRun(plan);
    } catch (e) {
      if (isNamed(e, "LicenceError")) throw e;
      runError = e;
    }
  }

  for (const item of lp.items) {
    const path_ = item.file.path;
    let docId = item.record?.id ?? null;
    if (docId === null) {
      const source = plan.outcomes.get(item.pageFile!);
      docId = source !== undefined && source.outcome !== "error" ? source.docId : null;
      if (docId === null) {
        plan.warnings.push({ file: path_, message: "its English page was not imported; the file is not imported" });
        plan.outcomes.set(path_, { file: path_, docId: null, outcome: "skipped", published: false });
        continue;
      }
      plan.outcomes.get(path_)!.docId = docId;
    }
    const act = item.act;
    if (act.kind === "none") continue;
    const locale = item.file.locale;
    try {
      if (runError !== null) throw runError;
      await inTx(async (tx) => {
        const collection = plan.col.name;
        if (act.kind === "save") {
          await saveDraftWithinTx(tx, run!, { docId: docId!, locale, data: item.data, ...(act.untracked ? { untracked: true } : {}) }, collection);
          if (act.publish) await publishWithinRun(tx, run!, { docId: docId!, locale }, { collection, alreadyLocked: true });
        } else {
          await publishWithinRun(tx, run!, { docId: docId!, locale }, { collection, alreadyLocked: false });
        }
      });
    } catch (e) {
      plan.errors.set(path_, msg(e));
      plan.outcomes.set(path_, { file: path_, docId, outcome: "error", published: false });
    }
  }
}

/**
 * The Starlight mode of `importFolder` (spec 5.3 to 5.6): the source (English) pages first, then the locale files.
 * It is plan-then-apply: the
 * plan reads the files and the collection's documents (a page of documents at a time, never per file) and computes
 * every outcome; the apply writes one transaction per page, then prunes. English is always published. A `dryRun`
 * returns the plan's report and writes nothing. The locale files follow in a second plan-then-apply pass: day-one
 * translations are saved untracked and published, later files are classified (`published`, `pending` and `behind`
 * write nothing, `hand work` is saved as a human draft), and the follows-English report and the locale-draft rule
 * run on every file.
 *
 * @param ctx engine context; the licence-guarded writes check the licence and the actor.
 * @param input `dir` is the project root; `starlight` carries the layout and the flags.
 * @returns the per-file outcomes, warnings and errors, and the Starlight details (stop, pruned, unsupported).
 * @throws {ValidationError} when the directory is missing, the run found no source file at all, or `prune` is set
 * while a source entry could not be read.
 * @throws {LicenceError} when the evaluation has ended without a key (the run aborts at the first write, before any
 * transaction opens).
 * @throws {Error} a database error in the planning reads, or in the prune. A guard failure other than a
 * `LicenceError` (a database error on the licence read, an actor containing U+0000) does not escape: it costs the
 * files it hits, which come back as `error` outcomes.
 */
export async function importStarlight(
  ctx: Ctx, input: ImportInput & { starlight: StarlightImportOptions },
): Promise<ImportReport> {
  const plan = await planSource(ctx, input);
  const locales = await planLocales(plan, input);
  if (input.starlight.dryRun !== true) {
    await applySource(plan);
    await applyLocales(plan, locales);
  }
  const files = [...plan.outcomes.values()].sort((a, b) => byText(a.file, b.file));
  const errors: FileMessage[] = [...plan.errors].map(([file, message]) => ({ file, message })).sort((a, b) => byText(a.file, b.file));
  return {
    files,
    warnings: plan.warnings,
    errors,
    starlight: {
      dryRun: input.starlight.dryRun === true,
      stop: plan.stop,
      pruned: plan.prune.map((p) => p.slug),
      behind: locales.behind,
      unsupported: plan.unsupported,
    },
  };
}
