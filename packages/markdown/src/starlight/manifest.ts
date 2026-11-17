import fs from "node:fs";
import path from "node:path";
import { assertNoSymlink, writeFileAtomic } from "./fsSafe.js";

/** One file Mogging's export wrote or adopted (spec 5.4): where, which document and locale, and what the bytes hash to. */
export type ManifestEntry = {
  /** POSIX path relative to the project root. */
  path: string;
  slug: string;
  /** BCP 47 tag. */
  locale: string;
  /** The published version exported; informational, never compared. */
  version: number;
  /** SHA-256 of the file's bytes on disk, lowercase hex. */
  sha256: string;
};

/** The manifest's path, relative to the project root. */
export const MANIFEST_PATH = ".mogging/manifest.json";

const HEX64 = /^[0-9a-f]{64}$/;

/** Validates one parsed entry; returns it with the documented key order, or `null`. */
function entryOf(v: unknown): ManifestEntry | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const { path: p, slug, locale, version, sha256 } = o as Record<string, unknown>;
  if (typeof p !== "string" || p === "" || typeof slug !== "string" || typeof locale !== "string") return null;
  if (typeof version !== "number" || !Number.isInteger(version) || typeof sha256 !== "string" || !HEX64.test(sha256)) return null;
  return { path: p, slug, locale, version, sha256 };
}

/**
 * Reads `.mogging/manifest.json`. A missing file is empty. A corrupt file (not JSON, another version, a malformed
 * entry), or one reached through a symbolic link, is empty with a warning, so nothing becomes removable (D9); the
 * next export rewrites it. Entries are not checked against any layout here.
 *
 * @param root absolute project root.
 * @returns the entries in file order (a repeated path keeps its last entry) and the warning, or `null`.
 */
export function readManifest(root: string): { entries: ManifestEntry[]; warning: string | null } {
  try {
    assertNoSymlink(root, MANIFEST_PATH);
  } catch (e) {
    return { entries: [], warning: `manifest ${MANIFEST_PATH} is reached through a symbolic link (${(e as Error).message}); ignored` };
  }
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, ".mogging", "manifest.json"), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { entries: [], warning: null };
    return { entries: [], warning: `manifest ${MANIFEST_PATH} cannot be read (${(e as Error).message}); treated as empty` };
  }
  const corrupt = (why: string): { entries: ManifestEntry[]; warning: string } => ({
    entries: [], warning: `manifest ${MANIFEST_PATH} is corrupt (${why}); treated as empty and rewritten by the next export`,
  });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) { return corrupt((e as Error).message); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return corrupt("not an object");
  const o = parsed as Record<string, unknown>;
  if (o["version"] !== 1) return corrupt("unsupported version");
  if (!Array.isArray(o["files"])) return corrupt('no "files" list');
  const byPath = new Map<string, ManifestEntry>();
  for (const raw of o["files"] as unknown[]) {
    const e = entryOf(raw);
    if (e === null) return corrupt("malformed entry");
    byPath.set(e.path, e);
  }
  return { entries: [...byPath.values()], warning: null };
}

/**
 * Writes `.mogging/manifest.json`: `{"version":1,"files":[`, one compact entry per line sorted by path, `]}`. The
 * file is written to a temporary file in `.mogging/` and renamed; identical content is not rewritten.
 *
 * @param root absolute project root.
 * @param entries the entries; a repeated path keeps its last entry.
 * @throws {SymlinkError} when `.mogging` or the manifest is a symbolic link; nothing is written.
 */
export function writeManifest(root: string, entries: ManifestEntry[]): void {
  assertNoSymlink(root, MANIFEST_PATH);
  const byPath = new Map<string, ManifestEntry>();
  for (const e of entries) byPath.set(e.path, e);
  const lines = [...byPath.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => JSON.stringify({ path: e.path, slug: e.slug, locale: e.locale, version: e.version, sha256: e.sha256 }));
  const text = `{"version":1,"files":[\n${lines.map((l, i) => (i < lines.length - 1 ? `${l},` : l)).join("\n")}${lines.length > 0 ? "\n" : ""}]}\n`;
  try {
    if (fs.readFileSync(path.join(root, ".mogging", "manifest.json"), "utf8") === text) return;
  } catch { /* absent or unreadable: write it */ }
  writeFileAtomic(root, MANIFEST_PATH, text);
}
