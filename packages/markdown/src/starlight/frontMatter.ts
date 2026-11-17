import YAML from "yaml";
import { ValidationError, normalizeValue } from "@mogging/core";
import type { Collection, Field } from "@mogging/core";
import { markdownToTree } from "../parse.js";
import type { StarlightLayout } from "./layout.js";

/**
 * A Starlight Markdown/MDX file read safely: the raw front-matter text, its parsed YAML document (Mogging's core
 * schema, no Dates), the front matter as a plain mapping, and the body.
 */
export type StarlightFile = {
  /** The raw text between the fences (NFC, LF), or `null` when the file has no front matter. */
  frontMatter: string | null;
  /** The parsed YAML document of `frontMatter`, or `null` when there is none. */
  doc: YAML.Document | null;
  /** The front matter as a plain mapping; `{}` when there is none or it is empty. */
  data: Record<string, unknown>;
  /** The text after the closing fence (the whole text when there is no front matter). */
  body: string;
};

/** A page's front matter and body split into Mogging fields through the layout's path map. */
export type SplitPage = {
  /** Localized fields, normalized; references are NOT yet rebased. */
  localized: Record<string, unknown>;
  /** Shared mapped fields plus the passthrough (absent when nothing is unmapped), normalized. */
  shared: Record<string, unknown>;
  /** The union toggles found (each is also in `shared`). */
  toggles: Record<string, boolean>;
  /** The unmapped keys, which is what the passthrough holds; `{}` when there are none. */
  remainder: Record<string, unknown>;
  /** Per-file warnings (D5 pruning). */
  warnings: string[];
};

/** Astro's own front-matter regex (`@astrojs/internal-helpers@0.13.0` `src/frontmatter.ts:17`), quoted verbatim. */
const ASTRO_FRONT_MATTER = /(?:^\uFEFF?|^\s*\n)(?:---|\+\+\+)([\s\S]*?\n)(?:---|\+\+\+)/;
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** Reports whether `v` is a plain mapping (not an array, Date or null). */
function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Own-key lookup of a field map (D12): a prototype name is never a field. */
function own(fields: Record<string, Field>, name: string): Field | undefined {
  return Object.hasOwn(fields, name) ? fields[name] : undefined;
}

/** Rethrows anything as a `ValidationError` prefixed `front matter:` (a `ValidationError` passes unchanged). */
function asValidation(e: unknown): ValidationError {
  if (e instanceof Error && e.name === "ValidationError") return e as ValidationError;
  return new ValidationError(`front matter: ${e instanceof Error ? e.message : String(e)}`);
}

/** Refuses a `__proto__`, `constructor` or `prototype` key at any depth of `doc`, before anything is built from it. */
function refuseForbiddenKeys(doc: YAML.Document): void {
  YAML.visit(doc, {
    Pair(_key, pair) {
      let k: unknown = pair.key;
      if (YAML.isAlias(k)) k = k.resolve(doc);
      if (YAML.isScalar(k) && typeof k.value === "string" && FORBIDDEN_KEYS.includes(k.value)) {
        throw new ValidationError(`front matter: forbidden key "${k.value}"`);
      }
    },
  });
}

/** Parses front-matter text with `options`, refusing every YAML error or warning and every forbidden key. */
function parseSafely(text: string, options: YAML.ParseOptions & YAML.DocumentOptions & YAML.SchemaOptions): {
  doc: YAML.Document;
  data: Record<string, unknown>;
} {
  try {
    const doc = YAML.parseDocument(text, options);
    const problem = doc.errors[0] ?? doc.warnings[0];
    if (problem !== undefined) throw new ValidationError(`front matter: ${problem.message}`);
    refuseForbiddenKeys(doc);
    const parsed: unknown = doc.toJS();
    if (parsed === null || parsed === undefined) return { doc, data: {} };
    if (!isPlain(parsed)) throw new ValidationError("front matter: must be a mapping");
    return { doc, data: parsed };
  } catch (e) {
    throw asValidation(e);
  }
}

/**
 * Parses front-matter text exactly as Astro does (`schema: "core"`, `merge: true`, the `timestamp` tag), so a plain
 * date is a `Date` and a quoted one a string. Used where the question is what Astro would read, not what Mogging
 * stores.
 *
 * @param frontMatter the raw text between the fences, or `null` for a file without front matter.
 * @returns the front matter as a plain mapping (`{}` for `null` or an empty block); Dates are kept.
 * @throws {ValidationError} when the text is not valid YAML, has an unknown tag, a forbidden key (`__proto__`,
 * `constructor`, `prototype`), an excessive alias expansion, or is not a mapping.
 */
