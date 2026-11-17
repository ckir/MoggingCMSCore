import { slug as githubSlug } from "github-slugger";
import { ValidationError, normalizeLocale } from "@mogging/core";
import type { Field, MoggingConfig } from "@mogging/core";

/** One explicit front-matter path of a Starlight layout input: a plain field mapping or a toggle-plus-value union. */
export type StarlightPathEntry =
  | { path: string; field: string; stringAs?: string }
  | { path: string; union: { toggle: string; value: string; stringAs: string } };

/** The unvalidated Starlight layout a project writes in `mogging.config.ts`; `defineStarlightLayout` validates it. */
export type StarlightLayoutInput = {
  /** Name of the docs collection. */
  collection: string;
  /** Docs folder relative to the project root; default `src/content/docs`. */
  docsDir?: string;
  /** Folder of the source locale, or `null` (default) for the root-locale mode. */
  sourceDir?: string | null;
  /** Folder overrides by target locale; a locale without an entry uses its lowercase tag. */
  localeDirs?: Record<string, string>;
  /** Top-level folders that are Starlight locales Mogging does not manage (D3). */
  otherLocaleDirs?: string[];
  /** Explicit front-matter paths; every other declared field maps to the top-level key of its own name (D1). */
  paths?: StarlightPathEntry[];
  /** The shared `json` field that carries every front-matter key no entry maps. */
  passthrough: string;
  /** Dotted field paths (`hero.image.file`) of text leaves that are relative file references. */
  fileRefs?: string[];
  /** Localized fields a source file must carry. */
  requiredWhenSource?: string[];
};

/** One validated front-matter mapping of a layout. */
export type LayoutEntry =
  | { kind: "plain"; path: readonly string[]; field: string; localized: boolean; stringAs: string | null }
  | { kind: "union"; path: readonly string[]; toggle: string; value: string; stringAs: string };

/** A validated, deeply frozen Starlight layout produced by `defineStarlightLayout`. */
export type StarlightLayout = {
  readonly kind: "starlight";
  readonly collection: string;
  readonly docsDir: string;
  readonly sourceDir: string | null;
  /** Every declared non-source locale mapped to its folder. */
  readonly localeDirs: Readonly<Record<string, string>>;
  readonly otherLocaleDirs: readonly string[];
  /** The explicit entries plus one implicit plain entry per remaining field, sorted by path. */
  readonly entries: readonly LayoutEntry[];
  readonly passthrough: string;
  readonly fileRefs: readonly string[];
  readonly requiredWhenSource: readonly string[];
};

const FORBIDDEN_SEGMENTS: readonly string[] = ["__proto__", "constructor", "prototype"];
const DEFAULT_DOCS_DIR = "src/content/docs";

const fail = (message: string): never => { throw new ValidationError(`Starlight layout: ${message}`); };

/** Own-key lookup of a field map (D12): a prototype name is never a field. */
function own(fields: Record<string, Field>, name: string): Field | undefined {
  return Object.hasOwn(fields, name) ? fields[name] : undefined;
}

/** Refuses any `reference` field in `f`, at any depth (D2); `where` is its path for the message. */
function refuseReferences(f: Field, where: string): void {
  if (f.kind === "reference") fail(`reference field "${where}" is not supported (a Starlight collection has no references)`);
  if (f.kind === "list") refuseReferences(f.item, `${where}[]`);
  if (f.kind === "object") for (const [k, sub] of Object.entries(f.fields)) refuseReferences(sub, `${where}.${k}`);
}

/** Checks a folder name is a non-empty, single-segment string equal to its own slugified form. */
function checkFolder(dir: string, what: string): void {
  const s = typeof dir === "string" ? githubSlug(dir) : "";
  if (typeof dir !== "string" || dir === "" || dir !== s) {
    fail(`${what} folder "${String(dir)}" is not its own slugified form "${s}"`);
  }
}

/** Splits a dotted front-matter path, refusing empty and prototype-named segments and the reserved `slug` key. */
function parsePath(p: string): string[] {
  if (typeof p !== "string" || p === "") return fail(`path "${String(p)}" is empty`);
  const segs = p.split(".");
  for (const seg of segs) {
    if (seg === "") return fail(`path "${p}" has an empty segment`);
    if (FORBIDDEN_SEGMENTS.includes(seg)) return fail(`path "${p}" has the forbidden segment "${seg}"`);
  }
  if (segs[0] === "slug") return fail(`path "${p}" uses the reserved key "slug" (a slug override is a per-file error, spec 5.2)`);
  return segs;
}

