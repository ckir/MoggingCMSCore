import type { DraftReview, ReviewField } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { kindOf, valueText } from "./render.js";
import { UsageError } from "./types.js";

/**
 * The text edit file: a `=== <field> ===` line, then the field's text, for every editable field of a draft, and then
 * an empty section for every required field the draft lacks (`DraftReview.missing`).
 */
const headerOf = (name: string): string => `=== ${name} ===`;
const NEWLINE = /\r?\n/;

/**
 * Every key of the draft's data, those of them an edit file may change (`text` and `richText`), and the required
 * fields the draft lacks, which an edit file may supply whatever their kind.
 */
function fieldNames(
  review: DraftReview, kinds: Record<string, string>,
): { all: Set<string>; editable: Set<string>; missing: Set<string> } {
  const all = new Set(review.fields.map((f) => f.path));
  const editable = new Set([...all].filter((p) => ["text", "richText"].includes(kindOf(kinds, p))));
  const missing = new Set(review.missing.map((m) => m.path));
  return { all, editable, missing };
}

/**
 * The edit file for `review`: a section per editable field, then an empty, never prefilled section per missing
 * required field in `review.missing` order. A value with a line that `parseEditFile` would read as a header (for ANY
 * key of the draft, editable or not, or any missing path) cannot be written: the parser could not tell it from a real
 * section.
 *
 * @param review - The draft under review.
 * @param kinds - The field kind by path.
 * @returns The text of the edit file.
 * @throws {UsageError} A value contains a line that looks like a section header.
 */
export function serializeEditFile(review: DraftReview, kinds: Record<string, string>): string {
  const { all, editable, missing } = fieldNames(review, kinds);
  const headers = new Set([...all, ...missing].map(headerOf));
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
  for (const { path } of review.missing) sections.push(`${headerOf(path)}\n`);
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
 * The value a text edit file section supplies for a missing required field, or `undefined` for an empty or
 * whitespace-only body (no edit): `text` is the body, `richText` its Markdown tree, any other kind its JSON.
 */
function suppliedFromText(kinds: Record<string, string>, name: string, body: string): [string, unknown] | undefined {
  if (body.trim() === "") return undefined;
  const kind = kindOf(kinds, name);
  if (kind === "text") return [name, body];
  if (kind === "richText") return [name, markdownToTree(body, { mode: "md" })];
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (e) {
    throw new UsageError(`field ${name} is not valid JSON (this kind takes a JSON value, such as 12 or true): ${(e as Error).message}`);
  }
  if (value === null) throw new UsageError(`field ${name} must not be null`);
  return [name, value];
}

/**
 * The changed fields of a text edit file. Headers are exactly the lines `=== <field> ===` of an editable key of the
 * draft or of a missing required field; any other line (an `=== other ===` for no key of the draft, a header in
 * another case) is value text. The body of a missing field is read by `suppliedFromText`.
 *
 * @param text - The file's content.
 * @param review - The draft under review.
 * @param kinds - The field kind by path.
 * @returns The fields whose text changed, and the missing fields that were supplied, by path.
 * @throws {UsageError} A text before the first header, no header, a repeated or non-editable section, or a
 * missing field's body that is not valid JSON for its kind.
 */
export function parseEditFile(text: string, review: DraftReview, kinds: Record<string, string>): Record<string, unknown> {
  const { all, editable, missing } = fieldNames(review, kinds);
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split(NEWLINE)) {
    const name = line.startsWith("=== ") && line.endsWith(" ===") ? line.slice(4, -4) : undefined;
    if (name !== undefined && (all.has(name) || missing.has(name))) {
      if (!editable.has(name) && !missing.has(name)) throw new UsageError(`field ${name} is not editable`);
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
    const body = value.endsWith("\n") ? value.slice(0, -1) : value;
    const change = missing.has(name) ? suppliedFromText(kinds, name, body) : edited(review, kinds, name, body);
    if (change !== undefined) changes.push(change);
  }
  return Object.fromEntries(changes);
}

/**
 * The changed fields of a JSON edit file, `{ "<field>": "<text or markdown>" }`, typed by the same rule. A missing
 * required field of kind `text` or `richText` takes a string (`""` is a value); any other kind takes any JSON value
 * except `null`.
 *
 * @param text - The file's content.
 * @param review - The draft under review.
 * @param kinds - The field kind by path.
 * @returns The fields whose text changed, and the missing fields that were supplied, by path.
 * @throws {UsageError} Invalid JSON, a non-object, a field that is neither editable nor missing, a non-string
 * for a string-typed field, or `null` for a missing field.
 */
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
  const { editable, missing } = fieldNames(review, kinds);
  const changes: Array<[string, unknown]> = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!editable.has(name) && missing.has(name)) {
      const kind = kindOf(kinds, name);
      if (value === null) throw new UsageError(`field ${name} must not be null`);
      if (kind === "text" || kind === "richText") {
        if (typeof value !== "string") throw new UsageError(`field ${name} must be a string`);
        changes.push([name, kind === "text" ? value : markdownToTree(value, { mode: "md" })]);
      } else {
        changes.push([name, value]);
      }
      continue;
    }
    if (!editable.has(name)) throw new UsageError(`field ${name} is not an editable field of this draft`);
    if (typeof value !== "string") throw new UsageError(`field ${name} must be a string`);
    const change = edited(review, kinds, name, value);
    if (change !== undefined) changes.push(change);
  }
  return Object.fromEntries(changes);
}

/**
 * A copy of `review` whose drafts are replaced by `edits` and marked edited (what is shown after an edit; nothing is
 * written). A key of `edits` that is a missing path becomes an edited field (its `source` from the missing entry, no
 * previous) and leaves `missing`; `fields` stays sorted by path.
 *
 * @param review - The draft under review.
 * @param edits - The edits by path, as the parsers return them.
 * @returns The edited copy.
 */
export function applyEdits(review: DraftReview, edits: Record<string, unknown>): DraftReview {
  const supplied = review.missing.filter((m) => Object.hasOwn(edits, m.path));
  const fields = [
    ...review.fields.map((f) => (Object.hasOwn(edits, f.path) ? { ...f, draft: edits[f.path], edited: true } : f)),
    ...supplied.map(
      (m): ReviewField => ({
        path: m.path, source: m.source, previous: undefined, previousFrom: null, draft: edits[m.path], warnings: [],
        edited: true, sourceChanged: false,
      }),
    ),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ...review, fields, missing: review.missing.filter((m) => !Object.hasOwn(edits, m.path)) };
}
