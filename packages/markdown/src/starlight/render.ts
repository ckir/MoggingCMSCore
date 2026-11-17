import YAML from "yaml";
import type { Collection } from "@mogging/core";
import { treeToMarkdown } from "../serialize.js";
import type { RichTextRoot } from "../tree.js";
import type { StarlightFile } from "./frontMatter.js";
import type { LayoutEntry, StarlightLayout } from "./layout.js";
import { rebaseTree, rebaseValueAt } from "./rebase.js";

/** Astro's own YAML options (`@astrojs/internal-helpers` `src/yaml.ts`): the parse that decides what a file means. */
const ASTRO_YAML: YAML.ParseOptions & YAML.DocumentOptions & YAML.SchemaOptions = {
  schema: "core", customTags: ["timestamp"], merge: true,
};

/** The result of `renderLocaleFile`. */
export type RenderedLocaleFile = {
  /** The file's text: `---`, the front matter, `---`, the body (no front-matter block when the document is empty). */
  text: string;
  /** Problems that make the file unwritable (an unparseable `mdxjsEsm` block, an English key in the way). */
  errors: string[];
  /** Notes about the file that do not stop it from being written. */
  warnings: string[];
};

/** Reports whether `v` is a plain mapping (not an array, Date or null). */
function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Reports whether `doc` holds an alias or a `<<` merge key anywhere. */
function hasAliasOrMerge(doc: YAML.Document): boolean {
  let found = false;
  YAML.visit(doc, {
    Alias() { found = true; return YAML.visit.BREAK; },
    Pair(_key, pair) {
      if (YAML.isScalar(pair.key) && typeof pair.key.value === "symbol") { found = true; return YAML.visit.BREAK; }
      return undefined;
    },
  });
  return found;
}