/** Validates `stringAs` against the object field `f` named `name`: it must name a text sub-field. */
function checkStringAs(f: Field, name: string, stringAs: string): void {
  if (f.kind !== "object") fail(`stringAs "${stringAs}" needs an object field, but "${name}" is ${f.kind}`);
  const sub = f.kind === "object" ? own(f.fields, stringAs) : undefined;
  if (sub === undefined || sub.kind !== "text") fail(`stringAs "${stringAs}" must name a text sub-field of "${name}"`);
}

/** Deep-freezes arrays and plain objects in place and returns `v`. */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

/**
 * Validates a Starlight layout input against the config and returns the frozen layout every Starlight command reads.
 * Every declared field maps to a front-matter path: the explicit `paths` entries, then one implicit plain entry per
 * remaining field (D1) other than the slug, body and passthrough fields.
 *
 * @param input the layout as written in `mogging.config.ts`.
 * @param config the validated Mogging config; the collection, its fields and the target locales come from it.
 * @returns the validated layout; `localeDirs` maps every declared non-source locale to its folder, and `entries` is
 * sorted by path.
 * @throws {ValidationError} naming the first problem: an unknown collection, a slug field not named `slug` (D10), a
 * reference field (D2), a bad passthrough, a field or path mapped twice or nested in another, a bad union or
 * `stringAs`, a prototype-named or `slug` path segment, a locale folder that is not its own slugified form or is
 * shared, an absolute or `..` docsDir, or a bad `fileRefs` / `requiredWhenSource` entry.
 */
