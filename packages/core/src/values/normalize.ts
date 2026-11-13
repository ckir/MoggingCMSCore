import { ValidationError } from "../errors.js";
import type { Field } from "../schema/fields.js";

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

// Postgres jsonb (and text) cannot store U+0000, so refuse it here rather than at the database.
function rejectNul(s: string, path: string): void {
  if (s.includes("\u0000")) throw new ValidationError(`${path}: contains U+0000`);
}

function nfcDeep(v: unknown, path: string): unknown {
  if (typeof v === "string") {
    rejectNul(v, path);
    return v.normalize("NFC");
  }
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ValidationError(`${path}: non-finite number is not JSON`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => nfcDeep(x, `${path}[${i}]`));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      rejectNul(k, `${path}.${k}`);
      out[k.normalize("NFC")] = nfcDeep(x, `${path}.${k}`);
    }
    return out;
  }
  throw new ValidationError(`${path}: value is not JSON-serializable`);
}

function normalizeAt(field: Field, value: unknown, path: string): unknown {
  switch (field.kind) {
    case "text":
      if (typeof value !== "string") throw new ValidationError(`${path}: expected text (string)`);
      rejectNul(value, path);
      return value.normalize("NFC");
    case "slug":
      if (typeof value !== "string") throw new ValidationError(`${path}: expected slug (string)`);
      rejectNul(value, path);
      return value.normalize("NFC").toLowerCase();
    case "richText":
      if (typeof value !== "string" && typeof value !== "object") {
        throw new ValidationError(`${path}: expected richText (string, object or array)`);
      }
      if (value === null) throw new ValidationError(`${path}: expected richText, got null`);
      return nfcDeep(value, path);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ValidationError(`${path}: expected a finite number`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new ValidationError(`${path}: expected boolean`);
      return value;
    case "reference":
      if (typeof value !== "string") throw new ValidationError(`${path}: expected a document id (string)`);
      rejectNul(value, path);
      return value;
    case "dateTime": {
      let ms: number;
      if (value instanceof Date) ms = value.getTime();
      else if (typeof value === "string" && ISO_WITH_OFFSET.test(value)) ms = Date.parse(value);
      else throw new ValidationError(`${path}: expected ISO 8601 date-time with offset or Z`);
      if (Number.isNaN(ms)) throw new ValidationError(`${path}: unparseable date-time`);
      return new Date(ms).toISOString();
    }
    case "list": {
      if (!Array.isArray(value)) throw new ValidationError(`${path}: expected list (array)`);
      // A null element is a value, not an absence: leave it untouched.
      return value.map((el, i) => (el === null ? null : normalizeAt(field.item, el, `${path}[${i}]`)));
    }
    case "object": {
      if (!isPlainObject(value)) throw new ValidationError(`${path}: expected object`);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        if (sub === undefined) throw new ValidationError(`${path}.${k}: undeclared key`);
        if (v === undefined) continue;
        out[k] = v === null ? null : normalizeAt(sub, v, `${path}.${k}`);
      }
      return out;
    }
  }
}

/** Typed normalization (spec 6.4). Throws ValidationError naming the field path. */
export function normalizeValue(field: Field, value: unknown, path = "$"): unknown {
  return normalizeAt(field, value, path);
}

/** Removes top-level keys whose value is null (spec 7.2); nested nulls are values and stay. */
export function stripTopLevelNulls(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null));
}

/** Empty string, empty list, empty object, empty rich-text tree; always false for scalar kinds. */
export function isEmptyValue(field: Field, value: unknown): boolean {
  switch (field.kind) {
    case "text":
    case "slug":
      return value === "";
    case "list":
      return Array.isArray(value) && value.length === 0;
    case "object":
      return isPlainObject(value) && Object.keys(value).length === 0;
    case "richText": {
      if (value === "") return true;
      if (Array.isArray(value)) return value.length === 0;
      if (isPlainObject(value)) {
        const keys = Object.keys(value);
        if (keys.length === 0) return true;
        return Array.isArray(value.children) && value.children.length === 0;
      }
      return false;
    }
    default:
      return false;
  }
}
