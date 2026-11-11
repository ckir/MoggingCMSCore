import YAML from "yaml";
import { ValidationError } from "@mogging/core";
import type { Collection, Field } from "@mogging/core";
import { markdownToTree } from "./parse.js";
import { treeToMarkdown } from "./serialize.js";
import { validateTree } from "./tree.js";
import type { RichTextRoot } from "./tree.js";

export type ParsedFile = { frontMatter: Record<string, unknown>; body: string };
export type RefPlaceholder = { $ref: string; collection: string };
export type MappedFile = {
  shared: Record<string, unknown>;
  localized: Record<string, unknown>;
  warnings: string[];
};

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

export function splitFrontMatter(input: string): ParsedFile {
  const text = (input.startsWith("\uFEFF") ? input.slice(1) : input).replace(/\r\n/g, "\n").normalize("NFC");
  if (!text.startsWith("---\n")) return { frontMatter: {}, body: text };
  const lines = text.split("\n");
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { close = i; break; }
  }
  if (close === -1) throw new ValidationError("front matter: missing closing ---");
  const fm = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  let parsed: unknown;
  try {
    parsed = YAML.parse(fm, { schema: "core", uniqueKeys: true });
  } catch (e) {
    throw new ValidationError(`front matter: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || parsed === undefined) return { frontMatter: {}, body };
  if (!isPlain(parsed)) throw new ValidationError("front matter: must be a mapping");
  return { frontMatter: parsed, body };
}

function emptyTree(mode: "md" | "mdx"): RichTextRoot {
  return { type: "root", version: 1, mode, children: [] };
}

function mapValue(field: Field, value: unknown, mode: "md" | "mdx"): unknown {
  if (value === null) return null;
  switch (field.kind) {
    case "richText":
      if (typeof value === "string") return value === "" ? emptyTree(mode) : markdownToTree(value, { mode });
      return validateTree(value);
    case "reference":
      if (typeof value === "string") {
        const ph: RefPlaceholder = { $ref: value, collection: field.collection };
        return ph;
      }
      return value;
    case "list":
      return Array.isArray(value) ? value.map((x) => mapValue(field.item, x, mode)) : value;
    case "object": {
      if (!isPlain(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        out[k] = sub === undefined ? v : mapValue(sub, v, mode);
      }
      return out;
    }
    default:
      return value;
  }
}

function vitepressWarnings(body: string): string[] {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence.ch && f[1]!.length >= fence.len && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = null;
      continue;
    }
    if (f) { fence = { ch: f[1]![0]!, len: f[1]!.length }; continue; }
    if (/^\s*:::\s+\S/.test(line)) {
      const name = /^\s*:::\s+(\S+)/.exec(line)![1]!;
      out.push(
        `line ${i + 1}: "::: ${name}" (VitePress container syntax) is not supported; use ":::${name}[Title]"`,
      );
    }
  }
  return out;
}

export function mapFile(
  col: Collection,
  parsed: ParsedFile,
  opts: { isSourceLocale: boolean; mode: "md" | "mdx" },
): MappedFile {
  const shared: Record<string, unknown> = {};
  const localized: Record<string, unknown> = {};
  const warnings: string[] = [];
  const sharedWarn = (k: string) =>
    warnings.push(`shared field "${k}" is read from the source locale only; ignored`);
  const bodyName = Object.entries(col.fields).find(([, f]) => f.body)?.[0];

  for (const [key, value] of Object.entries(parsed.frontMatter)) {
    if (key === bodyName) {
      throw new ValidationError(`${key}: the body field comes from the Markdown body, not front matter`);
    }
    const field = Object.hasOwn(col.fields, key) ? col.fields[key] : undefined;
    if (field === undefined) throw new ValidationError(`${key}: undeclared field`);
    if (field.kind === "slug") {
      warnings.push(`slug comes from the file path; front-matter "${key}" ignored`);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (!field.localized) {
      if (!opts.isSourceLocale) { sharedWarn(key); continue; }
      shared[key] = mapValue(field, value, opts.mode);
    } else {
      localized[key] = mapValue(field, value, opts.mode);
    }
  }

  if (parsed.body.trim() !== "") {
    if (bodyName === undefined) {
      warnings.push("the collection has no body field; Markdown body ignored");
    } else {
      const bodyField = col.fields[bodyName]!;
      if (bodyField.localized) localized[bodyName] = markdownToTree(parsed.body, { mode: opts.mode });
      else if (opts.isSourceLocale) shared[bodyName] = markdownToTree(parsed.body, { mode: opts.mode });
      else sharedWarn(bodyName);
    }
  }
  warnings.push(...vitepressWarnings(parsed.body));
  return { shared, localized, warnings };
}

function renderValue(
  field: Field,
  value: unknown,
  refToText: (id: string, collection: string) => string,
): unknown {
  if (value === null || value === undefined) return value;
  switch (field.kind) {
    case "richText": {
      if (typeof value === "string") return value;
      const tree = validateTree(value);
      return tree.children.length === 0 ? "" : treeToMarkdown(tree);
    }
    case "reference":
      return typeof value === "string" ? refToText(value, field.collection) : value;
    case "list":
      return Array.isArray(value) ? value.map((x) => renderValue(field.item, x, refToText)) : value;
    case "object": {
      if (!isPlain(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue;
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        out[k] = sub === undefined ? v : renderValue(sub, v, refToText);
      }
      return out;
    }
    default:
      return value;
  }
}

export function renderFile(
  col: Collection,
  data: { shared: Record<string, unknown>; localized: Record<string, unknown> },
  opts: { isSourceLocale: boolean; refToText: (id: string, collection: string) => string },
): string {
  const fm: Record<string, unknown> = {};
  let body = "";
  for (const [name, field] of Object.entries(col.fields)) {
    if (field.kind === "slug") continue;
    const src = field.localized ? data.localized : data.shared;
    if (!field.localized && !opts.isSourceLocale) continue;
    const value = src[name];
    if (value === undefined || value === null) continue;
    if (field.body) {
      const v = renderValue(field, value, opts.refToText);
      body = typeof v === "string" ? v : "";
      continue;
    }
    fm[name] = renderValue(field, value, opts.refToText);
  }
  let head = "";
  if (Object.keys(fm).length > 0) {
    // Lists are written in flow style (`tags: [a, b]`) so that no key stands alone on its line.
    const doc = new YAML.Document(fm);
    YAML.visit(doc, { Seq(_key, node) { node.flow = true; } });
    head = `---\n${doc.toString()}---\n`;
  }
  return head + body;
}