export function defineStarlightLayout(input: StarlightLayoutInput, config: MoggingConfig): StarlightLayout {
  const col = config.collections.find((c) => c.name === input.collection);
  if (col === undefined) return fail(`unknown collection "${String(input.collection)}"`);
  const fields = col.fields;

  // The slug field (D10) and references (D2).
  const slugNames = Object.entries(fields).filter(([, f]) => f.kind === "slug").map(([k]) => k);
  for (const n of slugNames) if (n !== "slug") fail(`the slug field must be named "slug", found "${n}" (D10)`);
  if (slugNames.length === 0) fail(`collection "${col.name}" needs a slug field named "slug"`);
  for (const [k, f] of Object.entries(fields)) refuseReferences(f, k);

  const passthroughField = typeof input.passthrough === "string" ? own(fields, input.passthrough) : undefined;
  if (passthroughField === undefined || passthroughField.kind !== "json" || passthroughField.localized) {
    fail(`passthrough "${String(input.passthrough)}" must be a shared json field of "${col.name}"`);
  }
  const passthrough = input.passthrough;

  // Folders.
  const docsDir = input.docsDir ?? DEFAULT_DOCS_DIR;
  if (typeof docsDir !== "string" || docsDir === "" || /^[A-Za-z]:|^[/\\]|[\\\0]/.test(docsDir)
    || docsDir.split("/").some((s) => s === "" || s === "." || s === "..")) {
    fail(`docsDir "${String(docsDir)}" must be a relative path of real segments with no "..", ".", backslash or NUL`);
  }
  const sourceDir = input.sourceDir ?? null;
  if (sourceDir !== null) checkFolder(sourceDir, "source");

  const targets = Object.keys(config.locales.chains).filter((l) => l !== config.locales.source);
  const overrides = new Map<string, string>();
  for (const [key, dir] of Object.entries(input.localeDirs ?? {})) {
    const locale = normalizeLocale(key);
    if (locale === config.locales.source) fail(`locale "${locale}" is the source locale; use sourceDir`);
    if (!targets.includes(locale)) fail(`locale "${locale}" is not a declared target locale`);
    if (overrides.has(locale)) fail(`locale "${locale}" is mapped twice`);
    overrides.set(locale, dir);
  }
  const localeDirs: Record<string, string> = {};
  const byFolder = new Map<string, string>();
  for (const locale of targets) {
    const dir = overrides.get(locale) ?? locale.toLowerCase();
    checkFolder(dir, "locale");
    const other = byFolder.get(dir);
    if (other !== undefined) fail(`folder "${dir}" is used by locales "${other}" and "${locale}"`);
    byFolder.set(dir, locale);
    localeDirs[locale] = dir;
  }
  const otherLocaleDirs = [...(input.otherLocaleDirs ?? [])];
  const seenOther = new Set<string>();
  for (const dir of otherLocaleDirs) {
    checkFolder(dir, "otherLocaleDirs");
    if (byFolder.has(dir)) fail(`folder "${dir}" is in both localeDirs and otherLocaleDirs`);
    if (seenOther.has(dir)) fail(`folder "${dir}" is listed twice in otherLocaleDirs`);
    seenOther.add(dir);
  }
  if (sourceDir !== null) {
    if (byFolder.has(sourceDir)) fail(`folder "${sourceDir}" is both the source folder and a locale folder`);
    if (seenOther.has(sourceDir)) fail(`folder "${sourceDir}" is both the source folder and in otherLocaleDirs`);
  }

  // Entries: explicit first, then one implicit plain entry per remaining field (D1).
  const entries: LayoutEntry[] = [];
  const mapped = new Set<string>();
  const claim = (name: string): void => {
    if (mapped.has(name)) fail(`field "${name}" is mapped twice`);
    mapped.add(name);
  };
  for (const e of input.paths ?? []) {
    const path = parsePath(e.path);
    if ("union" in e) {
      const { toggle, value, stringAs } = e.union;
      const t = own(fields, toggle);
      if (t === undefined || t.kind !== "boolean" || t.localized) fail(`union toggle "${toggle}" must be a shared boolean field`);
      const v = own(fields, value);
      if (v === undefined || v.kind !== "object" || !v.localized) fail(`union value "${value}" must be a localized object field`);
      checkStringAs(v!, value, stringAs);
      claim(toggle);
      claim(value);
      entries.push({ kind: "union", path, toggle, value, stringAs });
    } else {
      const f = own(fields, e.field);
      if (e.field === "slug") fail(`field "slug" is the slug field and is never mapped`);
      if (f === undefined) return fail(`unknown field "${e.field}" in collection "${col.name}"`);
      if (f.body) fail(`field "${e.field}" is the body and is never mapped`);
      if (e.field === passthrough) fail(`field "${e.field}" is the passthrough and is never mapped`);
      if (e.stringAs !== undefined) checkStringAs(f, e.field, e.stringAs);
      claim(e.field);
      entries.push({ kind: "plain", path, field: e.field, localized: f.localized, stringAs: e.stringAs ?? null });
    }
  }
  for (const [name, f] of Object.entries(fields)) {
    if (name === "slug" || name === passthrough || f.body || mapped.has(name)) continue;
    const path = parsePath(name);
    if (path.length !== 1) fail(`field "${name}" cannot be an implicit entry: its name contains "."`);
    entries.push({ kind: "plain", path, field: name, localized: f.localized, stringAs: null });
  }
  entries.sort((a, b) => {
    const x = a.path.join("."), y = b.path.join(".");
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const keys = new Set<string>();
  for (const e of entries) {
    const k = e.path.join(".");
    if (keys.has(k)) fail(`path "${k}" is mapped twice`);
    keys.add(k);
  }
  for (const e of entries) {
    for (let n = 1; n < e.path.length; n++) {
      const pre = e.path.slice(0, n).join(".");
      if (keys.has(pre)) fail(`path "${pre}" is a prefix of path "${e.path.join(".")}"`);
    }
  }

  // fileRefs: a text leaf reached through localized objects only.
  const fileRefs: string[] = [];
  for (const ref of input.fileRefs ?? []) {
    const segs = String(ref).split(".");
    let cur = own(fields, segs[0]!);
    if (cur === undefined || !cur.localized) fail(`fileRefs "${ref}" must start with a localized field`);
    for (const seg of segs.slice(1)) {
      if (cur!.kind === "list") fail(`fileRefs "${ref}" crosses a list`);
      if (cur!.kind !== "object") fail(`fileRefs "${ref}": "${seg}" is not inside an object field`);
      cur = cur!.kind === "object" ? own(cur!.fields, seg) : undefined;
      if (cur === undefined) fail(`fileRefs "${ref}": no field "${seg}"`);
    }
    if (cur!.kind === "list") fail(`fileRefs "${ref}" crosses a list`);
    if (cur!.kind !== "text") fail(`fileRefs "${ref}" must end at a text field, not ${cur!.kind}`);
    if (fileRefs.includes(ref)) fail(`fileRefs "${ref}" is listed twice`);
    fileRefs.push(ref);
  }

  const requiredWhenSource: string[] = [];
  for (const name of input.requiredWhenSource ?? []) {
    const f = own(fields, name);
    if (f === undefined) fail(`requiredWhenSource "${name}" is not a field of "${col.name}"`);
    if (!f!.localized) fail(`requiredWhenSource "${name}" must be a localized field`);
    requiredWhenSource.push(name);
  }

  return deepFreeze({
    kind: "starlight" as const, collection: col.name, docsDir, sourceDir, localeDirs, otherLocaleDirs,
    entries, passthrough, fileRefs, requiredWhenSource,
  });
}

/**
 * Names the target locale whose folder is `dir`. The source folder, other-locale folders and ordinary content
 * folders are not locale folders for this lookup.
 *
 * @param layout a validated layout.
 * @param dir a folder name, compared exactly (folders are already slugified).
 * @returns the canonical locale tag, or `null` when `dir` is not a managed target-locale folder.
 */
export function localeOfDir(layout: StarlightLayout, dir: string): string | null {
  for (const [locale, folder] of Object.entries(layout.localeDirs)) if (folder === dir) return locale;
  return null;
}
