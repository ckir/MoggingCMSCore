import fs from "node:fs";
import path from "node:path";
import type { Sql } from "postgres";
import {
  ConflictError, ValidationError, getDocument, hashValue, publish, saveDraft,
} from "@mogging/core";
import type { Collection, Ctx, DocumentRecord, Snapshot } from "@mogging/core";
import type { ExportAction } from "../export.js";
import type { RichTextRoot } from "../tree.js";
import { sameLocalized } from "./classify.js";
import { readStarlightFile, splitPage } from "./frontMatter.js";
import { assertNoSymlink, moveFile } from "./fsSafe.js";
import { canonical } from "./importStarlight.js";
import type { StarlightLayout } from "./layout.js";
import { readManifest, writeManifest } from "./manifest.js";
import type { ManifestEntry } from "./manifest.js";
import { rebaseTree, rebaseValueAt } from "./rebase.js";
import { scanDocs } from "./scan.js";
import type { ScannedFile } from "./scan.js";
import { deriveSlug } from "./slugs.js";

type Rec = Record<string, unknown>;

/** The input of `renamePage`. */
export type RenameInput = {
  /** Absolute project root. */
  dir: string;
  /** The validated Starlight layout. */
  layout: StarlightLayout;
  /** The current slug of the page. */
  from: string;
  /** The new slug, in the derived form (`deriveSlug` of itself plus an extension equals itself). */
  to: string;
  /** Plan and check only: nothing is written, moved or saved. */
  dryRun?: boolean;
};

