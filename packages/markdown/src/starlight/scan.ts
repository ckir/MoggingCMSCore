import fs from "node:fs";
import path from "node:path";
import { slug as githubSlug } from "github-slugger";
import { normalizeLocale } from "@mogging/core";
import type { MoggingConfig } from "@mogging/core";
import type { FileMessage } from "../import.js";
import { isSafeSlug } from "../slug.js";
import { localeOfDir } from "./layout.js";
import type { StarlightLayout } from "./layout.js";
import { deriveSlug } from "./slugs.js";

/** One Markdown or MDX page file found under the docs folder. */
export type ScannedFile = {
  /** Project-relative POSIX path. */
  path: string;
  /** BCP 47 tag of the locale the file belongs to (never the folder name). */
  locale: string;
  /** POSIX path inside the locale folder (the docs folder in the root-locale mode for a source file). */
  rel: string;
  /** The slug derived from `rel`; `""` when none could be derived (then `error` says why). */
  slug: string;
  ext: ".md" | ".mdx";
  /** A per-file error that stops the file from being imported, or `null`. */
  error: string | null;
};

/** The result of scanning a Starlight docs folder; nothing in it was read or followed. */
export type Scan = {
  /** Source-locale pages. */
  sources: ScannedFile[];
  /** Target-locale pages (`locale` is the BCP 47 tag). */
  locales: ScannedFile[];
  /** Files with a Starlight extension Mogging does not support (F-GLOB). `slug` is relative to the locale folder. */
  unsupported: Array<{ path: string; locale: string; slug: string }>;
  /** Symbolic links, classified by name and never followed. `slug` is relative to the locale folder. */
  symlinks: Array<{ path: string; locale: string; slug: string; kind: "file" | "folder" }>;
  /** Skipped other-locale folders, non-regular files, links and the like. */
  warnings: FileMessage[];
};

/** Extensions Starlight's content glob reads (F-GLOB) plus `mdoc`, which Mogging lists as unsupported. */
const STARLIGHT_EXTS: ReadonlySet<string> = new Set([
  ".markdown", ".mdown", ".mkdn", ".mkd", ".mdwn", ".md", ".mdx", ".mdoc",
]);

/** Where a locale folder's files belong. */
type Place = {
  locale: string;
  isSource: boolean;
  /** Project-relative path of the folder the `rel` values are relative to. */
  base: string;
  /** Set on every file of a locale folder that collides with another folder of the same locale. */
  folderError: string | null;
};

