import { NotFoundError, ValidationError } from "../errors.js";
import type { Collection } from "./collection.js";
import { normalizeLocale } from "./locale.js";

export type MoggingConfig = {
  collections: Collection[];
  locales: { source: string; chains: Record<string, string[]> };
};

export function defineConfig(c: {
  collections: Collection[];
  locales: { source: string; chains: Record<string, string[]> };
}): MoggingConfig {
  if (c.collections.length === 0) throw new ValidationError("Config needs at least one collection");
  const names = new Set<string>();
  for (const col of c.collections) {
    if (names.has(col.name)) throw new ValidationError(`Duplicate collection "${col.name}"`);
    names.add(col.name);
    let bodies = 0;
    for (const [fname, f] of Object.entries(col.fields)) {
      if (f.kind === "slug" && f.localized) {
        throw new ValidationError(`${col.name}.${fname}: slug cannot be localized`);
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
  return { collections: c.collections, locales: { source, chains } };
}

export function chainFor(
  config: MoggingConfig,
  locale: string,
  collection: string,
  field: string,
): string[] {
  const loc = normalizeLocale(locale);
  const col = config.collections.find((x) => x.name === collection);
  if (!col) throw new NotFoundError(`Unknown collection "${collection}"`);
  const f = col.fields[field];
  if (!f) throw new NotFoundError(`Unknown field "${collection}.${field}"`);
  if (f.fallback === "none") return [loc];
  if (Array.isArray(f.fallback)) return [loc, ...f.fallback.map(normalizeLocale)];
  return [loc, ...(config.locales.chains[loc] ?? [])];
}
