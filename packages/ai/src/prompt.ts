import { readFileSync } from "node:fs";
import type { Field } from "@mogging/core";
import { sentinelize, validateTree } from "@mogging/markdown";
import { isTranslatable } from "./fields.js";

export type PromptVariant = "standard" | "strict";
export const PROMPT_VERSION = "translate.v1";

export type PromptRequest = {
  sourceLocale: string; targetLocale: string; collection: string;
  translate: Record<string, unknown>;        // field -> source value (rich text already sentinelized to Markdown)
  siblings: Record<string, unknown>;         // target locale's current values of the other TRANSLATABLE localized fields
  shared: Record<string, unknown>;           // shared head values of translatable kinds
  glossary: Array<{ term: string; translation: string | null; doNotTranslate: boolean }>;
};

const VARIANTS: readonly PromptVariant[] = ["standard", "strict"];
const templates = new Map<PromptVariant, string>();

// Resolved against this module, so the templates load from src and from a packed build alike ("files" ships prompts).
function template(variant: PromptVariant): string {
  let t = templates.get(variant);
  if (t === undefined) {
    t = readFileSync(new URL(`../prompts/${PROMPT_VERSION}.${variant}.md`, import.meta.url), "utf8");
    templates.set(variant, t);
  }
  return t;
}

const TRUNCATED = " […]";

/** The context value sent for one field, or undefined when the field must not reach the model. */
function contextValue(field: Field, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (field.kind === "richText") {
    // Code and opaque nodes never reach the model (spec 6.5). A tree that cannot be sentinelized (it already
    // holds a sentinel token, or is malformed) is left out rather than aborting the caller.
    try { return sentinelize(validateTree(value)).markdown; } catch { return undefined; }
  }
  // Text, or a list/object of text: the shape test of isTranslatable, whether or not the field is localized.
  return isTranslatable({ ...field, localized: true } as Field) ? value : undefined;
}

/** The longest prefix of `text` that, suffixed with " […]", keeps the result within `limit`; undefined if none. */
function truncated(result: Record<string, unknown>, name: string, text: string, limit: number): string | undefined {
  const measure = (n: number): number => JSON.stringify({ ...result, [name]: text.slice(0, n) + TRUNCATED }).length;
  if (measure(0) > limit) return undefined;
  let lo = 0;
  let hi = text.length; // measure is monotonic in n; find the largest n with measure(n) <= limit
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(mid) <= limit) lo = mid; else hi = mid - 1;
  }
  let n = lo;
  const last = text.charCodeAt(n - 1);
  if (n > 0 && last >= 0xd800 && last <= 0xdbff) n -= 1; // never split a surrogate pair
  return text.slice(0, n) + TRUNCATED;
}

/**
 * Builds the siblings or shared context: translatable-shaped values in field order, rich text as sentinelized
 * Markdown, other kinds omitted, the whole bounded by `limit` characters of JSON.
 */
export function contextValues(
  fields: Record<string, Field>,
  data: Record<string, unknown>,
  limit: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const value = contextValue(field, data[name]);
    if (value === undefined) continue;
    if (JSON.stringify({ ...result, [name]: value }).length <= limit) {
      result[name] = value;
      continue;
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const cut = truncated(result, name, text, limit);
    if (cut !== undefined) result[name] = cut;
    break; // later values are dropped
  }
  return result;
}

/** The system prompt (rules only, never content) and the delimited data message. */
export function buildPrompt(variant: PromptVariant, req: PromptRequest): { system: string; user: string; promptVersion: string } {
  const system = template(variant)
    .replaceAll("{{sourceLocale}}", req.sourceLocale)
    .replaceAll("{{targetLocale}}", req.targetLocale);
  const data = { translate: req.translate, siblings: req.siblings, shared: req.shared, glossary: req.glossary };
  return { system, user: `<<<DATA\n${JSON.stringify(data, null, 1)}\nDATA>>>`, promptVersion: `${PROMPT_VERSION}.${variant}` };
}

const tokenCounts = new Map<PromptVariant, number>();

/** The template's token count, ceil(chars / 3) of the unfilled template: the v0.1 measurement of spec 8.5. */
export function templateTokens(variant: PromptVariant): number {
  let n = tokenCounts.get(variant);
  if (n === undefined) {
    n = Math.ceil(template(variant).length / 3);
    tokenCounts.set(variant, n);
  }
  return n;
}

/** The larger of both variants, so a strict retry of a planned request fits too. */
export function maxTemplateTokens(): number {
  return Math.max(...VARIANTS.map(templateTokens));
}