/** What `renamePage` did (or, in a dry run, would do). */
export type RenameReport = {
  dryRun: boolean;
  /** Every file move, in execution order: the English file, then the locale files by locale tag. Each has `action: "move"` and `reason: "rename"`. */
  actions: ExportAction[];
  /** Every line of `astro.config.*` and of the Markdown files under the docs folder that holds the old slug as text. Empty in a dry run. */
  references: Array<{ file: string; line: number; text: string }>;
  /** A reminder that old URLs need a redirect and that sidebar entries are not edited. */
  reminder: string;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isPlain = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const posixAbs = (root: string, rel: string): string => path.join(root, ...rel.split("/"));

/** Extensions of the Markdown files the reference search reads (Starlight's own list). */
const MARKDOWN = /\.(md|mdx|markdown|mdown|mkdn|mkd|mdwn|mdoc)$/i;

const REMINDER =
  "Old URLs need a redirect: add one to the `redirects` of astro.config.* from the old slug to the new one. " +
  "Starlight fails the build when a sidebar entry names a slug that no longer exists; the lines listed under " +
  "`references` were not edited, update them by hand.";

/** Validates `to` before anything is read or written (spec 5.6). */
function checkTo(layout: StarlightLayout, to: string): void {
  if (typeof to !== "string" || to === "") throw new ValidationError("rename: the new slug is empty");
  if (to.includes("\0")) throw new ValidationError("rename: the new slug holds U+0000");
  let derived: string;
  try {
    derived = deriveSlug(`${to}.md`);
  } catch (e) {
    throw new ValidationError(`rename: "${to}" is not a valid slug (${msg(e)})`);
  }
  if (derived !== to) {
    throw new ValidationError(`rename: "${to}" is not the derived slug form; use "${derived}" (lowercase, one dash for spaces, no extension)`);
  }
  const segments = to.split("/");
  if (segments[segments.length - 1]!.startsWith("_")) {
    throw new ValidationError(`rename: the last segment of "${to}" starts with "_", so the page would be skipped as a partial`);
  }
  if (layout.sourceDir === null) {
    // Root-locale mode: a first folder named like a locale folder would turn the English page into a locale page.
    const first = segments[0]!;
    const taken = [...Object.values(layout.localeDirs), ...layout.otherLocaleDirs];
    if (segments.length > 1 && taken.includes(first)) {
      throw new ValidationError(`rename: "${to}" would sit in the locale folder "${first}", which is not an English folder`);
    }
  }
}

/** Whether `snap` (any scope) holds a relative file reference: a body image, an ESM specifier or a `fileRefs` leaf. */
function holdsRelativeRef(layout: StarlightLayout, col: Collection, snap: Snapshot): boolean {
  for (const [k, v] of Object.entries(snap.data)) {
    const field = Object.hasOwn(col.fields, k) ? col.fields[k] : undefined;
    if (field === undefined) continue;
    if (field.body && isPlain(v) && v["type"] === "root") {
      // Moving a file from a folder to the root changes every relative reference and no other (rebase.ts).
      const r = rebaseTree(v as unknown as RichTextRoot, "d/f.md", "f.md");
      if (r.errors.length > 0 || JSON.stringify(r.tree) !== JSON.stringify(v)) return true;
    }
    for (const ref of layout.fileRefs) {
      const [head, ...leaf] = ref.split(".") as [string, ...string[]];
      if (head === k && rebaseValueAt(v, leaf, "d/f.md", "f.md") !== v) return true;
    }
  }
  return false;
}

/** The scope names of `doc` (and the snapshot) that hold a relative file reference, for the refusal message. */
function relativeRefsOf(layout: StarlightLayout, col: Collection, doc: DocumentRecord): string[] {
  const out: string[] = [];
  const scopes: Array<[string, { published: Snapshot | null; draft: Snapshot | null }]> = [["shared", doc.shared]];
  for (const locale of Object.keys(doc.locales).sort(byText)) scopes.push([locale, doc.locales[locale]!]);
  for (const [name, pair] of scopes) {
    for (const [kind, snap] of [["published", pair.published], ["draft", pair.draft]] as const) {
      if (snap !== null && holdsRelativeRef(layout, col, snap)) out.push(`${name} ${kind} head`);
    }
  }
  return out;
}

/** One planned file move. */
type Move = { from: string; to: string };

/** The plan: moves in execution order, and the path every locale's file will have afterwards. */
type Plan = { moves: Move[]; finals: Map<string, string> };

/** The canonical parsed content of a page file, rebased to `toPath` so two files at different places compare. */
function parsedOf(root: string, layout: StarlightLayout, col: Collection, rel: string, toPath: string): { shared: Rec; localized: Rec } {
  const text = fs.readFileSync(posixAbs(root, rel), "utf8");
  const split = splitPage(layout, col, readStarlightFile(text), rel.endsWith(".mdx") ? "mdx" : "md");
  const canon = canonical(layout, col, rel, split.shared, split.localized, toPath);
  if (canon.errors.length > 0) throw new ValidationError(canon.errors[0]!);
  return { shared: canon.shared, localized: canon.localized };
}

/** Whether `a` and `b` are one file on disk (a case-insensitive file system, a hard link). */
function sameFile(root: string, a: string, b: string): boolean {
  try {
    const x = fs.statSync(posixAbs(root, a));
    const y = fs.statSync(posixAbs(root, b));
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** Whether a path exists (a dangling link counts). */
function present(root: string, rel: string): boolean {
  try {
    fs.lstatSync(posixAbs(root, rel));
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}

/**
 * Plans every file move (spec 5.6, step 2): the English file and each locale file whose derived slug is `from`.
 * A file whose slug is already `to` (after a `git mv`) is where the page now lives and is not moved. A move
 * target that exists is acceptable only when it is the same file or holds the same parsed content; otherwise
 * `ConflictError`, before anything is written.
 */
function planMoves(
  root: string, layout: StarlightLayout, col: Collection, sourceLocale: string, from: string, to: string,
  scan: ReturnType<typeof scanDocs>,
): Plan {
  const docsAbs = posixAbs(root, layout.docsDir);
  const moves: Move[] = [];
  const finals = new Map<string, string>();
  const locales = [sourceLocale, ...Object.keys(layout.localeDirs).sort(byText)];

  for (const locale of locales) {
    const files: ScannedFile[] = (locale === sourceLocale ? scan.sources : scan.locales).filter((f) => f.locale === locale);
    const atFrom = files.filter((f) => f.slug === from);
    const atTo = from === to ? [] : files.filter((f) => f.slug === to);
    for (const f of [...atFrom, ...atTo]) {
      if (f.error !== null) throw new ValidationError(`rename: ${f.path} cannot be used (${f.error}); fix it first`);
    }
    if (atFrom.length === 0) {
      if (atTo[0] !== undefined) finals.set(locale, atTo[0].path);
      continue;
    }
    const f = atFrom[0]!;
    const folder = f.path === f.rel ? "" : f.path.slice(0, f.path.length - f.rel.length - 1);
    const target = atTo[0]?.path ?? `${folder === "" ? "" : `${folder}/`}${to}${f.ext}`;
    finals.set(locale, target);
    if (target === f.path) continue;

    if (!path.resolve(posixAbs(root, target)).startsWith(docsAbs + path.sep)) {
      throw new ValidationError(`rename: ${target} is outside the docs folder`);
    }
    assertNoSymlink(root, f.path);
    assertNoSymlink(root, target);
    if (present(root, target) && !sameFile(root, f.path, target)) {
      let same = false;
      try {
        const a = parsedOf(root, layout, col, f.path, target);
        const b = parsedOf(root, layout, col, target, target);
        same = sameLocalized(layout, col, a.localized, b.localized)
          && (locale !== sourceLocale || hashValue(a.shared) === hashValue(b.shared));
      } catch {
        same = false;
      }
      if (!same) {
        throw new ConflictError(
          `rename: cannot move ${f.path} to ${target}: the target exists with different content (or cannot be read); ` +
            "compare the two files and remove or merge one",
        );
      }
    }
    moves.push({ from: f.path, to: target });
  }
  return { moves, finals };
}

/** Whether a shared draft or published head already holds `to`; what the database step must do. */
function dbStep(doc: DocumentRecord, to: string): "none" | "publish" | "save" {
  const pub = doc.shared.published;
  const draft = doc.shared.draft;
  if (pub !== null && pub.data["slug"] === to) return "none";
  if (draft !== null && draft.data["slug"] === to && (draft.state === "DRAFT_HUMAN" || draft.state === "APPROVED")) return "publish";
  return "save";
}

/** Saves the whole shared head with only the slug changed and publishes it (or publishes the draft that holds `to`). */
async function applyDb(ctx: Ctx, doc: DocumentRecord, from: string, to: string, step: "publish" | "save"): Promise<void> {
  await ctx.sql.begin(async (tx) => {
    const tctx: Ctx = { ...ctx, sql: tx as unknown as Sql };
    if (step === "save") {
      const pub = doc.shared.published;
      const draft = doc.shared.draft;
      const base = pub?.data["slug"] === from ? pub : draft?.data["slug"] === from ? draft : (pub ?? draft);
      if (base === null || base === undefined) throw new ValidationError(`rename: "${from}" has no shared head to save`);
      const head = draft ?? pub;
      await saveDraft(tctx, {
        docId: doc.id, locale: "shared", data: { ...base.data, slug: to },
        ...(head === null ? {} : { expectedVersion: head.version }),
      });
    }
    await publish(tctx, { docId: doc.id, locale: "shared" });
  });
}

/** Collects the files of `rel` (under `root`) that are Markdown, not following links; paths are project-relative. */
function markdownUnder(root: string, rel: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(posixAbs(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) markdownUnder(root, child, out);
    else if (e.isFile() && MARKDOWN.test(e.name)) out.push(child);
  }
}

/** Lists every line of `astro.config.*` and of the Markdown files under the docs folder that contains `slug`. */
function searchReferences(root: string, layout: StarlightLayout, slug: string): RenameReport["references"] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() && /^astro\.config\./.test(e.name)) files.push(e.name);
    }
  } catch { /* an unreadable root has no config to search */ }
  markdownUnder(root, layout.docsDir, files);
  const out: RenameReport["references"] = [];
  for (const file of files.sort(byText)) {
    let text: string;
    try {
      assertNoSymlink(root, file);
      text = fs.readFileSync(posixAbs(root, file), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (clean.includes(slug)) out.push({ file, line: i + 1, text: clean });
    });
  }
  return out;
}