export function readAstroFrontMatter(frontMatter: string | null): Record<string, unknown> {
  if (frontMatter === null) return {};
  return parseSafely(frontMatter, { schema: "core", customTags: ["timestamp"], merge: true }).data;
}

/**
 * Splits `text` the way `splitFrontMatter` does (BOM stripped, CRLF to LF, NFC, the first line equal to `---` closes),
 * returning the block between the fences, the raw text between them, and the body; `null` when it has no front matter.
 */
function extractMogging(text: string): { between: string; frontMatter: string; body: string } | "unclosed" | null {
  if (!text.startsWith("---\n")) return null;
  const lines = text.split("\n");
  let close = -1;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i] === "---") { close = i; break; }
    offset += lines[i]!.length + 1;
  }
  if (close === -1) return "unclosed";
  return {
    between: text.slice(3, offset),
    frontMatter: lines.slice(1, close).join("\n"),
    body: lines.slice(close + 1).join("\n"),
  };
}

/**
 * Reads a Starlight Markdown/MDX file safely. The text is BOM-stripped, CRLF-converted and NFC-normalized as
 * `splitFrontMatter` does, Astro's own front-matter regex must find the same block Mogging's rule does (D6), and the
 * YAML is parsed with the core schema, `merge: true` and unique keys. A `slug` key is refused (spec 5.2).
 *
 * @param text the file's text.
 * @returns the raw front matter, its YAML document, the front matter as a plain mapping, and the body.
 * @throws {ValidationError} when Astro would read a different front-matter block (TOML `+++`, blank lines before the
 * opening `---`, a fence with trailing characters), the closing fence is missing, the YAML has an error, a warning
 * (an unknown tag), a forbidden key (`__proto__`, `constructor`, `prototype`) or an excessive alias expansion, the
 * front matter is not a mapping, or it has a `slug` key.
 */
export function readStarlightFile(text: string): StarlightFile {
  try {
    const norm = (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n/g, "\n").normalize("NFC");
    const mine = extractMogging(norm);
    const astro = ASTRO_FRONT_MATTER.exec(norm);
    if (astro !== null) {
      const lead = astro[0].length - 6 - astro[1]!.length;
      const opening = astro[0].slice(lead, lead + 3);
      const closing = astro[0].slice(-3);
      if (opening === "+++" || closing === "+++") {
        throw new ValidationError("front matter: TOML (+++) front matter is not supported; use YAML between --- lines");
      }
      if (lead > 0) {
        throw new ValidationError(
          "front matter: blank lines before the opening --- are read by Astro but not by Mogging; remove them",
        );
      }
      if (mine === null || mine === "unclosed" || mine.between !== astro[1]) {
        throw new ValidationError(
          "front matter: Astro reads a different front-matter block than Mogging does (a --- fence with trailing " +
            "characters); write each fence as exactly --- on its own line",
        );
      }
    }
    if (mine === "unclosed") throw new ValidationError("front matter: missing closing ---");
    if (mine === null) return { frontMatter: null, doc: null, data: {}, body: norm };
    const { doc, data } = parseSafely(mine.frontMatter, { schema: "core", merge: true, uniqueKeys: true });
    if (Object.hasOwn(data, "slug")) {
      throw new ValidationError(
        'front matter: a "slug" key is a slug override, which is not supported; the slug comes from the file path',
      );
    }
    return { frontMatter: mine.frontMatter, doc, data, body: mine.body };
  } catch (e) {
    throw asValidation(e);
  }
}

/**
 * Removes the value at the dotted `path` from `root` and deletes every parent that the removal emptied.
 *
 * @returns the removed value, or `undefined` in `found` when the path is absent or a parent is not a mapping.
 */
function extract(root: Record<string, unknown>, path: readonly string[]): { found: boolean; value?: unknown } {
  const chain: Record<string, unknown>[] = [root];
  let cur = root;
  for (const seg of path.slice(0, -1)) {
    if (!Object.hasOwn(cur, seg)) return { found: false };
    const next = cur[seg];
    if (!isPlain(next)) return { found: false };
    chain.push(next);
    cur = next;
  }
  const last = path[path.length - 1]!;
  if (!Object.hasOwn(cur, last)) return { found: false };
  const value = cur[last];
  delete cur[last];
  for (let i = chain.length - 1; i >= 1; i--) {
    if (Object.keys(chain[i]!).length > 0) break;
    delete chain[i - 1]![path[i - 1]!];
  }
  return { found: true, value };
}

