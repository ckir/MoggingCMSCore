import { hashValue } from "@mogging/core";
import type { Collection } from "@mogging/core";
import type { StarlightLayout } from "./layout.js";

/** The class of a Starlight locale file against a (document, locale)'s stored versions (spec 5.4). */
export type FileClass = "published" | "pending" | "behind" | "hand work";

type Rec = Record<string, unknown>;

const isEmptyObject = (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;

/** The union `value` fields of the layout (the per-locale values a follows-English toggle can suppress). */
function unionValues(layout: StarlightLayout): string[] {
  const out: string[] = [];
  for (const e of layout.entries) if (e.kind === "union") out.push(e.value);
  return out;
}

/** A copy of `rec` without the `drop` fields and with every top-level richText value's root mode set to `md`. */
function prepared(col: Collection, rec: Rec, drop: ReadonlySet<string>): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(rec)) {
    if (drop.has(k)) continue;
    const f = Object.hasOwn(col.fields, k) ? col.fields[k] : undefined;
    if (f !== undefined && f.kind === "richText" && typeof v === "object" && v !== null && !Array.isArray(v)
      && (v as Rec).type === "root") {
      out[k] = { ...(v as Rec), mode: "md" };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * The one comparison rule of spec 5.4: whether a locale file's localized values equal a stored version's. A
 * suppressible union value (a layout union's `value` field) that the file lacks or holds as `{}` is ignored on both
 * sides, and the root `mode` of every top-level richText value is set to `md` on both sides (the mode follows the
 * file extension, not the content). The records are compared by canonical hash and are never mutated.
 *
 * @param layout the validated Starlight layout.
 * @param col the collection the records belong to.
 * @param file the localized values parsed from the file, normalized and un-rebased to canonical form.
 * @param version the localized values of a stored version, normalized.
 * @returns `true` when both records hash equally under the rule.
 */
export function sameLocalized(layout: StarlightLayout, col: Collection, file: Rec, version: Rec): boolean {
  const drop = new Set<string>();
  for (const name of unionValues(layout)) {
    if (!Object.hasOwn(file, name) || file[name] === undefined || file[name] === null || isEmptyObject(file[name])) {
      drop.add(name);
    }
  }
  return hashValue(prepared(col, file, drop)) === hashValue(prepared(col, version, drop));
}

/**
 * First classification pass: compares a file with the current published head, then the current draft head.
 *
 * @param layout the validated Starlight layout.
 * @param col the collection the records belong to.
 * @param file the file's localized values (normalized, canonical).
 * @param heads the localized values of the (document, locale) published head and draft head, `null` when absent.
 * @returns `"published"`, `"pending"`, or `null` when the file needs the earlier-version pass (`classifyEarlier`).
 */
export function classifyHeads(
  layout: StarlightLayout, col: Collection, file: Rec,
  heads: { published: Rec | null; draft: Rec | null },
): "published" | "pending" | null {
  if (heads.published !== null && sameLocalized(layout, col, file, heads.published)) return "published";
  if (heads.draft !== null && sameLocalized(layout, col, file, heads.draft)) return "pending";
  return null;
}

/**
 * Second classification pass, for a file `classifyHeads` returned `null` for.
 *
 * @param layout the validated Starlight layout.
 * @param col the collection the records belong to.
 * @param file the file's localized values (normalized, canonical).
 * @param earlier the localized values of the earlier published versions of the (document, locale).
 * @returns `"behind"` when the file equals one of them, otherwise `"hand work"`.
 */
export function classifyEarlier(
  layout: StarlightLayout, col: Collection, file: Rec, earlier: Rec[],
): "behind" | "hand work" {
  return earlier.some((v) => sameLocalized(layout, col, file, v)) ? "behind" : "hand work";
}
