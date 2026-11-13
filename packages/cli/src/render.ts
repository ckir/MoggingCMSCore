import type { GlossaryEntry } from "@mogging/ai";
import type { DraftReview, ReviewField } from "@mogging/core";
import { treeToMarkdown } from "@mogging/markdown";
import type { RichTextRoot } from "@mogging/markdown";
import { escapeControl } from "./output.js";

const NONE = "(none)";

/** `kinds[path]` by own key (a field may be named like an `Object.prototype` member); `""` when undeclared. */
export const kindOf = (kinds: Record<string, string>, path: string): string => (Object.hasOwn(kinds, path) ? kinds[path]! : "");

/**
 * The text a reviewer sees and edits for one field value: `text` is the string, `richText` a tree as Markdown (a
 * string stored in a richText field is itself), absent is `(none)`, anything else is its JSON.
 */
export function valueText(value: unknown, kind: string): string {
  if (value === undefined || value === null) return NONE;
  if (kind === "text" && typeof value === "string") return value;
  if (kind === "richText") {
    if (typeof value === "string") return value;
    if (typeof value === "object" && !Array.isArray(value)) {
      try {
        return treeToMarkdown(value as RichTextRoot);
      } catch {
        // a stored value that is not a valid tree is shown as it is rather than ending the review
      }
    }
  }
  return JSON.stringify(value);
}

const chars = (s: string): string[] => Array.from(s);

/** Word-wraps `text` to `width` characters; a token longer than `width` is broken hard. Blank lines are kept. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const cs = chars(word);
      if (cs.length > width) {
        if (line !== "") out.push(line);
        let rest = cs;
        while (rest.length > width) {
          out.push(rest.slice(0, width).join(""));
          rest = rest.slice(width);
        }
        line = rest.join("");
      } else if (line === "") {
        line = word;
      } else if (chars(line).length + 1 + cs.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const pad = (s: string, width: number): string => s + " ".repeat(Math.max(0, width - chars(s).length));

function columns(left: string[], right: string[], width: number): string[] {
  const rows = Math.max(left.length, right.length);
  return Array.from({ length: rows }, (_, i) => `${pad(left[i] ?? "", width)} | ${right[i] ?? ""}`.trimEnd());
}

const bold = (s: string): string => `\u001b[1m${s}\u001b[22m`;

function previousLabel(review: DraftReview, field: ReviewField): string {
  if (field.previousFrom === "published") return "previous (published)";
  if (field.previousFrom === "superseded") {
    return `previous (superseded${review.supersededVersion === null ? "" : ` v${review.supersededVersion}`})`;
  }
  return "previous";
}

/**
 * The review of one draft as lines: per field its source text, then the previous text and the draft in two columns
 * of `(width - 3) / 2` characters around a `|` gutter, then the source-changed flag, the warnings and the glossary
 * entries whose term occurs in the source text.
 */
export function renderDraftReview(
  review: DraftReview,
  kinds: Record<string, string>,
  opts: { width: number; color: boolean; glossary?: GlossaryEntry[] },
): string[] {
  const column = Math.max(1, Math.floor((opts.width - 3) / 2));
  const sourceVersion = review.sourceVersion === null ? "" : ` v${review.sourceVersion}`;
  const lines = [
    escapeControl(
      `${review.collection}/${review.slug ?? review.docId} ${review.locale} v${review.version} ${review.state} (source ${review.sourceLocale}${sourceVersion})`,
    ),
  ];
  for (const field of review.fields) {
    const kind = kindOf(kinds, field.path);
    // Stored and AI-derived text is shown with its control characters escaped (before wrapping, which would
    // otherwise drop a bare `\r` as whitespace); `valueText` itself stays raw because the edit file round-trips it.
    const text = (value: unknown) => escapeControl(valueText(value, kind)).trimEnd();
    const heading = escapeControl(field.path);
    lines.push("", opts.color ? bold(heading) : heading);
    lines.push("source", ...wrap(text(field.source), Math.max(1, opts.width - 2)).map((l) => (l === "" ? l : `  ${l}`)));
    lines.push(...columns(wrap(previousLabel(review, field), column), ["draft"], column));
    lines.push(...columns(wrap(text(field.previous), column), wrap(text(field.draft), column), column));
    if (field.sourceChanged) lines.push("! source changed since this draft was translated");
    for (const warning of field.warnings) lines.push(`! ${escapeControl(warning)}`);
    const source = (field.source === undefined || field.source === null ? "" : text(field.source)).toLowerCase();
    for (const entry of opts.glossary ?? []) {
      if (entry.term === "" || !source.includes(entry.term.toLowerCase())) continue;
      const shown = entry.doNotTranslate || entry.translation === null ? "(keep)" : entry.translation;
      lines.push(`glossary: ${escapeControl(entry.term)} -> ${escapeControl(shown)}`);
    }
  }
  return lines;
}