/** Collapses an object whose only key is `stringAs` to that key's string (the shortest form, panel round 2 TO-4). */
function shorten(value: unknown, stringAs: string | null): unknown {
  if (stringAs === null || !isPlain(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === stringAs && typeof value[stringAs] === "string") return value[stringAs];
  return value;
}

/** Deletes the node at `path` and every parent mapping that the deletion left empty. */
function deleteAndPrune(doc: YAML.Document, path: readonly string[]): void {
  doc.deleteIn(path);
  for (let n = path.length - 1; n >= 1; n--) {
    const parent = doc.getIn(path.slice(0, n), true);
    if (!YAML.isMap(parent) || parent.items.length > 0) break;
    doc.deleteIn(path.slice(0, n));
  }
}

/**
 * Finds the first prefix of `path` that is present in `doc` but is not a mapping (so a deeper key cannot be set).
 * Returns that prefix joined with `.`, or `null` when the whole path can be written.
 */
function blockedPrefix(doc: YAML.Document, path: readonly string[]): string | null {
  for (let n = 1; n < path.length; n++) {
    const node = doc.getIn(path.slice(0, n), true);
    if (node === undefined) return null;
    if (!YAML.isMap(node)) return path.slice(0, n).join(".");
  }
  return null;
}

/**
 * Writes a locale file (owner ruling R1). The English file's front-matter text is parsed again with Astro's own YAML
 * options and edited in place: the follows-English keys keep English's scalar style, quoting, key order and comments,
 * each localized mapped path gets the locale's value (or is removed when the locale has none), and a value Mogging
 * creates is stringified by the same timestamp-aware writer (a date-like string is quoted). A union path keeps
 * English's `false` and otherwise carries the locale's value or nothing. When the English document holds an alias or a
 * merge key it is rebuilt from its resolved values (a merged key must not leak into the locale file); its comments are
 * then lost and one warning says so. File references (`layout.fileRefs` and the body's images and ESM specifiers)
 * are rebased from `englishPath` to `localePath`. The English file is never touched.
 *
 * @param args.layout the validated Starlight layout.
 * @param args.col the layout's collection (names the body field).
 * @param args.english the English file as read by `readStarlightFile`.
 * @param args.englishPath POSIX project-relative path of the English file.
 * @param args.localePath POSIX project-relative path of the locale file being written.
 * @param args.localized the locale's published localized values, canonical (relative to the English file); a field
 * without a value is absent.
 * @returns the file text, the errors that make it unwritable, and the warnings.
 */
export function renderLocaleFile(args: {
  layout: StarlightLayout;
  col: Collection;
  english: StarlightFile;
  englishPath: string;
  localePath: string;
  localized: Record<string, unknown>;
}): RenderedLocaleFile {
  const { layout, col, english, englishPath, localePath, localized } = args;
  const errors: string[] = [];
  const warnings: string[] = [];

  let doc: YAML.Document = YAML.parseDocument(english.frontMatter ?? "", ASTRO_YAML);
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem !== undefined) {
    return { text: "", errors: [`front matter of the English file: ${problem.message}`], warnings };
  }
  if (hasAliasOrMerge(doc)) {
    try {
      doc = new YAML.Document(doc.toJS(), { ...ASTRO_YAML, aliasDuplicateObjects: false });
    } catch (e) {
      return {
        text: "",
        errors: [`front matter of the English file: ${e instanceof Error ? e.message : String(e)}`],
        warnings,
      };
    }
    warnings.push("the English front matter uses aliases or merge keys; the locale file is written from their resolved values and without comments");
  }

  // The locale's values with file references rebased (spec 5.9).
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(localized)) if (v !== null && v !== undefined) values[k] = v;
  for (const ref of layout.fileRefs) {
    const [head, ...leaf] = ref.split(".") as [string, ...string[]];
    if (Object.hasOwn(values, head)) values[head] = rebaseValueAt(values[head], leaf, englishPath, localePath);
  }

  const englishAt = (path: readonly string[]): unknown => doc.getIn(path);
  const put = (entry: LayoutEntry, value: unknown): void => {
    const where = entry.path.join(".");
    const blocked = blockedPrefix(doc, entry.path);
    if (blocked !== null) {
      errors.push(`${where}: the English file holds a non-mapping value at "${blocked}", so the locale value cannot be written under it`);
      return;
    }
    if (doc.contents === null) doc.contents = doc.createNode({}, { aliasDuplicateObjects: false });
    doc.setIn(entry.path, doc.createNode(value, { aliasDuplicateObjects: false }));
  };
  const remove = (entry: LayoutEntry): void => {
    if (doc.hasIn(entry.path)) deleteAndPrune(doc, entry.path);
  };

  for (const entry of layout.entries) {
    if (entry.kind === "plain") {
      if (!entry.localized) continue;
      if (Object.hasOwn(values, entry.field)) put(entry, shorten(values[entry.field], entry.stringAs));
      else remove(entry);
      continue;
    }
    if (englishAt(entry.path) === false) continue;
    if (Object.hasOwn(values, entry.value)) {
      const shaped = shorten(values[entry.value], entry.stringAs);
      if (isPlain(shaped) && Object.keys(shaped).length === 0) remove(entry);
      else put(entry, shaped);
    } else {
      remove(entry);
    }
  }

  // A document with no key writes no front-matter block (any comment it still holds goes with it).
  const js: unknown = doc.toJS();
  const empty = js === null || js === undefined || (isPlain(js) && Object.keys(js).length === 0);
  const front = empty ? "" : `---\n${doc.toString({ lineWidth: 0 })}---\n`;

  const bodyName = Object.entries(col.fields).find(([, f]) => f.body)?.[0];
  let body = "";
  const tree = bodyName === undefined ? undefined : (values[bodyName] as RichTextRoot | undefined);
  if (tree !== undefined) {
    const rebased = rebaseTree(tree, englishPath, localePath);
    errors.push(...rebased.errors);
    if (rebased.tree.children.length > 0) body = treeToMarkdown(rebased.tree);
  }
  return { text: front + body, errors, warnings };
}
