import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Field } from "@mogging/core";

type LeafKind = "text" | "richText" | "other";

function leafKinds(field: Field, into: Set<LeafKind>): void {
  switch (field.kind) {
    case "text": into.add("text"); return;
    case "richText": into.add("richText"); return;
    case "list": leafKinds(field.item, into); return;
    case "object": for (const f of Object.values(field.fields)) leafKinds(f, into); return;
    case "number":
    case "boolean":
    case "dateTime":
    case "slug":
    case "reference": into.add("other"); return;
  }
}

/**
 * A field is translatable when it is localized and is text or richText, or a list/object whose leaves include a
 * text leaf and no richText leaf (nested rich text is not carried by the v0.1 wire schema).
 */
export function isTranslatable(field: Field): boolean {
  if (!field.localized) return false;
  if (field.kind === "text" || field.kind === "richText") return true;
  if (field.kind !== "list" && field.kind !== "object") return false;
  const kinds = new Set<LeafKind>();
  leafKinds(field, kinds);
  return kinds.has("text") && !kinds.has("richText");
}

function fieldSchema(field: Field): z.ZodType {
  switch (field.kind) {
    case "text":
    case "richText":
    case "dateTime":
    case "slug":
    case "reference": return z.string();
    case "number": return z.number();
    case "boolean": return z.boolean();
    case "list": return z.array(nestedSchema(field.item));
    case "object": return z.object(objectShape(field.fields));
  }
}

// Core stores a nested object value or list element as null where it is absent, so the wire schema allows null there.
function nestedSchema(field: Field): z.ZodType {
  return fieldSchema(field).nullable();
}

// Core also lets a stored object omit any declared key, so every key of a nested object is optional.
function objectShape(fields: Record<string, Field>): Record<string, z.ZodType> {
  return Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, nestedSchema(f).optional()]));
}

function fieldShape(fields: Record<string, Field>): Record<string, z.ZodType> {
  return Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, fieldSchema(f)]));
}

/** The structured-output schema the model must satisfy. Rich text is a Markdown string on the wire (spec 8.3). */
export function outputSchema(
  fields: Record<string, Field>,
): z.ZodType<{ fields: Record<string, unknown>; glossaryTermsUsed: string[] }> {
  return z.object({
    fields: z.object(fieldShape(fields)),
    glossaryTermsUsed: z.array(z.string()),
  }) as z.ZodType<{ fields: Record<string, unknown>; glossaryTermsUsed: string[] }>;
}

export type LeafPath = string;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every string leaf of a JSON-like value, in document order, with its path ("$", "$[2]", "$.items[0].label"). */
export function stringLeaves(value: unknown, path: string = "$"): Array<{ path: LeafPath; text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`));
  if (isRecord(value)) return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, `${path}.${k}`));
  return [];
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k));
}

function walk(field: Field, source: unknown, draft: unknown, path: string, out: string[]): void {
  if (field.kind === "richText") return; // compared by the rich-text validator, not here
  // A null element or object value is a value, not text: it must stay null and nothing may become null.
  if (source === null || draft === null) {
    if (source !== draft) out.push(`${path}: non-text value changed`);
    return;
  }
  switch (field.kind) {
    case "text":
      if (typeof draft !== "string") out.push(`${path}: expected text`);
      return;
    case "list": {
      if (!Array.isArray(draft) || !Array.isArray(source)) { out.push(`${path}: expected a list`); return; }
      if (draft.length !== source.length) {
        out.push(`${path}: list length ${draft.length} expected ${source.length}`);
        return;
      }
      source.forEach((s, i) => walk(field.item, s, draft[i], `${path}[${i}]`, out));
      return;
    }
    case "object": {
      if (!isRecord(draft) || !isRecord(source)) { out.push(`${path}: expected an object`); return; }
      if (!sameKeys(source, draft)) { out.push(`${path}: object keys differ`); return; }
      for (const [k, f] of Object.entries(field.fields)) {
        if (Object.hasOwn(source, k)) walk(f, source[k], draft[k], `${path}.${k}`, out);
      }
      return;
    }
    case "number":
    case "boolean":
    case "dateTime":
    case "slug":
    case "reference":
      if (!isDeepStrictEqual(source, draft)) out.push(`${path}: non-text value changed`);
      return;
  }
}

/**
 * Structural check of a model draft against its source: list lengths and object keys must match and every
 * non-text leaf must be unchanged. Returns `${path}: ${reason}` strings; an empty array means OK.
 */
export function checkShape(field: Field, source: unknown, draft: unknown): string[] {
  const out: string[] = [];
  walk(field, source, draft, "$", out);
  return out;
}
