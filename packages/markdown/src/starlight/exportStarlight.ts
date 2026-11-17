import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ValidationError, getDocuments, listDocuments, listPublishedVersions } from "@mogging/core";
import type { Collection, Ctx, DocumentRecord, Snapshot } from "@mogging/core";
import type { ExportAction, ExportInput, ExportReport, StarlightExportOptions } from "../export.js";
import type { FileMessage } from "../import.js";
import { classifyEarlier, classifyHeads, sameLocalized } from "./classify.js";
import type { FileClass } from "./classify.js";
import { readAstroFrontMatter, readStarlightFile, splitPage } from "./frontMatter.js";
import type { StarlightFile } from "./frontMatter.js";
import { SymlinkError, assertNoSymlink, moveFile, removeFile, writeFileAtomic } from "./fsSafe.js";
import { canonical } from "./importStarlight.js";
import type { StarlightLayout } from "./layout.js";
import { MANIFEST_PATH, readManifest, writeManifest } from "./manifest.js";
import type { ManifestEntry } from "./manifest.js";
import { renderLocaleFile } from "./render.js";
import { scanDocs } from "./scan.js";
import type { ScannedFile } from "./scan.js";
import { deriveSlug } from "./slugs.js";

type Rec = Record<string, unknown>;

/** The most documents one `listDocuments` page returns (and so the most one `getDocuments` call reads). */
const PAGE = 200;
/** The most document ids one `listPublishedVersions` call takes. */
const CHUNK = 1000;
/** A leftover temporary file of an interrupted atomic write: `<target>.<hex>.mogging-tmp`. */
const LEFTOVER = /\.[0-9a-f]+\.mogging-tmp$/;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");
const isPlain = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
const extOf = (p: string): string => (p.endsWith(".mdx") ? ".mdx" : ".md");

/** Whether a stored value holds something: not absent, not an empty mapping, not a body tree without blocks. */
function has(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (isPlain(v)) {
    if (Object.keys(v).length === 0) return false;
    if (v["type"] === "root" && Array.isArray(v["children"]) && v["children"].length === 0) return false;
  }
  return true;
}

/** The English page of a document: its scanned file, the parsed text, and what Astro reads from its front matter. */
type EnglishPage = { file: ScannedFile; parsed: StarlightFile; astro: Rec; draft: boolean };

/** An existing locale file, read and classified. */
type Existing = {
  path: string;
  bytes: Buffer;
  parsed: StarlightFile | null;
  /** The file's localized values, canonical (relative to the English file); `null` when it could not be read. */
  localized: Rec | null;
  /** Why the file could not be classified, or `null`. */
  note: string | null;
  cls: FileClass | null;
};

/** One (document, locale) the run evaluates. */
type Slot = {
  doc: DocumentRecord;
  slug: string;
  locale: string;
  dir: string;
  english: EnglishPage;
  pub: Snapshot | null;
  draft: Snapshot | null;
  /** The single usable locale file of the slot, or `null`. */
  existing: Existing | null;
  /** Files the slot cannot classify (a name collision, an unreadable file): all are left alone and reported. */
  stuck: Array<{ path: string; note: string }>;
};

/** A file system operation of the apply phase. */
type Step = { t: "move"; from: string; to: string } | { t: "remove"; path: string } | { t: "write"; path: string; text: string };

/** The working state of one run. */
type Run = {
  root: string;
  docsAbs: string;
  layout: StarlightLayout;
  col: Collection;
  actions: ExportAction[];
  attention: FileMessage[];
  warnings: FileMessage[];
  steps: Step[];
  /** The manifest as the run changes it, by path. */
  manifest: Map<string, ManifestEntry>;
};

const act = (run: Run, action: ExportAction["action"], p: string, reason: string, to?: string): void => {
  run.actions.push({ action, path: p, ...(to === undefined ? {} : { to }), reason });
};
const warn = (run: Run, file: string, message: string): void => { run.warnings.push({ file, message }); };
const flag = (run: Run, file: string, message: string): void => { run.attention.push({ file, message }); };