/** Drops (with a warning naming its path) every key an object field does not declare, recursively (D5). */
function prune(field: Field, value: unknown, path: string, warnings: string[]): unknown {
  if (field.kind === "object" && isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const sub = own(field.fields, k);
      if (sub === undefined) {
        warnings.push(`${path}.${k}: not part of the field; dropped (the English file keeps it)`);
        continue;
      }
      out[k] = v === null ? null : prune(sub, v, `${path}.${k}`, warnings);
    }
    return out;
  }
  if (field.kind === "list" && Array.isArray(value)) {
    return value.map((x, i) => (x === null ? null : prune(field.item, x, `${path}[${i}]`, warnings)));
  }
  return value;
}

/**
 * Splits a read Starlight file into Mogging fields through the layout's path map. Each entry's value is removed from
 * a structured clone of the front matter (a parent the removal empties goes with it, and a path whose parent is not a
 * mapping stays unmapped), keys a mapped object does not declare are dropped with a warning (D5), and values are
 * normalized with `normalizeValue`. A top-level `null` is absent. Whatever no entry maps goes to the passthrough
 * field (and is returned as `remainder`); the Markdown body becomes the body field's tree in `mode`.
 *
 * @param layout the validated Starlight layout.
 * @param col the layout's collection.
 * @param file the file read by `readStarlightFile`; it is not mutated.
 * @param mode the file's Markdown mode, from its extension.
 * @returns the localized and shared fields, the union toggles, the remainder and the warnings.
 * @throws {ValidationError} when front matter carries the body field's name, a union key is neither a boolean, a
 * string nor a mapping, or a value does not fit its field (the message names the front-matter path).
 */
export function splitPage(
  layout: StarlightLayout,
  col: Collection,
  file: StarlightFile,
  mode: "md" | "mdx",
): SplitPage {
  const localized: Record<string, unknown> = {};
  const shared: Record<string, unknown> = {};
  const toggles: Record<string, boolean> = {};
  const warnings: string[] = [];
  const bodyName = Object.entries(col.fields).find(([, f]) => f.body)?.[0];
  if (bodyName !== undefined && Object.hasOwn(file.data, bodyName)) {
    throw new ValidationError(`${bodyName}: the body field comes from the Markdown body, not front matter`);
  }
  const need = (name: string): Field => {
    const f = own(col.fields, name);
    if (f === undefined) throw new ValidationError(`Starlight layout: field "${name}" is not a field of "${col.name}"`);
    return f;
  };

  const data = structuredClone(file.data);
  for (const entry of layout.entries) {
    const where = entry.path.join(".");
    const got = extract(data, entry.path);
    if (!got.found || got.value === null || got.value === undefined) continue;
    const v = got.value;
    if (entry.kind === "plain") {
      const field = need(entry.field);
      const shaped = entry.stringAs !== null && typeof v === "string" ? { [entry.stringAs]: v } : v;
      const value = normalizeValue(field, prune(field, shaped, where, warnings), where);
      (entry.localized ? localized : shared)[entry.field] = value;
      continue;
    }
    if (typeof v === "boolean") {
      toggles[entry.toggle] = v;
      shared[entry.toggle] = normalizeValue(need(entry.toggle), v, where);
    } else if (typeof v === "string" || isPlain(v)) {
      const field = need(entry.value);
      const shaped = prune(field, typeof v === "string" ? { [entry.stringAs]: v } : v, where, warnings);
      if (isPlain(shaped) && Object.keys(shaped).length === 0) continue;
      localized[entry.value] = normalizeValue(field, shaped, where);
    } else {
      throw new ValidationError(`${where}: expected a boolean, a string or a mapping`);
    }
  }

  const remainder: Record<string, unknown> = {};
  if (Object.keys(data).length > 0) {
    const normalized = normalizeValue(need(layout.passthrough), data, layout.passthrough);
    shared[layout.passthrough] = normalized;
    Object.assign(remainder, structuredClone(normalized));
  }

  if (file.body.trim() !== "") {
    if (bodyName === undefined) {
      warnings.push("the collection has no body field; Markdown body ignored");
    } else {
      (col.fields[bodyName]!.localized ? localized : shared)[bodyName] = markdownToTree(file.body, { mode });
    }
  }
  return { localized, shared, toggles, remainder, warnings };
}
