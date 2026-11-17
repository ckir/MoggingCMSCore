import { NotFoundError, ValidationError } from "../errors.js";
import type { Collection } from "./collection.js";
import type { Field } from "./fields.js";
import { normalizeLocale } from "./locale.js";

export type MoggingConfig = {
  collections: Collection[];
  locales: { source: string; chains: Record<string, string[]> };
  /** Licence key token (spec 12.2); `MOGGING_LICENSE_KEY` takes precedence. */
  license?: string;
  /** Purchase address named in the licence refusal (spec 12.3); default https://mogging.dev/buy. */
  purchaseUrl?: string;
};

/** True when the field is a `json` field or holds one anywhere inside its list item or object fields. */
function containsJson(f: Field): boolean {
  if (f.kind === "json") return true;
  if (f.kind === "list") return containsJson(f.item);
  if (f.kind === "object") return Object.values(f.fields).some(containsJson);
  return false;
}

/** The path (relative to `f`) of the first non-text field that declares `translate: false`, or null. */
function badTranslateFalse(f: Field): string | null {
  if (f.translate === false && f.kind !== "text") return "";
  if (f.kind === "list") {
    const inner = badTranslateFalse(f.item);
    return inner === null ? null : `[]${inner}`;
  }
  if (f.kind === "object") {
    for (const [k, sub] of Object.entries(f.fields)) {
      const inner = badTranslateFalse(sub);
      if (inner !== null) return `.${k}${inner}`;
    }
  }
  return null;
}

/** True when a `slug` field sits anywhere below `f` (inside its list item or object fields). */
function containsSlug(f: Field): boolean {
  if (f.kind === "list") return f.item.kind === "slug" || containsSlug(f.item);
  if (f.kind === "object") return Object.values(f.fields).some((s) => s.kind === "slug" || containsSlug(s));
  return false;
}

/** The path (relative to `f`) of the first field below `f` that sets `required: true`, or null. */
function nestedRequired(f: Field): string | null {
  const below = (path: string, sub: Field): string | null => {
    if (sub.required) return path;
    const inner = nestedRequired(sub);
    return inner === null ? null : `${path}${inner}`;
  };
  if (f.kind === "list") return below("[]", f.item);
  if (f.kind === "object") {
    for (const [k, sub] of Object.entries(f.fields)) {
      const p = below(`.${k}`, sub);
      if (p !== null) return p;
    }
  }
  return null;
}

/**
 * Validates and normalizes a configuration.
 *
 * @param c the collections, locales and optional licence settings.
 * @returns the validated config with normalized locale tags.
 * @throws {ValidationError} when `license` or `purchaseUrl` is not a string, there is no collection, a
 * collection name repeats, a `json` field is localized, `translate: false` sits on a non-text field, a
 * `slug` field is localized, a `slug()` field is not named `slug`, a non-slug field is named `slug`, a
 * `slug()` sits below the top level (inside a list item or object), `required: true` sits below the top
 * level, a non-richText field is the body, a collection does not have exactly one body field, or a
 * locale chain references an undeclared locale.
 */