/** Collects `*.<hex>.mogging-tmp` entries under `rel` (not followed through links), sorted by name. */
function sweepLeftovers(root: string, rel: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, ...rel.split("/")), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => byText(a.name, b.name))) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) sweepLeftovers(root, child, out);
    else if (LEFTOVER.test(e.name)) out.push(child);
  }
}

/** Why a manifest entry cannot be trusted for this layout, or `null` (spec 5.4: paths are never trusted). */
function entryProblem(layout: StarlightLayout, e: ManifestEntry): string | null {
  if (!Object.hasOwn(layout.localeDirs, e.locale)) return `"${e.locale}" is not a target locale`;
  const prefix = `${layout.docsDir}/${layout.localeDirs[e.locale]!}/`;
  if (!e.path.startsWith(prefix)) return "its path is outside the locale folder";
  const rel = e.path.slice(prefix.length);
  if (/[\\\0]/.test(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) return "its path is unsafe";
  if (!/\.mdx?$/.test(rel)) return "its path is not a Markdown or MDX file";
  try {
    if (deriveSlug(rel) !== e.slug) return `its path does not belong to the slug "${e.slug}"`;
  } catch (err) {
    return msg(err);
  }
  return null;
}

/** Removes the value at `keys` from `root` and every parent mapping the removal left empty. */
function prune(root: Rec, keys: readonly string[]): void {
  const chain: Rec[] = [root];
  let cur = root;
  for (const k of keys.slice(0, -1)) {
    const next = Object.hasOwn(cur, k) ? cur[k] : undefined;
    if (!isPlain(next)) return;
    chain.push(next);
    cur = next;
  }
  const last = keys[keys.length - 1]!;
  if (!Object.hasOwn(cur, last)) return;
  delete cur[last];
  for (let i = chain.length - 1; i >= 1; i--) {
    if (Object.keys(chain[i]!).length > 0) break;
    delete chain[i - 1]![keys[i - 1]!];
  }
}

/** The value at `keys` inside `root`, or `undefined`. */
function valueAt(root: Rec, keys: readonly string[]): unknown {
  let cur: unknown = root;
  for (const k of keys) {
    if (!isPlain(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Deep equality of two YAML values as Astro reads them: a `Date` compares by time, mappings by key set. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return a === b || (a !== a && b !== b);
}

/**
 * The keep test of spec 5.4 for a file that classifies `published`, without rendering: whether its follows-English
 * front matter equals what export would copy. Both sides are read with Astro's options (a plain date and a quoted
 * one differ); the localized mapped paths and union value forms are removed from both (with the parents they leave
 * empty); the file's top-level keys that English lacks and the layout does not map are ignored; each union toggle
 * must agree (`true` and absent are the same: only `false` is a setting); and a stored per-locale union value that
 * export would write, because English does not disable the link, must be in the file.
 */
function sameFollows(layout: StarlightLayout, english: Rec, file: Rec, fileLocalized: Rec, head: Rec): boolean {
  const e = structuredClone(english);
  const f = structuredClone(file);
  const mapped = new Set(layout.entries.map((x) => x.path[0]!));
  for (const entry of layout.entries) {
    if (entry.kind === "plain") {
      if (entry.localized) { prune(e, entry.path); prune(f, entry.path); }
      continue;
    }
    const englishOff = valueAt(e, entry.path) === false;
    if (englishOff !== (valueAt(f, entry.path) === false)) return false;
    if (!englishOff && has(head[entry.value]) && !has(fileLocalized[entry.value])) return false;
    prune(e, entry.path);
    prune(f, entry.path);
  }
  for (const k of Object.keys(f)) if (!Object.hasOwn(english, k) && !mapped.has(k)) delete f[k];
  return deepEqual(f, e);
}

/** The localized fields the published locale head must have because the English head has them (spec 5.4). */
function missingFields(run: Run, slot: Slot, sourceLocale: string): string[] {
  const english = slot.doc.locales[sourceLocale]?.published?.data ?? {};
  const head = slot.pub!.data;
  const out: string[] = [];
  for (const [name, f] of Object.entries(run.col.fields)) {
    if (!f.localized || !has(english[name])) continue;
    if ((f.required || f.body || run.layout.requiredWhenSource.includes(name)) && !has(head[name])) out.push(name);
  }
  return out;
}

/** The body field's name, or `undefined`. */
const bodyNameOf = (col: Collection): string | undefined => Object.entries(col.fields).find(([, f]) => f.body)?.[0];

/** A `{ k: rec[k] }` record, or `{}` when `rec` lacks `k`: the one comparison rule applied to one field. */
const pick = (rec: Rec, k: string): Rec => (Object.hasOwn(rec, k) ? { [k]: rec[k] } : {});

/**
 * Renders the locale file of `slot` at `targetRel` and checks it re-parses to the published content (spec 5.4).
 *
 * @returns the text, or a reason the page is skipped into attention (render errors, or a body that does not
 * survive a change of extension).
 * @throws {Error} `internal: export self-check failed for <path>: <field>` when the text does not re-parse to the
 * stored values and the body's mode did not change.
 */
function renderChecked(run: Run, slot: Slot, targetRel: string): { text: string } | { skip: string } {
  const { layout, col } = run;
  const mode = extOf(targetRel) === ".mdx" ? "mdx" : "md";
  const stored = slot.pub!.data;
  const bodyName = bodyNameOf(col);
  const storedBody = bodyName === undefined ? undefined : stored[bodyName];
  const storedMode = isPlain(storedBody) && (storedBody["mode"] === "md" || storedBody["mode"] === "mdx") ? storedBody["mode"] : null;
  const localized: Rec = { ...stored };
  if (bodyName !== undefined && isPlain(storedBody) && storedBody["type"] === "root") localized[bodyName] = { ...storedBody, mode };

  const englishPath = slot.english.file.path;
  const r = renderLocaleFile({
    layout, col, english: slot.english.parsed, englishPath, localePath: targetRel, localized,
  });
  for (const w of r.warnings) warn(run, targetRel, w);
  if (r.errors.length > 0) return { skip: r.errors.join("; ") };

  let got: Rec | null = null;
  let bad: string | null = null;
  try {
    const split = splitPage(layout, col, readStarlightFile(r.text), mode);
    const canon = canonical(layout, col, targetRel, split.shared, split.localized, englishPath);
    if (canon.errors.length > 0) throw new Error(canon.errors[0]);
    got = canon.localized;
  } catch (e) {
    bad = `the text does not parse (${msg(e)})`;
  }
  if (got !== null) {
    for (const k of [...new Set([...Object.keys(got), ...Object.keys(stored)])].sort(byText)) {
      if (!sameLocalized(layout, col, pick(got, k), pick(stored, k))) { bad = k; break; }
    }
  }
  if (bad === null) return { text: r.text };
  if (storedMode !== null && storedMode !== mode && (got === null || bad === bodyName)) {
    return { skip: `its body does not survive a change of extension to ${extOf(targetRel)}` };
  }
  throw new Error(`internal: export self-check failed for ${targetRel}: ${bad}`);
}

/** Lists every document of the collection, a page at a time, with its heads (`getDocuments`, never per file). */
async function loadDocuments(ctx: Ctx, collection: string): Promise<DocumentRecord[]> {
  const records: DocumentRecord[] = [];
  for (let after: string | undefined; ;) {
    const page = await listDocuments(ctx, { collection, limit: PAGE, ...(after === undefined ? {} : { after }) });
    if (page.items.length > 0) records.push(...(await getDocuments(ctx, { collection, docIds: page.items.map((i) => i.id) })));
    if (page.next === null) break;
    after = page.next;
  }
  return records;
}

/** Reads the English file of a document, or says why it cannot be used. */
function readEnglish(root: string, slug: string, candidates: ScannedFile[]): EnglishPage | string {
  const usable = candidates.filter((f) => f.error === null);
  if (candidates.length === 0) return `the English file of "${slug}" is missing at the document's slug path; its locale files are skipped`;
  if (usable.length !== 1) return `the English file of "${slug}" cannot be used (${candidates[0]!.error ?? "ambiguous"}); its locale files are skipped`;
  const file = usable[0]!;
  try {
    const parsed = readStarlightFile(fs.readFileSync(path.join(root, ...file.path.split("/")), "utf8"));
    return { file, parsed, astro: readAstroFrontMatter(parsed.frontMatter), draft: parsed.data["draft"] === true };
  } catch (e) {
    return `the English file ${file.path} cannot be read (${msg(e)}); its locale files are skipped`;
  }
}

/** Reads and canonicalizes one existing locale file; the class is set later. */
function readExisting(run: Run, file: ScannedFile, englishPath: string): Existing {
  const bytes = fs.readFileSync(path.join(run.root, ...file.path.split("/")));
  const base: Existing = { path: file.path, bytes, parsed: null, localized: null, note: null, cls: null };
  try {
    const parsed = readStarlightFile(bytes.toString("utf8"));
    const split = splitPage(run.layout, run.col, parsed, file.ext === ".mdx" ? "mdx" : "md");
    const canon = canonical(run.layout, run.col, file.path, split.shared, split.localized, englishPath);
    if (canon.errors.length > 0) throw new ValidationError(canon.errors[0]!);
    return { ...base, parsed, localized: canon.localized };
  } catch (e) {
    return { ...base, note: msg(e), cls: "hand work" };
  }
}

/** Records a refused write: the action and the attention entry. */
function refuse(run: Run, p: string, why: string): void {
  act(run, "refuse", p, why);
  flag(run, p, why);
}

/** Checks `rels` stay inside the docs folder and have no symbolic link; returns the first problem or `null`. */
function guard(run: Run, rels: readonly string[]): string | null {
  for (const rel of rels) {
    const full = path.resolve(run.root, ...rel.split("/"));
    if (!full.startsWith(run.docsAbs + path.sep)) return `${rel} is outside the docs folder`;
    try {
      assertNoSymlink(run.root, rel);
    } catch (e) {
      if (e instanceof SymlinkError) return e.message;
      throw e;
    }
  }
  return null;
}

/** Plans one slot: classification report, completeness, keep test, path reconciliation, render, self-check. */
function decide(run: Run, slot: Slot, sourceLocale: string): void {
  const { layout } = run;
  const ex = slot.existing;
  const targetRel = `${layout.docsDir}/${slot.dir}/${slot.english.file.rel}`;
  const mode = extOf(targetRel);

  for (const s of slot.stuck) {
    act(run, "skip", s.path, `cannot be classified: ${s.note}`);
    flag(run, s.path, `hand work: the file cannot be classified (${s.note}) and is left untouched`);
    run.manifest.delete(s.path);
  }
  if (slot.stuck.length > 0) return;

  if (ex !== null && (ex.cls === "pending" || ex.cls === "hand work")) {
    const localeDraft = ex.cls === "pending" && ex.parsed?.data["draft"] === true && !slot.english.draft;
    act(run, "skip", ex.path, localeDraft ? "pending (draft: true)" : ex.cls);
    if (!localeDraft) {
      flag(run, ex.path, ex.cls === "pending"
        ? "pending: the file equals an unpublished draft and is left untouched; review and publish it (import --publish)"
        : `hand work: the file differs from every stored translation and is left untouched; run import to save it as a draft${ex.note === null ? "" : ` (${ex.note})`}`);
    }
    run.manifest.delete(ex.path);
    return;
  }
  const pub = slot.pub;
  if (pub === null) return;
  if (missingFields(run, slot, sourceLocale).length > 0) {
    act(run, "skip", targetRel, "incomplete");
    return;
  }

  // Where the file is now against where it belongs.
  type Relation = "new" | "same" | "case" | "ext" | "name";
  let relation: Relation = "new";
  if (ex !== null) {
    relation = ex.path === targetRel ? "same"
      : ex.path.toLowerCase() === targetRel.toLowerCase() ? "case"
        : extOf(ex.path) !== mode ? "ext" : "name";
  }
  if (ex !== null && relation !== "same") {
    const listed = run.manifest.get(ex.path);
    const ours = relation === "case"
      ? ex.cls === "published" || ex.cls === "behind"
      : ex.cls === "published" && (relation === "name" || (listed !== undefined && listed.locale === slot.locale && listed.slug === slot.slug));
    if (!ours) {
      const why = `${ex.path} is a ${ex.cls} file under another name than ${targetRel}; both are left`;
      act(run, "skip", ex.path, "kept under its own name");
      act(run, "skip", targetRel, "not written: the English file's name differs");
      warn(run, ex.path, why);
      return;
    }
  }
  const problem = guard(run, ex !== null && relation !== "same" ? [targetRel, ex.path] : [targetRel]);
  if (problem !== null) { refuse(run, targetRel, problem); return; }

  const entryFor = (text: Buffer | string): ManifestEntry =>
    ({ path: targetRel, slug: slot.slug, locale: slot.locale, version: pub.version, sha256: sha256(text) });

  // The keep test: a published file at (or, after a case-only move, at) the right path whose follows-English front
  // matter already equals what export would copy is left byte for byte.
  if (ex !== null && ex.cls === "published" && (relation === "same" || relation === "case") && ex.parsed !== null && ex.localized !== null) {
    let keep = false;
    try {
      keep = sameFollows(layout, slot.english.astro, readAstroFrontMatter(ex.parsed.frontMatter), ex.localized, pub.data);
    } catch {
      keep = false;
    }
    if (keep) {
      if (relation === "case") {
        run.steps.push({ t: "move", from: ex.path, to: targetRel });
        act(run, "move", ex.path, "the English file's name differs only by letter case", targetRel);
        run.manifest.delete(ex.path);
      }
      act(run, "keep", targetRel, "published, equal to what export writes");
      run.manifest.set(targetRel, entryFor(ex.bytes));
      return;
    }
  }

  const rendered = renderChecked(run, slot, targetRel);
  if ("skip" in rendered) {
    act(run, "skip", targetRel, rendered.skip);
    flag(run, targetRel, `skipped: ${rendered.skip}${ex === null ? "" : `; ${ex.path} is left as it is`}`);
    return;
  }

  let reason = "new";
  if (ex === null) {
    const listed = run.manifest.get(targetRel);
    if (listed !== undefined && listed.locale === slot.locale && listed.slug === slot.slug) {
      reason = "recreated";
      warn(run, targetRel, "listed in the manifest but missing on disk; recreated from the published translation");
    }
  } else if (ex.cls === "behind") {
    reason = "behind";
    warn(run, targetRel, "behind: the file held an earlier translation; rewritten with the current published one");
  } else {
    reason = "differs from what export writes";
  }
  if (ex !== null && relation === "case") {
    run.steps.push({ t: "move", from: ex.path, to: targetRel });
    act(run, "move", ex.path, "the English file's name differs only by letter case", targetRel);
    run.manifest.delete(ex.path);
  } else if (ex !== null && relation !== "same") {
    run.steps.push({ t: "remove", path: ex.path });
    act(run, "remove", ex.path, `replaced by ${targetRel}`);
    run.manifest.delete(ex.path);
  }
  run.steps.push({ t: "write", path: targetRel, text: rendered.text });
  act(run, "write", targetRel, reason);
  run.manifest.set(targetRel, entryFor(rendered.text));
}

/**
 * The Starlight mode of `exportFolder` (spec 5.4, 5.5 manifest). It is plan-then-apply: the plan reads the English
 * files, the collection's documents (a page at a time) and every existing locale file, classifies those files
 * (`published`, `pending`, `behind`, `hand work`), decides keep or rewrite, renders and self-checks every file it
 * would write, and checks every target for symbolic links; nothing is written until the whole plan exists, so a
 * self-check failure throws before any file moves. The apply phase removes interrupted-run leftovers, moves,
 * removes and writes files one by one through a temporary file and a rename, then replaces `.mogging/manifest.json`.
 * English files are never written, moved or removed. Withdrawn documents and locales (removals) are not handled
 * here.
 *
 * @param ctx engine context (reads only).
 * @param input `dir` is the project root; `starlight` carries the layout, `dryRun` and `starlightLocaleDirs`;
 * `locales` restricts the target locales evaluated; `collections` is ignored.
 * @returns the files written, the warnings, and the actions and attention causes (`starlight`). A dry run reports the
 * same actions and writes nothing, so its `files` is empty.
 * @throws {ValidationError} when the project directory is missing or the layout's collection is unknown.
 * @throws {Error} `internal: export self-check failed for <path>: <field>` when a written file would not re-parse
 * to the published content.
 */
export async function exportStarlight(
  ctx: Ctx, input: ExportInput & { starlight: StarlightExportOptions },
): Promise<ExportReport> {
  const { layout } = input.starlight;
  const dryRun = input.starlight.dryRun === true;
  const localeDirs = input.starlight.starlightLocaleDirs ?? null;
  const root = path.resolve(input.dir);
  let st: fs.Stats | null = null;
  try { st = fs.statSync(root); } catch { st = null; }
  if (st === null || !st.isDirectory()) throw new ValidationError(`export directory not found: ${input.dir}`);
  const col = ctx.config.collections.find((c) => c.name === layout.collection);
  if (col === undefined) throw new ValidationError(`Starlight layout: unknown collection "${layout.collection}"`);
  const sourceLocale = ctx.config.locales.source;

  const run: Run = {
    root, docsAbs: path.resolve(root, ...layout.docsDir.split("/")), layout, col,
    actions: [], attention: [], warnings: [], steps: [], manifest: new Map(),
  };
  const finish = (files: string[]): ExportReport => {
    files.sort(byText);
    run.warnings.sort((a, b) => byText(`${a.file}\0${a.message}`, `${b.file}\0${b.message}`));
    return { files, warnings: run.warnings, starlight: { dryRun, actions: run.actions, attention: run.attention } };
  };

  let docsProblem: string | null = null;
  try {
    assertNoSymlink(root, layout.docsDir);
  } catch (e) {
    if (!(e instanceof SymlinkError)) throw e;
    docsProblem = e.message;
  }
  if (docsProblem !== null) {
    refuse(run, layout.docsDir, docsProblem);
    return finish([]);
  }

  // The manifest, with every entry checked against the layout.
  const mf = readManifest(root);
  if (mf.warning !== null) warn(run, MANIFEST_PATH, mf.warning);
  for (const e of mf.entries) {
    const bad = entryProblem(layout, e);
    if (bad === null) run.manifest.set(e.path, e);
    else warn(run, e.path, `manifest entry ignored: ${bad}`);
  }

  // Leftovers of an interrupted run (found with lstat, never followed).
  const leftovers: string[] = [];
  sweepLeftovers(root, layout.docsDir, leftovers);
  try {
    const m = fs.lstatSync(path.join(root, ".mogging"));
    if (m.isDirectory()) sweepLeftovers(root, ".mogging", leftovers);
  } catch { /* no .mogging folder */ }
  for (const p of leftovers) {
    run.steps.push({ t: "remove", path: p });
    act(run, "remove", p, "leftover of an interrupted run");
    warn(run, p, "leftover temporary file of an interrupted run; removed");
  }

  // Locales this run evaluates.
  const evaluated: string[] = [];
  for (const locale of Object.keys(layout.localeDirs)) {
    if (input.locales !== undefined && !input.locales.includes(locale)) continue;
    const dir = layout.localeDirs[locale]!;
    if (localeDirs !== null && !localeDirs.includes(dir)) {
      const folder = `${layout.docsDir}/${dir}`;
      const why = `the locale folder "${dir}" is not in Starlight's locales; nothing is written for ${locale}`;
      act(run, "skip", folder, why);
      flag(run, folder, why);
      continue;
    }
    evaluated.push(locale);
  }

  const scan = scanDocs(root, layout, ctx.config);
  const sourceBase = layout.sourceDir === null ? layout.docsDir : `${layout.docsDir}/${layout.sourceDir}`;
  const sourceBySlug = new Map<string, ScannedFile[]>();
  for (const f of scan.sources) sourceBySlug.set(f.slug, [...(sourceBySlug.get(f.slug) ?? []), f]);
  const localeFiles = new Map<string, ScannedFile[]>();
  for (const f of scan.locales) {
    const k = `${f.locale}\0${f.slug}`;
    localeFiles.set(k, [...(localeFiles.get(k) ?? []), f]);
  }

  // Slots.
  const docs = (await loadDocuments(ctx, col.name))
    .filter((d) => d.deletedAt === null)
    .map((doc) => ({ doc, slug: doc.shared.published?.data["slug"] }))
    .filter((d): d is { doc: DocumentRecord; slug: string } => typeof d.slug === "string" && d.slug !== "")
    .sort((a, b) => byText(a.slug, b.slug));
  const slots: Slot[] = [];
  for (const { doc, slug } of docs) {
    const candidates = sourceBySlug.get(slug) ?? [];
    let english: EnglishPage | string | null = null;
    for (const locale of evaluated) {
      const files = localeFiles.get(`${locale}\0${slug}`) ?? [];
      const pair = doc.locales[locale];
      const pub = pair?.published ?? null;
      if (files.length === 0 && pub === null) continue;
      english ??= readEnglish(root, slug, candidates);
      const dir = layout.localeDirs[locale]!;
      if (typeof english === "string") {
        for (const p of files.length > 0 ? files.map((f) => f.path) : [`${layout.docsDir}/${dir}/${slug}`]) {
          act(run, "skip", p, "English file missing or unreadable");
        }
        continue;
      }
      const slot: Slot = {
        doc, slug, locale, dir, english, pub, draft: pair?.draft ?? null, existing: null, stuck: [],
      };
      if (files.length > 1 || (files.length === 1 && files[0]!.error !== null)) {
        slot.stuck = files.map((f) => ({ path: f.path, note: f.error ?? "another file of this locale has the same slug" }));
      } else if (files.length === 1) {
        try {
          slot.existing = readExisting(run, files[0]!, english.file.path);
        } catch (e) {
          slot.stuck = [{ path: files[0]!.path, note: msg(e) }];
        }
      }
      slots.push(slot);
    }
    if (typeof english === "string") flag(run, candidates[0]?.path ?? `${sourceBase}/${slug}`, english);
  }

  // Classification: the heads first, then one batched read of earlier versions per locale.
  const needEarlier = new Map<string, Slot[]>();
  for (const slot of slots) {
    const ex = slot.existing;
    if (ex === null || ex.cls !== null || ex.localized === null) continue;
    const first = classifyHeads(layout, col, ex.localized, {
      published: slot.pub?.data ?? null, draft: slot.draft?.data ?? null,
    });
    if (first !== null) ex.cls = first;
    else needEarlier.set(slot.locale, [...(needEarlier.get(slot.locale) ?? []), slot]);
  }
  for (const [locale, group] of needEarlier) {
    const byDoc = new Map<string, Rec[]>();
    const ids = [...new Set(group.map((s) => s.doc.id))];
    for (let i = 0; i < ids.length; i += CHUNK) {
      for (const v of await listPublishedVersions(ctx, { collection: col.name, locale, docIds: ids.slice(i, i + CHUNK) })) {
        byDoc.set(v.docId, [...(byDoc.get(v.docId) ?? []), v.data]);
      }
    }
    for (const s of group) s.existing!.cls = classifyEarlier(layout, col, s.existing!.localized!, byDoc.get(s.doc.id) ?? []);
  }

  for (const slot of slots) decide(run, slot, sourceLocale);

  // The manifest write is checked for a link in both modes.
  let manifestRefused = false;
  try {
    assertNoSymlink(root, MANIFEST_PATH);
  } catch (e) {
    if (!(e instanceof SymlinkError)) throw e;
    manifestRefused = true;
    refuse(run, MANIFEST_PATH, e.message);
  }

  const files = run.steps.flatMap((s) => (s.t === "write" ? [s.path] : []));
  if (dryRun) return finish([]);
  for (const s of run.steps) {
    if (s.t === "move") moveFile(root, s.from, s.to);
    else if (s.t === "remove") removeFile(root, s.path);
    else writeFileAtomic(root, s.path, s.text);
  }
  if (!manifestRefused && (run.manifest.size > 0 || fs.existsSync(path.join(root, ".mogging", "manifest.json")))) {
    writeManifest(root, [...run.manifest.values()]);
  }
  return finish(files);
}
