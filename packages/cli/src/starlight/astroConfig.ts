import { statSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import * as nodeModule from "node:module";
import { parse } from "acorn";
import type { Node, ObjectExpression, Program, Property } from "acorn";
import type { StarlightLayout } from "@mogging/markdown";

/** One locale of a Starlight `locales` option, read statically. */
export type AstroLocale = {
  /** The `locales` key; `"root"` means no folder. */
  key: string;
  /** The locale's `lang`; the key when the config gives none. */
  lang: string;
  /** The locale's `label` when it is a string literal, else `null`. */
  label: string | null;
};

/** The static read of a project's `astro.config.*`: the facts the Starlight commands need, or why they are unknown. */
export type AstroConfigRead =
  | { ok: true; file: string; docsDir: string; locales: AstroLocale[] | null; defaultLocale: string | null }
  | { ok: false; file: string | null; reason: string };

type ReadOk = Extract<AstroConfigRead, { ok: true }>;

/** Astro's own config file order (`astro/packages/astro/src/core/config/config.ts:29-34`). */
const CONFIG_NAMES = ["astro.config.mjs", "astro.config.js", "astro.config.ts", "astro.config.mts"] as const;

/** Thrown inside the read to stop at the first step that cannot be read; carries the exact reason. */
class Unreadable extends Error {}

const stop = (reason: string): never => { throw new Unreadable(reason); };

/** Whether `path` is an existing regular file. */
function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

type StripTypes = (code: string) => string;

/**
 * Runs `node:module`'s `stripTypeScriptTypes` over `text` with its once-per-process ExperimentalWarning dropped;
 * `process.emitWarning` is restored afterwards.
 *
 * @param strip the Node function.
 * @param text TypeScript source.
 * @returns the source with its types blanked out.
 * @throws whatever `strip` throws on invalid TypeScript.
 */
function stripQuietly(strip: StripTypes, text: string): string {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const first = rest[0];
    const type = typeof first === "string" ? first
      : first !== null && typeof first === "object" ? (first as { type?: string }).type
      : warning instanceof Error ? warning.name : undefined;
    const message = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && message.includes("stripTypeScriptTypes")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return strip(text);
  } finally {
    process.emitWarning = original;
  }
}

/**
 * Parses `text` as an ES module; a `.ts`/`.mts` file that does not parse is retried after Node strips its types
 * (only when `module.stripTypeScriptTypes` exists).
 *
 * @param text the file text.
 * @param file the file name, for its extension.
 * @returns the program.
 * @throws {Unreadable} with reason `could not be parsed`.
 */
