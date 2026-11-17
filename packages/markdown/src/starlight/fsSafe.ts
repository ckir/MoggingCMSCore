import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Thrown when a path below the project root has a symbolic link in it (spec 5.4: export never writes through one). */
export class SymlinkError extends Error {
  /** The project-relative path of the first symbolic link found. */
  readonly link: string;

  constructor(link: string) {
    super(`refusing to write through a symbolic link: ${link}`);
    this.name = "SymlinkError";
    this.link = link;
  }
}

/** Splits a project-relative POSIX path, refusing absolute paths, `.`/`..`/empty segments, backslashes and NUL. */
function segmentsOf(rel: string): string[] {
  if (typeof rel !== "string" || rel === "" || /[\\\0]/.test(rel) || rel.startsWith("/")) {
    throw new Error(`unsafe path "${String(rel)}"`);
  }
  const segs = rel.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) throw new Error(`unsafe path "${rel}"`);
  return segs;
}

/** The first of the first `count` components of `segs` under `root` that is a symbolic link, or `null`. */
function firstLink(root: string, segs: readonly string[], count: number): string | null {
  let cur = root;
  for (let i = 0; i < count; i++) {
    cur = path.join(cur, segs[i]!);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw e;
    }
    if (st.isSymbolicLink()) return segs.slice(0, i + 1).join("/");
  }
  return null;
}

/**
 * Checks with `lstat` every existing component of `rel` below `root` (the last one included); the root and its
 * ancestors are not checked.
 *
 * @param root absolute project root.
 * @param rel POSIX project-relative path.
 * @throws {SymlinkError} when a component is a symbolic link.
 * @throws {Error} when `rel` is absolute or holds a `.`, `..` or empty segment.
 */
export function assertNoSymlink(root: string, rel: string): void {
  const segs = segmentsOf(rel);
  const hit = firstLink(root, segs, segs.length);
  if (hit !== null) throw new SymlinkError(hit);
}

/** Creates the parent folders of `abs`; the caller has already checked that no existing component is a link. */
function makeParents(abs: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
}

/**
 * Writes `text` to `rel` through a temporary file `<rel>.<random hex>.mogging-tmp` opened with
 * `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, flushes it to disk (`fsync`), then renames it over the target and
 * flushes the parent folder (best effort), so a crash or power failure leaves a whole file and never an empty one. A
 * failed write or rename removes the temporary file. Parent folders are created.
 *
 * @param root absolute project root.
 * @param rel POSIX project-relative target path.
 * @param text the text to write, as UTF-8.
 * @throws {SymlinkError} when a component of `rel` is a symbolic link; nothing is written.
 */
export function writeFileAtomic(root: string, rel: string, text: string): void {
  assertNoSymlink(root, rel);
  const abs = path.join(root, ...rel.split("/"));
  makeParents(abs);
  const tmp = `${abs}.${randomBytes(6).toString("hex")}.mogging-tmp`;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(tmp, flags, 0o644);
  try {
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* the temporary file is already gone */ }
    throw e;
  }
  syncFolder(path.dirname(abs));
}

/** Codes of platforms or file systems that refuse to `fsync` a folder: durability there is the best they offer. */
const FOLDER_SYNC_REFUSED = new Set(["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP", "ENOSYS", "EBADF"]);

/** Best-effort `fsync` of a folder, so a rename in it survives a power failure; a refusal is ignored. */
function syncFolder(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (e) {
    if (!FOLDER_SYNC_REFUSED.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Moves `from` to `to` with one `fs.renameSync`, creating the parents of `to`.
 *
 * @param root absolute project root.
 * @param from POSIX project-relative path of an existing file.
 * @param to POSIX project-relative destination.
 * @throws {SymlinkError} when a component of either path is a symbolic link; nothing is moved.
 */
export function moveFile(root: string, from: string, to: string): void {
  assertNoSymlink(root, from);
  assertNoSymlink(root, to);
  const target = path.join(root, ...to.split("/"));
  makeParents(target);
  fs.renameSync(path.join(root, ...from.split("/")), target);
}

/**
 * Unlinks `rel`. A symbolic link at the last component is unlinked itself and never followed; a link in a parent
 * is refused. A file that is already gone is not an error.
 *
 * @param root absolute project root.
 * @param rel POSIX project-relative path.
 * @throws {SymlinkError} when a parent folder is a symbolic link.
 */
export function removeFile(root: string, rel: string): void {
  const segs = segmentsOf(rel);
  const hit = firstLink(root, segs, segs.length - 1);
  if (hit !== null) throw new SymlinkError(hit);
  try {
    fs.unlinkSync(path.join(root, ...segs));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
