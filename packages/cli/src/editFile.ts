import type { DraftReview } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { kindOf, valueText } from "./render.js";
import { UsageError } from "./types.js";

/** The text edit file: a `=== <field> ===` line, then the field's text, for every editable field of a draft. */
const headerOf = (name: string): string => `=== ${name} ===`;
const NEWLINE = /\r?\n/;

/** Every key of the draft's data, and those of them an edit file may change (`text` and `richText`). */
function fieldNames(review: DraftReview, kinds: Record<string, string>): { all: Set<string>; editable: Set<string> } {
  const all = new Set(review.fields.map((f) => f.path));
  const editable = new Set([...all].filter((p) => ["text", "richText"].includes(kindOf(kinds, p))));
  return { all, editable };
}

/**
 * The edit file for `review`. A value with a line that `parseEditFile` would read as a header (for ANY key of the
 * draft, editable or not) cannot be written: the parser could not tell it from a real section.
 */
export function serializeEditFile(review: DraftReview, kinds: Record<string, string>): string {
  const { all, editable } = fieldNames(review, kinds);
  const headers = new Set([...all].map(headerOf));
  const sections: string[] = [];
  for (const field of review.fields) {
    if (!editable.has(field.path)) continue;
    const kind = kindOf(kinds, field.path);
    // `treeToMarkdown` ends its output with a newline; the file's own separator is enough.
    const value = kind === "richText" ? valueText(field.draft, kind).replace(/\n$/, "") : valueText(field.draft, kind);
    if (value.split(NEWLINE).some((line) => headers.has(line))) {
      throw new UsageError("a value contains a line that looks like a section header; use a JSON edit file");
    }
    sections.push(`${headerOf(field.path)}\n${value}\n`);
  }
  return sections.join("\n");
}

/** The edit of `name` to `text`, or `undefined` when `text` is the draft's own text: an unedited field is not an edit. */
function edited(review: DraftReview, kinds: Record<string, string>, name: string, text: string): [string, unknown] | undefined {
  const field = review.fields.find((f) => f.path === name)!;
  const kind = kindOf(kinds, name);
  if (text.trim() === valueText(field.draft, kind).trim()) return undefined;
  if (kind === "text") return [name, text];
  // The draft value's root decides the mode, so an MDX field stays MDX; a string or absent draft is Markdown.
  const draft = field.draft as { mode?: unknown } | null | undefined;
  const mode = typeof draft === "object" && draft !== null && draft.mode === "mdx" ? "mdx" : "md";
  return [name, markdownToTree(text, { mode })];
}

/**
 * The changed fields of a text edit file. Headers are exactly the lines `=== <field> ===` of an editable key of the
 * draft; any other line (an `=== other ===` for no key of the draft, a header in another case) is value text.
 */
export function parseEditFile(text: string, review: DraftReview, kinds: Record<string, string>): Record<string, unknown> {
  const { all, editable } = fieldNames(review, kinds);
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split(NEWLINE)) {
    const name = line.startsWith("=== ") && line.endsWith(" ===") ? line.slice(4, -4) : undefined;
    if (name !== undefined && all.has(name)) {
      if (!editable.has(name)) throw new UsageError(`field ${name} is not editable`);
      if (sections.has(name)) throw new UsageError(`section ${name} appears more than once`);
      current = [];
      sections.set(name, current);
    } else if (current !== undefined) {
      current.push(line);
    } else if (line.trim() !== "") {
      throw new UsageError("the edit file has text before its first section header (=== <field> ===)");
    }
  }
  if (sections.size === 0) throw new UsageError("the edit file has no section header (=== <field> ===)");

  const changes: Array<[string, unknown]> = [];
  for (const [name, lines] of sections) {
    const value = lines.join("\n");
    const change = edited(review, kinds, name, value.endsWith("\n") ? value.slice(0, -1) : value);
    if (change !== undefined) changes.push(change);
  }
  return Object.fromEntries(changes);
}

/** The changed fields of a JSON edit file, `{ "<field>": "<text or markdown>" }`, typed by the same rule. */
export function parseJsonEditFile(text: string, review: DraftReview, kinds: Record<string, string>): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`the edit file is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError('the JSON edit file must be an object: { "<field>": "<text>" }');
  }
  const { editable } = fieldNames(review, kinds);
  const changes: Array<[string, unknown]> = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!editable.has(name)) throw new UsageError(`field ${name} is not an editable field of this draft`);
    if (typeof value !== "string") throw new UsageError(`field ${name} must be a string`);
    const change = edited(review, kinds, name, value);
    if (change !== undefined) changes.push(change);
  }
  return Object.fromEntries(changes);
}

/** A copy of `review` whose drafts are replaced by `edits` and marked edited (what is shown after an edit; nothing is written). */
export function applyEdits(review: DraftReview, edits: Record<string, unknown>): DraftReview {
  return {
    ...review,
    fields: review.fields.map((f) => (Object.hasOwn(edits, f.path) ? { ...f, draft: edits[f.path], edited: true } : f)),
  };
}