function parseProgram(text: string, file: string): Program {
  const attempt = (code: string): Program => parse(code, { ecmaVersion: "latest", sourceType: "module" });
  try {
    return attempt(text);
  } catch (first) {
    const strip = (nodeModule as unknown as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes;
    if (first instanceof SyntaxError && /\.m?ts$/.test(file) && typeof strip === "function") {
      try {
        return attempt(stripQuietly(strip as StripTypes, text));
      } catch { /* falls through to the reason below */ }
    }
    return stop("could not be parsed");
  }
}

/** The string a node spells when it is a string literal or a template literal without expressions, else `undefined`. */
function stringValue(node: Node | null | undefined): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (node.type === "Literal") {
    const v = (node as { value?: unknown }).value;
    return typeof v === "string" ? v : undefined;
  }
  if (node.type === "TemplateLiteral") {
    const t = node as unknown as { expressions: unknown[]; quasis: Array<{ value: { cooked?: string | null } }> };
    const cooked = t.quasis[0]?.value.cooked;
    return t.expressions.length === 0 && t.quasis.length === 1 && typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
}

/** The name of a plain `key: value` property whose key is an identifier or a string/number literal, else `undefined`
 * (also for a `__proto__: x` property, which sets the prototype instead of defining a key). */
function keyName(p: Property): string | undefined {
  if (p.computed || p.kind !== "init") return undefined;
  let name: string | undefined;
  if (p.key.type === "Identifier") name = (p.key as unknown as { name: string }).name;
  else if (p.key.type === "Literal") {
    const v = (p.key as { value?: unknown }).value;
    name = typeof v === "string" || typeof v === "number" ? String(v) : undefined;
  }
  // `__proto__: x` (not shorthand, not computed) sets the prototype at runtime: keys may be inherited, so it is no key.
  if (name === "__proto__" && !p.shorthand) return undefined;
  return name;
}

/**
 * The properties of an object literal by key, or `null` when the object holds a spread, a computed key, a key that is
 * not an identifier or literal, or a duplicate key (a key might then be hidden or ambiguous).
 */
function literalProps(obj: ObjectExpression): Map<string, Property> | null {
  const props = new Map<string, Property>();
  for (const p of obj.properties) {
    if (p.type !== "Property") return null;
    const name = keyName(p);
    if (name === undefined || props.has(name)) return null;
    props.set(name, p);
  }
  return props;
}

/** `literalProps`, stopping with `<what> holds a spread, computed or duplicate key` when the object is not literal. */
function propsOrStop(obj: ObjectExpression, what: string): Map<string, Property> {
  return literalProps(obj) ?? stop(`${what} holds a spread, computed or duplicate key`);
}

/** The object literal that is the `export default` expression, directly or as the one argument of `defineConfig(...)`. */
function defaultConfigObject(program: Program): ObjectExpression {
  const reason = "export default is not defineConfig({...}) or an object literal";
  const decl = program.body.find((s) => s.type === "ExportDefaultDeclaration");
  if (decl === undefined || decl.type !== "ExportDefaultDeclaration") return stop(reason);
  const e = decl.declaration as Node;
  if (e.type === "ObjectExpression") return e as ObjectExpression;
  if (e.type === "CallExpression") {
    const call = e as unknown as { callee: Node; arguments: Node[]; optional: boolean };
    if (call.callee.type === "Identifier" && (call.callee as unknown as { name: string }).name === "defineConfig"
      && call.arguments.length === 1 && call.arguments[0]!.type === "ObjectExpression") {
      return call.arguments[0] as ObjectExpression;
    }
  }
  return stop(reason);
}

/** The docs folder `<srcDir>/content/docs`, POSIX-normalized without a leading `./` or a trailing `/`. */
function docsDirOf(srcDir: string): string {
  const n = posix.normalize(srcDir.replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return [n === "." ? "" : n, "content/docs"].filter((s) => s !== "").join("/");
}

/** The local name of the default import of `@astrojs/starlight`. */
function starlightLocalName(program: Program): string {
  for (const s of program.body) {
    if (s.type !== "ImportDeclaration" || (s.source as { value?: unknown }).value !== "@astrojs/starlight") continue;
    for (const spec of s.specifiers) {
      if (spec.type === "ImportDefaultSpecifier") return spec.local.name;
    }
  }
  return stop("no import of @astrojs/starlight");
}

/** The options object of the one `<local>({...})` call in the config's `integrations` array literal. */
function starlightOptions(config: Map<string, Property>, local: string): ObjectExpression {
  const none = "no starlight() call in integrations";
  const value = config.get("integrations")?.value as Node | undefined;
  if (value === undefined || value.type !== "ArrayExpression") return stop(none);
  const calls = (value as unknown as { elements: Array<Node | null> }).elements.filter((el): el is Node => {
    if (el === null || el.type !== "CallExpression") return false;
    const callee = (el as unknown as { callee: Node }).callee;
    return callee.type === "Identifier" && (callee as unknown as { name: string }).name === local;
  });
  if (calls.length === 0) return stop(none);
  if (calls.length > 1) return stop("more than one starlight() call in integrations");
  const args = (calls[0] as unknown as { arguments: Node[] }).arguments;
  if (args.length !== 1 || args[0]!.type !== "ObjectExpression") return stop("the starlight() call has no object literal argument");
  return args[0] as ObjectExpression;
}

/** Reads the `locales` option: `null` when absent, else every locale in source order. */
function readLocales(options: Map<string, Property>): AstroLocale[] | null {
  const notLiteral = "locales is not a literal object";
  const prop = options.get("locales");
  if (prop === undefined) return null;
  const obj = prop.value as Node;
  if (obj.type !== "ObjectExpression") return stop(notLiteral);
  const locales: AstroLocale[] = [];
  for (const p of (obj as ObjectExpression).properties) {
    if (p.type !== "Property") return stop(notLiteral);
    const key = keyName(p);
    if (key === undefined || locales.some((l) => l.key === key)) return stop(notLiteral);
    if (p.value.type !== "ObjectExpression") return stop(notLiteral);
    const fields = propsOrStop(p.value as ObjectExpression, `locale ${key}`);
    const langProp = fields.get("lang");
    let lang = key;
    if (langProp !== undefined) {
      const v = stringValue(langProp.value);
      if (v === undefined) return stop(notLiteral);
      lang = v;
    } else if (key === "root") {
      return stop("the root locale has no lang");
    }
    const labelProp = fields.get("label");
    locales.push({ key, lang, label: labelProp === undefined ? null : stringValue(labelProp.value) ?? null });
  }
  return locales;
}

/** Reads one config text; every step that cannot be read statically stops with its exact reason. */
function readText(text: string, file: string): ReadOk {
  const program = parseProgram(text, file);
  const config = propsOrStop(defaultConfigObject(program), "config");

  const srcDirProp = config.get("srcDir");
  let srcDir = "./src";
  if (srcDirProp !== undefined) {
    const v = stringValue(srcDirProp.value as Node);
    if (v === undefined) return stop("srcDir is not a string literal");
    srcDir = v;
  }

  const options = propsOrStop(starlightOptions(config, starlightLocalName(program)), "starlight options");
  const locales = readLocales(options);
  const dl = options.get("defaultLocale");
  let defaultLocale: string | null = null;
  if (dl !== undefined) {
    const v = stringValue(dl.value as Node);
    if (v === undefined) return stop("defaultLocale is not a string literal");
    defaultLocale = v;
  }
  return { ok: true, file, docsDir: docsDirOf(srcDir), locales, defaultLocale };
}

/**
 * Reads a project's `astro.config.*` without importing it: the docs folder, Starlight's `locales` and its
 * `defaultLocale`. Anything that is not a literal is reported with an exact reason, never guessed.
 *
 * @param root the project root (the folder of `mogging.config.ts`).
 * @returns the facts, or `{ ok: false, file, reason }` (`file` is `null` when there is no config file). Never throws.
 */
export function readAstroConfig(root: string): AstroConfigRead {
  let file: string | null = null;
  try {
    for (const name of CONFIG_NAMES) {
      const candidate = join(root, name);
      if (isFile(candidate)) { file = candidate; break; }
    }
    if (file === null) return { ok: false, file: null, reason: "no astro.config file" };
    return readText(readFileSync(file, "utf8"), file);
  } catch (e) {
    if (e instanceof Unreadable) return { ok: false, file, reason: e.message };
    return { ok: false, file, reason: `could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The Starlight locale folders: the `locales` keys except `root` and except the `defaultLocale`, in order.
 *
 * @param read a successful read.
 * @returns the folders; `[]` when the site has no `locales`.
 */
export function starlightLocaleDirs(read: ReadOk): string[] {
  return (read.locales ?? []).map((l) => l.key).filter((k) => k !== "root" && k !== read.defaultLocale);
}

/**
 * Compares the Starlight locale folders with a Mogging layout.
 *
 * @param read a successful read.
 * @param layout the validated layout.
 * @returns one message per mismatch: Mogging targets Starlight lacks, then Starlight folders Mogging does not know,
 * then a differing source side.
 */
export function localeDrift(read: ReadOk, layout: StarlightLayout): string[] {
  const dirs = starlightLocaleDirs(read);
  const messages: string[] = [];
  for (const [tag, dir] of Object.entries(layout.localeDirs)) {
    if (!dirs.includes(dir)) messages.push(`locale "${tag}" (folder ${dir}) is not in Starlight's locales`);
  }
  const known = new Set<string>([...Object.values(layout.localeDirs), ...layout.otherLocaleDirs]);
  for (const dir of dirs) {
    if (!known.has(dir)) {
      messages.push(
        `Starlight locale folder "${dir}" is not a Mogging locale (add it to mogging.config.ts or to otherLocaleDirs)`,
      );
    }
  }
  const differs = layout.sourceDir === null
    ? read.defaultLocale !== null && read.defaultLocale !== "root"
    : layout.sourceDir !== read.defaultLocale;
  if (differs) {
    messages.push(
      `the source folder differs: Mogging ${layout.sourceDir ?? "(root)"}, Starlight ${read.defaultLocale ?? "root"}`,
    );
  }
  return messages;
}

/**
 * Reads `astro.config.*` once and turns the locale drift into warnings.
 *
 * @param root the project root.
 * @param layout the validated layout.
 * @returns the Starlight locale folders (`null` when the config cannot be read statically) and the warnings: one per
 * drift message, or exactly one when the config is unreadable.
 */
export function astroConfigWarnings(
  root: string,
  layout: StarlightLayout,
): { localeDirs: string[] | null; warnings: Array<{ file: string; message: string }> } {
  const read = readAstroConfig(root);
  if (!read.ok) {
    return {
      localeDirs: null,
      warnings: [{
        file: "astro.config",
        message: `could not be read statically (${read.reason}); the Starlight locale check was skipped`,
      }],
    };
  }
  const file = basename(read.file);
  return { localeDirs: starlightLocaleDirs(read), warnings: localeDrift(read, layout).map((message) => ({ file, message })) };
}