export function defineConfig(c: {
  collections: Collection[];
  locales: { source: string; chains: Record<string, string[]> };
  license?: string;
  purchaseUrl?: string;
}): MoggingConfig {
  if (c.license !== undefined && typeof c.license !== "string") throw new ValidationError("license must be a string");
  if (c.purchaseUrl !== undefined && typeof c.purchaseUrl !== "string") {
    throw new ValidationError("purchaseUrl must be a string");
  }
  if (c.collections.length === 0) throw new ValidationError("Config needs at least one collection");
  const names = new Set<string>();
  for (const col of c.collections) {
    if (names.has(col.name)) throw new ValidationError(`Duplicate collection "${col.name}"`);
    names.add(col.name);
    let bodies = 0;
    for (const [fname, f] of Object.entries(col.fields)) {
      if (f.localized && containsJson(f)) {
        throw new ValidationError(`${col.name}.${fname}: json cannot be localized`);
      }
      const bad = badTranslateFalse(f);
      if (bad !== null) {
        throw new ValidationError(`${col.name}.${fname}${bad}: translate: false is only valid on text`);
      }
      if (f.kind === "slug" && f.localized) {
        throw new ValidationError(`${col.name}.${fname}: slug cannot be localized`);
      }
      if (f.kind === "slug" && fname !== "slug") {
        throw new ValidationError(`${col.name}.${fname}: a slug field must be named "slug"`);
      }
      if (fname === "slug" && f.kind !== "slug") {
        throw new ValidationError(`${col.name}.slug: the name "slug" is reserved for a slug() field`);
      }
      if (containsSlug(f)) {
        throw new ValidationError(`${col.name}.${fname}: slug() is only valid as a top-level field`);
      }
      const req = nestedRequired(f);
      if (req !== null) {
        throw new ValidationError(`${col.name}.${fname}${req}: required is only valid on a top-level field`);
      }
      if (f.body) {
        if (f.kind !== "richText") {
          throw new ValidationError(`${col.name}.${fname}: only a richText field can be the body`);
        }
        bodies++;
      }
    }
    if (bodies !== 1) {
      throw new ValidationError(
        `Collection "${col.name}" needs exactly one body field, found ${bodies}`,
      );
    }
  }
  const source = normalizeLocale(c.locales.source);
  const chains: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(c.locales.chains)) {
    chains[normalizeLocale(k)] = v.map(normalizeLocale);
  }
  const declared = new Set<string>([source, ...Object.keys(chains)]);
  for (const [k, v] of Object.entries(chains)) {
    for (const l of v) {
      if (!declared.has(l)) {
        throw new ValidationError(`Chain for "${k}" references undeclared locale "${l}"`);
      }
    }
  }
  return {
    collections: c.collections, locales: { source, chains },
    ...(c.license !== undefined ? { license: c.license } : {}),
    ...(c.purchaseUrl !== undefined ? { purchaseUrl: c.purchaseUrl } : {}),
  };
}

/**
 * Builds the ordered fallback chain for one localized field: the requested locale first, then the
 * field's override or the locale's configured chain. Returned locale tags are normalized.
 *
 * A per-field `fallback` array replaces the locale chain entirely; `fallback: "none"` yields only
 * the requested locale. Shared (non-localized) fields have no chain, but this function does not
 * reject them: it returns the normal chain, and callers use it only for localized fields. Per-field
 * fallback targets are normalized but not checked against the declared locale list (unlike chain
 * values, which `defineConfig` validates), so a typo in a field override is not caught here.
 *
 * @param config validated config produced by `defineConfig`; its chains are already normalized.
 * @param locale requested BCP 47 tag; normalized here, so `de-ch` matches `de-CH`.
 * @param collection collection name; an unknown name throws `NotFoundError`.
 * @param field field name within that collection; only own properties count.
 * @returns the chain, always starting with the normalized requested locale. Duplicates are possible
 * only when the configuration itself repeats a locale.
 * @throws {NotFoundError} when the collection or field is not declared.
 * @remarks Pure and synchronous: no I/O, no mutation, safe to call per request.
 */
export function chainFor(
  config: MoggingConfig,
  locale: string,
  collection: string,
  field: string,
): string[] {
  const loc = normalizeLocale(locale);
  const col = config.collections.find((x) => x.name === collection);
  if (!col) throw new NotFoundError(`Unknown collection "${collection}"`);
  const f = Object.hasOwn(col.fields, field) ? col.fields[field] : undefined;
  if (!f) throw new NotFoundError(`Unknown field "${collection}.${field}"`);
  if (f.fallback === "none") return [loc];
  if (Array.isArray(f.fallback)) return [loc, ...f.fallback.map(normalizeLocale)];
  return [loc, ...(Object.hasOwn(config.locales.chains, loc) ? config.locales.chains[loc]! : [])];
}
