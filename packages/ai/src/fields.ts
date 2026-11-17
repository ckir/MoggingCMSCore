import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Field } from "@mogging/core";

type LeafKind = "text" | "richText" | "json" | "other";

function leafKinds(field: Field, into: Set<LeafKind>): void {
  switch (field.kind) {
    case "text": into.add(field.translate === false ? "other" : "text"); return;
    case "richText": into.add("richText"); return;
    case "json": into.add("json"); return;
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
  if (field.kind === "text") return field.translate !== false;
  if (field.kind === "richText") return true;
  if (field.kind !== "list" && field.kind !== "object") return false;
  const kinds = new Set<LeafKind>();
  leafKinds(field, kinds);
  return kinds.has("text") && !kinds.has("richText") && !kinds.has("json");
}

/**
 * The field as the model sees it: every `translate: false` text leaf removed, and every object or list left without a
 * field removed with it. Null when no leaf remains. Non-text leaves (numbers, references, ...) stay, as before.
 */
export function wireField(field: Field): Field | null {
  switch (field.kind) {
    case "text": return field.translate === false ? null : field;
    case "list": {
      const item = wireField(field.item);
      return item === null ? null : { ...field, item };
    }
    case "object": {
      const fields: Record<string, Field> = {};
      for (const [k, f] of Object.entries(field.fields)) {
        const w = wireField(f);
        if (w !== null) fields[k] = w;
      }
      return Object.keys(fields).length === 0 ? null : { ...field, fields };
    }
    default: return field;
  }
}

/**
 * The value projected onto `wireField(field)`. List items are never dropped (an item that projects to nothing becomes
 * `{}`, a null item stays null), so list lengths match the source; only object keys are dropped: a key of a
 * `translate: false` leaf, and a key whose non-empty object value projects to an empty one. Undefined when
 * `wireField(field)` is null.
 */
export function wireValue(field: Field, value: unknown): unknown {
  if (wireField(field) === null) return undefined;
  if (value === null || value === undefined) return value;
  switch (field.kind) {
    case "list":
      if (!Array.isArray(value)) return value;
      return value.map((v) => (v === null ? null : wireValue(field.item, v)));
    case "object": {
      if (!isRecord(value)) return value;
      const entries: Array<[string, unknown]> = [];
      for (const [k, v] of Object.entries(value)) {
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        if (sub === undefined) { entries.push([k, v]); continue; }
        if (wireField(sub) === null) continue;
        const projected = wireValue(sub, v);
        if (isRecord(v) && Object.keys(v).length > 0 && isRecord(projected) && Object.keys(projected).length === 0) continue;
        entries.push([k, projected]);
      }
      return Object.fromEntries(entries);
    }
    default: return value;
  }
}

/**
 * The model's draft completed from the source: the draft is compared with `wireValue(field, source)`, and where its
 * list lengths and object keys agree, every `translate: false` leaf (and every subtree absent from the wire) is copied
 * from the source at the same path, list items aligned by index. A null element stays null. Where they disagree the
 * draft is returned unchanged, so `checkShape` rejects it.
 */
export function withFixedLeaves(field: Field, source: unknown, draft: unknown): unknown {
  if (field.kind === "text" && field.translate === false) return source;
  if (source === null || source === undefined || draft === null || draft === undefined) return draft;
  switch (field.kind) {
    case "list": {
      if (!Array.isArray(source) || !Array.isArray(draft) || source.length !== draft.length) return draft;
      return draft.map((d, i) => withFixedLeaves(field.item, source[i], d));
    }
    case "object": {
      if (!isRecord(source) || !isRecord(draft)) return draft;
      const wire = wireValue(field, source) as Record<string, unknown>;
      if (!sameKeys(wire, draft)) return draft;
      const entries: Array<[string, unknown]> = [];
      for (const [k, s] of Object.entries(source)) {
        if (!Object.hasOwn(wire, k)) { entries.push([k, s]); continue; }
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        entries.push([k, sub === undefined ? draft[k] : withFixedLeaves(sub, s, draft[k])]);
      }
      return Object.fromEntries(entries);
    }
    default: return draft;
  }
}

function fieldSchema(field: Field): z.ZodType {
  switch (field.kind) {
    case "text":
    case "richText":
    case "dateTime":
    case "slug":
    case "reference": return z.string();
    case "json": return z.unknown();
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
      if (field.translate === false) {
        if (!isDeepStrictEqual(source, draft)) out.push(`${path}: non-text value changed`);
        return;
      }
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
    case "json":
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