const byName = (a: fs.Dirent, b: fs.Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The extension of `name` when it looks like one (a dot, then a letter first, so `v1.2` has none), else `""`. */
function extOf(name: string): string {
  const m = /\.[A-Za-z][A-Za-z0-9]*$/.exec(name);
  return m === null ? "" : m[0];
}

/** Slugifies a folder's path (each segment, no extension stripping); `null` when it has no safe slug. */
function folderSlug(rel: string): string | null {
  const parts = rel.split("/").map((p) => githubSlug(p.normalize("NFC")));
  if (parts.some((p) => p === "")) return null;
  const out = parts.join("/");
  return isSafeSlug(out) ? out : null;
}

/** Whether `name` is accepted by `normalizeLocale` with a 2-letter language (`es`, `pt-br`). */
function looksLikeLocale(name: string): boolean {
  try {
    return /^[a-z]{2}$/.test(normalizeLocale(name).split("-")[0]!);
  } catch {
    return false;
  }
}

const join = (a: string, b: string): string => (a === "" ? b : b === "" ? a : `${a}/${b}`);

/**
 * Walks a Starlight project's docs folder without following links and without reading any file, and sorts what it
 * finds into source pages, locale pages, unsupported-extension files, symbolic links and warnings (spec 5.2).
 *
 * Names starting with `.` are skipped, and so are files starting with `_` (folders starting with `_` are walked).
 * A top-level folder is matched to a target locale by its slugified name (`DE/` is German). A symbolic link is
 * classified by its name and never followed: a name with a Starlight extension is a `file`, any other name is a
 * `folder` (so a link such as `v1.x` or `logo.png` also blocks prune, the safe direction). Two files of one locale with one slug are both errors.
 *
 * @param root absolute project root.
 * @param layout a validated Starlight layout (`docsDir`, `sourceDir`, `localeDirs`, `otherLocaleDirs`).
 * @param config the validated config; its source locale names the source files' locale.
 * @returns the scan; empty (with a warning when the docs folder or a parent is a link) when the folder is absent.
 */
export function scanDocs(root: string, layout: StarlightLayout, config: MoggingConfig): Scan {
  const scan: Scan = { sources: [], locales: [], unsupported: [], symlinks: [], warnings: [] };
  const warn = (file: string, message: string): void => { scan.warnings.push({ file, message }); };
  const sourceLocale = config.locales.source;
  const ownFolder = layout.sourceDir !== null;

  // <docsDir> and every component below the project root: a link is a warning, never followed.
  let prefix = "";
  for (const seg of layout.docsDir.split("/")) {
    prefix = join(prefix, seg);
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(root, ...prefix.split("/"))); } catch { return scan; }
    if (st.isSymbolicLink()) {
      warn(prefix, "the docs folder (or one of its parents) is a symbolic link; it is not followed");
      return scan;
    }
    if (!st.isDirectory()) {
      warn(prefix, "the docs folder (or one of its parents) is not a directory");
      return scan;
    }
  }
  const docsAbs = path.join(root, ...layout.docsDir.split("/"));

  /**
   * Records a symbolic link by name, never following it: a name with a Starlight extension is a `file`; every other
   * name (no extension, or one such as `v1.x` or `logo.png`) is a `folder`, because the link may point at a folder of
   * pages whose slugs start with the name's slug.
   */
  const link = (name: string, rel: string, filePath: string, place: Place): void => {
    if (STARLIGHT_EXTS.has(extOf(name))) {
      if (name.startsWith("_")) return;
      try {
        scan.symlinks.push({ path: filePath, locale: place.locale, slug: deriveSlug(rel), kind: "file" });
      } catch {
        warn(filePath, "symbolic link not followed (its file name has no safe slug)");
      }
      return;
    }
    const slug = folderSlug(rel);
    if (slug === null) warn(filePath, "symbolic link not followed (its folder name has no safe slug)");
    else scan.symlinks.push({ path: filePath, locale: place.locale, slug, kind: "folder" });
  };

  /** Records a regular file by extension. */
  const file = (name: string, rel: string, filePath: string, place: Place): void => {
    if (name.startsWith("_")) return;
    const ext = extOf(name);
    if (ext === ".md" || ext === ".mdx") {
      let slug = "";
      let error: string | null = null;
      try { slug = deriveSlug(rel); } catch (e) { error = (e as Error).message; }
      const f: ScannedFile = { path: filePath, locale: place.locale, rel, slug, ext, error: place.folderError ?? error };
      (place.isSource ? scan.sources : scan.locales).push(f);
    } else if (STARLIGHT_EXTS.has(ext)) {
      try {
        scan.unsupported.push({ path: filePath, locale: place.locale, slug: deriveSlug(rel) });
      } catch {
        warn(filePath, "file with an unsupported extension has no safe slug");
      }
    }
  };

  /** Walks `abs` (the folder at `rel` inside the place's locale folder). */
  const walk = (abs: string, rel: string, place: Place): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort(byName)) {
      if (e.name.startsWith(".")) continue;
      const childRel = join(rel, e.name);
      const childPath = join(place.base, childRel);
      if (e.isSymbolicLink()) link(e.name, childRel, childPath, place);
      else if (e.isDirectory()) walk(path.join(abs, e.name), childRel, place);
      else if (e.isFile()) file(e.name, childRel, childPath, place);
      else if (!e.name.startsWith("_")) warn(childPath, "not a regular file; skipped");
    }
  };

  const top = fs.readdirSync(docsAbs, { withFileTypes: true }).sort(byName).filter((e) => !e.name.startsWith("."));
  const roleOf = (name: string): { locale: string; isSource: boolean } | null => {
    const s = githubSlug(name.normalize("NFC"));
    if (layout.sourceDir !== null && s === layout.sourceDir) return { locale: sourceLocale, isSource: true };
    const locale = localeOfDir(layout, s);
    return locale === null ? null : { locale, isSource: false };
  };
  const isOther = (name: string): boolean => layout.otherLocaleDirs.includes(githubSlug(name.normalize("NFC")));

  // Two real folders of one locale (`de/` and `DE/`) are both errors.
  const foldersOf = new Map<string, string[]>();
  for (const e of top) {
    if (!e.isDirectory()) continue;
    const role = roleOf(e.name);
    if (role !== null) foldersOf.set(role.locale, [...(foldersOf.get(role.locale) ?? []), e.name]);
  }
  const folderErrorOf = (locale: string, name: string): string | null => {
    const others = (foldersOf.get(locale) ?? []).filter((n) => n !== name);
    return others.length === 0 ? null : `locale folder collides with ${join(layout.docsDir, others[0]!)}`;
  };

  for (const e of top) {
    const topPath = join(layout.docsDir, e.name);
    const role = roleOf(e.name);

    if (role !== null || isOther(e.name)) {
      if (e.isSymbolicLink()) warn(topPath, "symbolic link not followed");
      else if (!e.isDirectory()) {
        if (!e.name.startsWith("_")) warn(topPath, "outside every locale folder");
      } else if (role === null) {
        warn(topPath, "skipped: a Starlight locale folder Mogging does not manage (otherLocaleDirs)");
      } else {
        walk(path.join(docsAbs, e.name), "", {
          locale: role.locale, isSource: role.isSource, base: topPath, folderError: folderErrorOf(role.locale, e.name),
        });
      }
      continue;
    }

    if (ownFolder) {
      // A top-level entry outside the source folder, every locale folder and otherLocaleDirs.
      if (e.isFile() || e.isDirectory() || e.isSymbolicLink()) {
        const skipped = e.name.startsWith("_") && !e.isDirectory();
        const ext = extOf(e.name);
        if (!skipped && (e.isDirectory() || e.isSymbolicLink() || STARLIGHT_EXTS.has(ext))) warn(topPath, "outside every locale folder");
      } else warn(topPath, "not a regular file; skipped");
      continue;
    }

    // Root-locale mode: everything else is English.
    const place: Place = { locale: sourceLocale, isSource: true, base: layout.docsDir, folderError: null };
    if (e.isSymbolicLink()) link(e.name, e.name, topPath, place);
    else if (e.isDirectory()) {
      if (looksLikeLocale(e.name)) {
        warn(topPath, `top-level folder "${e.name}" is imported as English pages; if it is a Starlight locale, list it in otherLocaleDirs`);
      }
      walk(path.join(docsAbs, e.name), e.name, place);
    } else if (e.isFile()) file(e.name, e.name, topPath, place);
    else if (!e.name.startsWith("_")) warn(topPath, "not a regular file; skipped");
  }

  // One locale, one slug: the files sharing it are all errors.
  for (const files of [scan.sources, scan.locales]) {
    const groups = new Map<string, ScannedFile[]>();
    for (const f of files) {
      if (f.slug === "") continue;
      const k = `${f.locale}\0${f.slug}`;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const twins = new Set(g.map((f) => f.ext)).size > 1;
      for (const f of g) {
        const other = g.find((x) => x !== f)!;
        f.error ??= twins ? "both .md and .mdx exist for this slug" : `slug collides with ${other.path}`;
      }
    }
  }
  return scan;
}