/**
 * Renames a page's slug and keeps its document and every locale's history (spec 5.6). Order: validate and plan
 * (`ValidationError` or `ConflictError` before anything is written), the database (the whole shared head saved
 * with only the slug changed, then published; core's guard refuses a duplicate slug), the file moves, the
 * manifest, then the search for the old slug in `astro.config.*` and the Markdown under the docs folder. Every
 * step is idempotent, so running it again completes an interrupted rename; the document is found by `from`, or by
 * `to` when the database step already ran. A file already at the new path (a `git mv` done first) is not moved.
 * Files are renamed with their own extension; folders are created as needed; empty old folders are left.
 *
 * @param ctx engine context; the database step is core's licence-guarded `saveDraft` and `publish`.
 * @param input the project root, layout, old and new slug, and the optional `dryRun`.
 * @returns the moves (planned in a dry run, which stops after planning), the references to the old slug, and a
 * reminder about redirects.
 * @throws {ValidationError} for a `to` that is not a derived-form slug, whose last segment starts with `_`, that
 * would leave the docs folder or sit in a locale folder; for an unknown `from`; for a duplicate slug; for a depth
 * change when the page or any translation holds a relative file reference.
 * @throws {ConflictError} when a move target exists with different parsed content (the message names both files).
 * @throws {LicenceError} when core's licence guard refuses the database step.
 */
