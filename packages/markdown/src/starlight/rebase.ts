import { posix } from "node:path";
import { parseMdast } from "../parse.js";
import type { Block, Inline, RichTextRoot } from "../tree.js";

/** Offsets of an ESM `source` literal, as acorn reports them (quote characters included). */
type SourceLiteral = { start: number; end: number; raw: string; value: unknown };

/** The part of an acorn `body` entry that the rebaser reads. */
type EsmDeclaration = { type: string; source?: SourceLiteral | null };

/** An mdast `mdxjsEsm` node as produced by remark-mdx. */
type EsmNode = { type: string; data?: { estree?: { body?: EsmDeclaration[] } } };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Re-expresses a project-relative path (resolved against `dirname(from)`) relative to `dirname(to)`, without
 * consulting the process working directory. A leading `..` run is kept; no other `.` or `..` segment remains.
 */
function relativeBetween(fromDir: string, toDir: string, path: string, trailingSlash: boolean): string {
  const target = posix.join(fromDir, path).split("/").filter((s) => s !== "" && s !== ".");
  const base = posix.normalize(toDir).split("/").filter((s) => s !== "" && s !== ".");
  let common = 0;
  while (common < base.length && common < target.length && base[common] === target[common] && target[common] !== "..") {
    common++;
  }
  const segs = [...Array<string>(base.length - common).fill(".."), ...target.slice(common)];
  let out = segs.join("/");
  if (out === "") return "./";
  if (!out.startsWith("../") && out !== "..") out = `./${out}`;
  if (trailingSlash && !out.endsWith("/")) out += "/";
  return out;
}

