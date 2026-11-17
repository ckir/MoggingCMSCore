import fs from "node:fs";
import path from "node:path";
import type { Sql } from "postgres";
import {
  ValidationError, createDocument, deleteDocument, getDocuments, hashValue, listDocuments, normalizeValue, publish,
  saveDraft,
} from "@mogging/core";
import type { Collection, Ctx, DocumentRecord, HeadPair } from "@mogging/core";
import type {
  FileMessage, FileOutcome, ImportInput, ImportReport, SafetyStop, StarlightImportOptions,
} from "../import.js";
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
};

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
 * Brings the values of an English file to the stored canonical form: the body's image sources and ESM specifiers
 * and the layout's `fileRefs` are rebased from the file to itself (`img.png` becomes `./img.png`), then every value
 * is normalized again (`normalizeValue` also refuses a NUL).
 *
 * @returns the canonical shared and localized values and the rebasing errors (an `mdxjsEsm` block that did not parse).
 */
function canonical(
  layout: StarlightLayout, col: Collection, filePath: string, shared: Rec, localized: Rec,
): { shared: Rec; localized: Rec; errors: string[] } {
  const errors: string[] = [];
  const bodyName = Object.entries(col.fields).find(([, f]) => f.body)?.[0];
  const fix = (scope: Rec, isLocalized: boolean): Rec => {
    const out: Rec = {};
    for (const [k, v] of Object.entries(scope)) {
      let value = v;
      if (k === bodyName && isPlain(value)) {
        const r = rebaseTree(value as unknown as RichTextRoot, filePath, filePath);
        errors.push(...r.errors);
        value = r.tree;
      }
      if (isLocalized) {
        for (const ref of layout.fileRefs) {
          const [head, ...leaf] = ref.split(".") as [string, ...string[]];
          if (head === k) value = rebaseValueAt(value, leaf, filePath, filePath);
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

  return { ctx, options, col, scan, outcomes, warnings, errors, pages, writes, prune, stop, unsupported };
}

/**
 * Phase 2 for the source pages: one transaction per page (the document if new, the saves, then the publishes), then
 * the prune. A page that fails becomes an `error` outcome and the run goes on; a licence error aborts it.
 */
async function applySource(plan: Plan): Promise<void> {
  const { ctx, col } = plan;
  const inTx = <T>(fn: (tctx: Ctx) => Promise<T>): Promise<T> =>
    ctx.sql.begin(async (tx) => fn({ ...ctx, sql: tx as unknown as Sql })) as Promise<T>;

  for (const page of plan.writes) {
    try {
      const docId = await inTx(async (tctx) => {
        const id = page.record?.id ?? (await createDocument(tctx, { collection: col.name })).id;
        for (const s of page.scopes) {
          if (s.act === "save") await saveDraft(tctx, { docId: id, locale: s.locale, data: s.data });
        }
        for (const s of page.scopes) {
          if (s.act !== "none") await publish(tctx, { docId: id, locale: s.locale });
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

/**
 * The Starlight mode of `importFolder` (spec 5.3 to 5.6) for the source (English) pages. It is plan-then-apply: the
 * plan reads the files and the collection's documents (a page of documents at a time, never per file) and computes
 * every outcome; the apply writes one transaction per page, then prunes. English is always published. A `dryRun`
 * returns the plan's report and writes nothing. Locale files are not handled here yet; a later pass adds its own plan
 * step after `planSource` and its apply step after `applySource`.
 *
 * @param ctx engine context; the licence-guarded writes check the licence and the actor.
 * @param input `dir` is the project root; `starlight` carries the layout and the flags.
 * @returns the per-file outcomes, warnings and errors, and the Starlight details (stop, pruned, unsupported).
 * @throws {ValidationError} when the directory is missing, the run found no source file at all, or `prune` is set
 * while a source entry could not be read.
 * @throws {LicenceError} when the evaluation has ended without a key (the run aborts at the first write).
 */
export async function importStarlight(
  ctx: Ctx, input: ImportInput & { starlight: StarlightImportOptions },
): Promise<ImportReport> {
  const plan = await planSource(ctx, input);
  if (input.starlight.dryRun !== true) await applySource(plan);
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
      behind: [],
      unsupported: plan.unsupported,
    },
  };
}