export async function renamePage(ctx: Ctx, input: RenameInput): Promise<RenameReport> {
  const { dir: root, layout, from, to } = input;
  const dryRun = input.dryRun === true;
  const col = ctx.config.collections.find((c) => c.name === layout.collection);
  if (col === undefined) throw new ValidationError(`rename: the collection "${layout.collection}" is not declared`);
  if (typeof from !== "string" || from === "" || from.includes("\0")) throw new ValidationError("rename: the old slug is empty or holds U+0000");
  checkTo(layout, to);

  // (1) The document: live by `from`, else live by `to` (the database step already ran).
  const live = async (slug: string): Promise<DocumentRecord | null> => {
    const d = await getDocument(ctx, { collection: col.name, slug });
    return d !== null && d.deletedAt === null ? d : null;
  };
  const doc = (await live(from)) ?? (await live(to));
  if (doc === null) throw new ValidationError(`rename: no live document has the slug "${from}" (or "${to}")`);
  const holder = from === to ? null : await live(to);
  if (holder !== null && holder.id !== doc.id) {
    throw new ValidationError(`Slug "${to}" is already used by another document in collection "${col.name}"`);
  }

  // (2) Plan every move; refuse a conflict and a depth change before any write.
  const scan = scanDocs(root, layout, ctx.config);
  const plan = planMoves(root, layout, col, ctx.config.locales.source, from, to, scan);
  const step = dbStep(doc, to);
  if ((step !== "none" || plan.moves.length > 0) && from.split("/").length !== to.split("/").length) {
    const where = relativeRefsOf(layout, col, doc);
    if (where.length > 0) {
      throw new ValidationError(
        `rename: "${from}" to "${to}" changes the folder depth and the page holds relative file references ` +
          `(${where.join(", ")}); the stored references would need rebasing. Move the page by hand`,
      );
    }
  }
  const actions: ExportAction[] = plan.moves.map((m) => ({ action: "move", path: m.from, to: m.to, reason: "rename" }));
  if (dryRun) return { dryRun, actions, references: [], reminder: REMINDER };

  // (3) Database first.
  if (step !== "none") await applyDb(ctx, doc, from, to, step);

  // (4) Files.
  for (const m of plan.moves) moveFile(root, m.from, m.to);

  // (5) Manifest: every entry of the old slug follows its file.
  const { entries } = readManifest(root);
  let changed = false;
  const next: ManifestEntry[] = entries.map((e) => {
    if (e.slug !== from || !Object.hasOwn(layout.localeDirs, e.locale)) return e;
    // A locale whose file is gone gets the path export would write it to, so the entry never keeps the old slug.
    const now = plan.finals.get(e.locale)
      ?? `${layout.docsDir}/${layout.localeDirs[e.locale]!}/${to}${e.path.endsWith(".mdx") ? ".mdx" : ".md"}`;
    changed = true;
    return { ...e, slug: to, path: now };
  });
  if (changed) writeManifest(root, next);

  // (6) References to the old slug.
  return { dryRun, actions, references: searchReferences(root, layout, from), reminder: REMINDER };
}