/** Rebases one reference whose relativeness was already decided; `?`/`#` and everything after them are kept. */
function rebasePath(ref: string, fromFile: string, toFile: string): string {
  const cut = ref.search(/[?#]/);
  const path = cut < 0 ? ref : ref.slice(0, cut);
  const suffix = cut < 0 ? "" : ref.slice(cut);
  if (path === "") return ref;
  return relativeBetween(posix.dirname(fromFile), posix.dirname(toFile), path, path.endsWith("/")) + suffix;
}

/**
 * Rebases an ECMAScript module specifier of a locale file (spec 5.9, D11). Only a specifier that starts with `./` or
 * `../` is a relative file reference; a bare package name, an absolute path or a URL is returned unchanged.
 *
 * @param spec the specifier exactly as written between the quotes.
 * @param fromFile POSIX project-relative path of the file the specifier was written in.
 * @param toFile POSIX project-relative path of the file it will be written to.
 * @returns the canonical specifier as seen from `toFile`: it starts with `./` or `../`, has no `.`/`..` segment after
 * the leading `..` run, and keeps its `?`/`#` suffix.
 */
export function rebaseSpecifier(spec: string, fromFile: string, toFile: string): string {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return spec;
  return rebasePath(spec, fromFile, toFile);
}

/**
 * Rebases an `image()` front-matter value or a Markdown image source (spec 5.9, D11). A source is relative when it is
 * non-empty and does not start with `/`, `#`, `~` or `@` and carries no URL scheme; everything else (absolute paths,
 * URLs, `data:` URIs, aliases, fragments) is returned unchanged, as is a value with an empty path part.
 *
 * @param src the source exactly as stored.
 * @param fromFile POSIX project-relative path of the file the source was read from.
 * @param toFile POSIX project-relative path of the file it will be written to.
 * @returns the canonical source as seen from `toFile`: it starts with `./` or `../`, has no `.`/`..` segment after
 * the leading `..` run, and keeps its `?`/`#` suffix. A bare `img.png` becomes `./img.png` even when nothing moves.
 */
export function rebaseSource(src: string, fromFile: string, toFile: string): string {
  if (src === "" || "/#~@".includes(src[0]!) || SCHEME.test(src)) return src;
  return rebasePath(src, fromFile, toFile);
}

/**
 * Rewrites the `source` literals of every import/export declaration of one MDX ESM block. The block is parsed alone,
 * so the literal offsets are relative to `source`; only the characters inside each literal's quotes are replaced, back
 * to front, and every other byte is kept.
 */
function rebaseEsm(source: string, fromFile: string, toFile: string): { source: string; error: string | null } {
  let nodes: EsmNode[];
  try {
    nodes = parseMdast(source, "mdx").children as unknown as EsmNode[];
  } catch (e) {
    return { source, error: `mdxjsEsm block does not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
  const edits: Array<{ from: number; to: number; text: string }> = [];
  let found = false;
  for (const node of nodes) {
    if (node.type !== "mdxjsEsm") continue;
    found = true;
    for (const decl of node.data?.estree?.body ?? []) {
      if (decl.type !== "ImportDeclaration" && decl.type !== "ExportNamedDeclaration" && decl.type !== "ExportAllDeclaration") continue;
      const lit = decl.source;
      if (!lit || typeof lit.value !== "string") continue;
      const inner = source.slice(lit.start + 1, lit.end - 1);
      const quote = source[lit.start];
      if ((quote !== "'" && quote !== '"') || source[lit.end - 1] !== quote || inner !== lit.value) continue;
      const next = rebaseSpecifier(inner, fromFile, toFile);
      if (next !== inner) edits.push({ from: lit.start + 1, to: lit.end - 1, text: next });
    }
  }
  if (!found) return { source, error: "mdxjsEsm block re-parsed without an mdxjsEsm node" };
  let out = source;
  for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return { source: out, error: null };
}

function rebaseInlines(list: Inline[], fromFile: string, toFile: string): void {
  for (const n of list) {
    if (n.type === "image") n.url = rebaseSource(n.url, fromFile, toFile);
    else if (n.type === "link") rebaseInlines(n.children, fromFile, toFile);
  }
}

function rebaseBlocks(list: Block[], fromFile: string, toFile: string, errors: string[]): void {
  for (const b of list) {
    switch (b.type) {
      case "paragraph":
      case "heading":
        rebaseInlines(b.children, fromFile, toFile);
        break;
      case "blockquote":
        rebaseBlocks(b.children, fromFile, toFile, errors);
        break;
      case "list":
        for (const item of b.children) rebaseBlocks(item.children, fromFile, toFile, errors);
        break;
      case "table":
        for (const row of b.children) for (const cell of row.children) rebaseInlines(cell.children, fromFile, toFile);
        break;
      case "container":
        if (b.label) rebaseInlines(b.label, fromFile, toFile);
        rebaseBlocks(b.children, fromFile, toFile, errors);
        break;
      case "opaqueBlock":
        if (b.node === "mdxjsEsm") {
          const r = rebaseEsm(b.source, fromFile, toFile);
          if (r.error !== null) errors.push(r.error);
          else b.source = r.source;
        }
        break;
      case "thematicBreak":
      case "code":
        break;
    }
  }
}

/**
 * Rebases every relative file reference of a rich-text tree (spec 5.9, D11): the `url` of each `image` node, wherever
 * it nests (paragraphs, headings, links, list items, table cells, blockquotes, container labels and bodies), and the
 * specifiers of each `mdxjsEsm` opaque block. `link` nodes, code and every other opaque node are left alone.
 *
 * @param tree the tree to rebase; it is not mutated.
 * @param fromFile POSIX project-relative path of the file the references were written in.
 * @param toFile POSIX project-relative path of the file they will be written to.
 * @returns a new tree, and one message per `mdxjsEsm` block that did not parse (that block is kept as it was; the
 * caller decides whether this is fatal).
 */
export function rebaseTree(tree: RichTextRoot, fromFile: string, toFile: string): { tree: RichTextRoot; errors: string[] } {
  const copy = structuredClone(tree);
  const errors: string[] = [];
  rebaseBlocks(copy.children, fromFile, toFile, errors);
  return { tree: copy, errors };
}

/**
 * Rebases the file reference held at `leaf` inside a localized field value (a `fileRefs` path of the layout, split on
 * `.`). An empty `leaf` addresses `value` itself. The walk follows own keys of plain objects only; when the path is
 * missing or does not end at a string, the value is returned unchanged.
 *
 * @param value the field value (a string or a nested plain object); it is not mutated.
 * @param leaf the key path from `value` to the string leaf.
 * @param fromFile POSIX project-relative path of the file the value was read from.
 * @param toFile POSIX project-relative path of the file it will be written to.
 * @returns the value with that one leaf passed through `rebaseSource`; untouched parts are copied by reference.
 */
export function rebaseValueAt(value: unknown, leaf: readonly string[], fromFile: string, toFile: string): unknown {
  if (leaf.length === 0) return typeof value === "string" ? rebaseSource(value, fromFile, toFile) : value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const [head, ...rest] = leaf as [string, ...string[]];
  if (!Object.hasOwn(value, head)) return value;
  const obj = value as Record<string, unknown>;
  const child = rebaseValueAt(obj[head], rest, fromFile, toFile);
  if (child === obj[head]) return value;
  const out = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  for (const k of Object.keys(obj)) Object.defineProperty(out, k, { value: obj[k], enumerable: true, writable: true, configurable: true });
  Object.defineProperty(out, head, { value: child, enumerable: true, writable: true, configurable: true });
  return out;
}
