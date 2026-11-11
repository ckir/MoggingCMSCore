import fs from "node:fs";
import path from "node:path";
import { getDocument, listDocuments } from "@mogging/core";
import type { Collection, Ctx, Field } from "@mogging/core";
import { renderFile } from "./contentFile.js";
import type { FileMessage } from "./import.js";
import { isSafeSlug } from "./slug.js";
import { validateTree } from "./tree.js";

export type ExportInput = { dir: string; collections?: string[]; locales?: string[] };
export type ExportReport = { files: string[]; warnings: FileMessage[] };

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Every `[collection, id]` reference held in `value`, guided by the field type. */
function collectRefIds(field: Field, value: unknown, out: Array<[string, string]>): void {
  switch (field.kind) {
    case "reference":
      if (typeof value === "string") out.push([field.collection, value]);
      return;
    case "list":
      if (Array.isArray(value)) for (const x of value) collectRefIds(field.item, x, out);
      return;
    case "object":
      if (!isPlain(value)) return;
      for (const [k, v] of Object.entries(value)) {
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        if (sub !== undefined) collectRefIds(sub, v, out);
      }
      return;
    default:
  }
}

/** Copy of `value` without non-string richText values that are not v1 trees; each omission is reported. */
function sanitize(field: Field, value: unknown, name: string, bad: string[]): unknown {
  switch (field.kind) {
    case "richText":
      if (value === null || value === undefined || typeof value === "string") return value;
      try { validateTree(value); return value; } catch { bad.push(name); return undefined; }
    case "list":
      return Array.isArray(value)
        ? value.map((x, i) => sanitize(field.item, x, `${name}[${i}]`, bad))
        : value;
    case "object": {
      if (!isPlain(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        out[k] = sub === undefined ? v : sanitize(sub, v, `${name}.${k}`, bad);
      }
      return out;
    }
    default:
      return value;
  }
}

function cleanData(col: Collection, data: Record<string, unknown>, bad: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const f = Object.hasOwn(col.fields, k) ? col.fields[k] : undefined;
    out[k] = f === undefined ? v : sanitize(f, v, k, bad);
  }
  return out;
}

/** Mode of the first richText tree found in `value` (nested lists and objects included), or null. */
function treeMode(field: Field, value: unknown): "md" | "mdx" | null {
  switch (field.kind) {
    case "richText":
      return isPlain(value) && (value["mode"] === "mdx" || value["mode"] === "md") ? (value["mode"] as "md" | "mdx") : null;
    case "list":
      if (Array.isArray(value)) for (const x of value) { const m = treeMode(field.item, x); if (m !== null) return m; }
      return null;
    case "object":
      if (!isPlain(value)) return null;
      for (const [k, v] of Object.entries(value)) {
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        if (sub === undefined) continue;
        const m = treeMode(sub, v);
        if (m !== null) return m;
      }
      return null;
    default:
      return null;
  }
}

/** The body tree's mode if there is one, else the mode of any richText tree in the published data; md by default. */
function bodyMode(col: Collection, ...datas: Array<Record<string, unknown>>): "md" | "mdx" {
  const bodyName = Object.entries(col.fields).find(([, f]) => f.body)?.[0];
  const entries = Object.entries(col.fields);
  if (bodyName !== undefined) {
    for (const d of datas) {
      const m = treeMode(col.fields[bodyName]!, d[bodyName]);
      if (m !== null) return m;
    }
  }
  for (const d of datas) {
    for (const [name, f] of entries) {
      if (name === bodyName) continue;
      const m = treeMode(f, d[name]);
      if (m !== null) return m;
    }
  }
  return "md";
}

export async function exportFolder(ctx: Ctx, input: ExportInput): Promise<ExportReport> {
  const { config } = ctx;
  const root = path.resolve(input.dir);
  const source = config.locales.source;
  const locales = input.locales ?? [source, ...Object.keys(config.locales.chains)];
  const cols = config.collections.filter((c) => input.collections === undefined || input.collections.includes(c.name));
  const slugOf = new Map<string, string | null>();
  const files: string[] = [];
  const warnings: FileMessage[] = [];

  for (const col of cols) {
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await listDocuments(ctx, { collection: col.name, limit: 200, ...(after === undefined ? {} : { after }) });
      for (const it of page.items) ids.push(it.id);
      if (page.next === null) break;
      after = page.next;
    }
    for (const id of ids) {
      const label = `${col.name}/${id}`;
      const doc = await getDocument(ctx, { collection: col.name, docId: id });
      if (doc === null || doc.deletedAt !== null) continue;
      const sharedPub = doc.shared.published;
      const slug = sharedPub?.data["slug"];
      if (sharedPub === null || typeof slug !== "string" || slug === "") {
        warnings.push({ file: label, message: "no published slug; skipped" });
        continue;
      }
      if (!isSafeSlug(slug)) {
        warnings.push({ file: label, message: `unsafe slug "${slug}"; skipped` });
        continue;
      }

      const wanted = locales.filter((l) => l === source ? true : doc.locales[l]?.published != null);
      for (const locale of wanted) {
        const isSource = locale === source;
        const pub = doc.locales[locale]?.published ?? null;
        if (!isSource && pub === null) continue;
        const rawLocalized = pub?.data ?? {};
        const rawShared = isSource ? sharedPub.data : {};
        const file = `${locale}/${col.name}/${slug}`;
        const bad: string[] = [];
        const localized = cleanData(col, rawLocalized, bad);
        const shared = cleanData(col, rawShared, bad);
        const ext = bodyMode(col, rawLocalized, rawShared) === "mdx" ? "mdx" : "md";
        const rel = `${file}.${ext}`;
        const full = path.resolve(root, ...rel.split("/"));
        if (!full.startsWith(root + path.sep)) {
          warnings.push({ file: label, message: `unsafe slug "${slug}"; skipped` });
          continue;
        }
        for (const b of bad) warnings.push({ file: rel, message: `${b}: not a v1 tree; omitted` });

        // refToText is synchronous: resolve every referenced id up front.
        for (const [name, field] of Object.entries(col.fields)) {
          const refs: Array<[string, string]> = [];
          collectRefIds(field, field.localized ? localized[name] : shared[name], refs);
          for (const [refCol, refId] of refs) {
            if (!slugOf.has(refId)) {
              const target = await getDocument(ctx, { collection: refCol, docId: refId });
              const s = target === null || target.deletedAt !== null ? undefined : target.shared.published?.data["slug"];
              slugOf.set(refId, typeof s === "string" && s !== "" ? s : null);
            }
            if (slugOf.get(refId) === null) {
              warnings.push({ file: rel, message: `${name}: reference ${refId} has no published target; it will not re-import` });
            }
          }
        }

        const text = renderFile(col, { shared, localized }, {
          isSourceLocale: isSource,
          refToText: (rid) => slugOf.get(rid) ?? rid,
        });
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
        files.push(rel);
      }
    }
  }
  files.sort();
  warnings.sort((a, b) => (a.file + a.message).localeCompare(b.file + b.message));
  return { files, warnings };
}
