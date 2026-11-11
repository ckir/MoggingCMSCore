import fs from "node:fs";
import path from "node:path";
import type { Sql } from "postgres";
import {
  LicenceError, ValidationError, createDocument, getDocument, hashValue, normalizeLocale, normalizeValue,
  publish, saveDraft,
} from "@mogging/core";
import type { Collection, Ctx, DocumentRecord, Field, HeadPair } from "@mogging/core";
import { mapFile, splitFrontMatter } from "./contentFile.js";
import type { RefPlaceholder } from "./contentFile.js";
import { isSafeSlug } from "./slug.js";

export type ImportInput = { dir: string; publish?: boolean };
export type FileOutcome = {
  file: string;
  docId: string | null;
  outcome: "created" | "updated" | "unchanged" | "error";
  published: boolean;
};
export type FileMessage = { file: string; message: string };
export type ImportReport = { files: FileOutcome[]; warnings: FileMessage[]; errors: FileMessage[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Entry = {
  rel: string;
  locale: string;
  col: Collection;
  slug: string;
  ext: ".md" | ".mdx";
  isSource: boolean;
  shared: Record<string, unknown>;
  localized: Record<string, unknown>;
  error: string | null;
  docId: string | null;
  created: boolean;
};

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function isPlaceholder(v: unknown): v is RefPlaceholder {
  return isPlain(v) && typeof v["$ref"] === "string" && typeof v["collection"] === "string";
}

/** Rebuilds `value` with every reference placeholder replaced by `fn(placeholder)`; guided by the field type. */
function mapRefs(field: Field, value: unknown, fn: (ph: RefPlaceholder) => string): unknown {
  switch (field.kind) {
    case "reference":
      return isPlaceholder(value) ? fn(value) : value;
    case "list":
      return Array.isArray(value) ? value.map((x) => mapRefs(field.item, x, fn)) : value;
    case "object": {
      if (!isPlain(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        out[k] = sub === undefined ? v : mapRefs(sub, v, fn);
      }
      return out;
    }
    default:
      return value;
  }
}

function collectRefs(field: Field, value: unknown): RefPlaceholder[] {
  const out: RefPlaceholder[] = [];
  mapRefs(field, value, (ph) => { out.push(ph); return ph.$ref; });
  return out;
}

/** Collection of the first `reference` slot holding null, or null when there is none. */
function nullRefCollection(field: Field, value: unknown): string | null {
  switch (field.kind) {
    case "reference":
      return value === null ? field.collection : null;
    case "list":
      if (!Array.isArray(value)) return null;
      for (const x of value) { const c = nullRefCollection(field.item, x); if (c !== null) return c; }
      return null;
    case "object": {
      if (!isPlain(value)) return null;
      for (const [k, v] of Object.entries(value)) {
        const sub = Object.hasOwn(field.fields, k) ? field.fields[k] : undefined;
        if (sub === undefined) continue;
        const c = nullRefCollection(sub, v);
        if (c !== null) return c;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Slug-form references match the way core normalizes slugs (NFC, lower case). */
const slugKey = (ref: string): string => ref.normalize("NFC").toLowerCase();

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function fieldOf(col: Collection, name: string): Field {
  return col.fields[name]!;
}

export async function importFolder(ctx: Ctx, input: ImportInput): Promise<ImportReport> {
  const dir = input.dir;
  let st: fs.Stats | null = null;
  try { st = fs.statSync(dir); } catch { st = null; }
  if (st === null || !st.isDirectory()) throw new ValidationError(`import directory not found: ${dir}`);

  const warnings: FileMessage[] = [];
  const warn = (file: string, message: string) => warnings.push({ file, message });
  const { config } = ctx;
  const declared = new Set([config.locales.source, ...Object.keys(config.locales.chains)]);
  const visible = (d: fs.Dirent) => !d.name.startsWith(".");

  // ---- Scan -------------------------------------------------------------------------------------------
  const entries: Entry[] = [];
  const listDir = (p: string) => fs.readdirSync(p, { withFileTypes: true }).filter(visible)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const walk = (abs: string, rel: string, sub: string[], onFile: (rel: string, abs: string, sub: string[]) => void) => {
    for (const d of listDir(abs)) {
      const r = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(path.join(abs, d.name), r, [...sub, d.name], onFile);
      else if (d.isFile()) onFile(r, path.join(abs, d.name), [...sub, d.name]);
      else warn(r, "not a regular file; skipped");
    }
  };

  for (const ld of listDir(dir)) {
    if (!ld.isDirectory()) {
      warn(ld.name, ld.isFile() ? "file outside a <locale>/<collection> directory; skipped" : "not a regular file; skipped");
      continue;
    }
    let locale: string;
    try { locale = normalizeLocale(ld.name); } catch (e) {
      warn(ld.name, `locale directory does not name a locale (${msg(e)}); skipped`);
      continue;
    }
    if (!declared.has(locale)) {
      warn(ld.name, `locale "${locale}" is not declared in the config; skipped`);
      continue;
    }
    for (const cd of listDir(path.join(dir, ld.name))) {
      const crel = `${ld.name}/${cd.name}`;
      if (!cd.isDirectory()) {
        warn(crel, cd.isFile() ? "file outside a <locale>/<collection> directory; skipped" : "not a regular file; skipped");
        continue;
      }
      const col = config.collections.find((c) => c.name === cd.name);
      if (!col) {
        warn(crel, `unknown collection "${cd.name}"; skipped`);
        continue;
      }
      walk(path.join(dir, ld.name, cd.name), crel, [], (rel, abs, sub) => {
        const base = sub[sub.length - 1]!;
        const ext = path.extname(base);
        if (ext !== ".md" && ext !== ".mdx") {
          warn(rel, `unsupported file extension "${ext}"; skipped`);
          return;
        }
        const slug = [...sub.slice(0, -1), base.slice(0, base.length - ext.length)].join("/");
        const e: Entry = {
          rel, locale, col, slug, ext, isSource: locale === config.locales.source,
          shared: {}, localized: {}, error: null, docId: null, created: false,
        };
        entries.push(e);
        if (slug !== slug.normalize("NFC").toLowerCase()) { e.error = "slug path must be lowercase"; return; }
        if (!isSafeSlug(slug)) { e.error = "unsafe slug path"; return; }
        try {
          const parsed = splitFrontMatter(fs.readFileSync(abs, "utf8"));
          const mapped = mapFile(col, parsed, { isSourceLocale: e.isSource, mode: ext === ".mdx" ? "mdx" : "md" });
          for (const w of mapped.warnings) warn(rel, w);
          e.shared = mapped.shared;
          e.localized = mapped.localized;
          for (const scope of [e.shared, e.localized]) {
            for (const [k, v] of Object.entries(scope)) {
              const nc = nullRefCollection(fieldOf(col, k), v);
              if (nc !== null) throw new ValidationError(`${k}: unresolved reference null in collection ${nc}`);
              normalizeValue(fieldOf(col, k), mapRefs(fieldOf(col, k), v, (ph) => ph.$ref), k);
            }
          }
        } catch (err) {
          e.error = msg(err);
        }
      });
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // Twins and duplicates: one (locale, collection, slug) must come from exactly one file.
  const byKey = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = `${e.locale}\0${e.col.name}\0${e.slug}`;
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const twins = new Set(group.map((g) => g.ext)).size > 1;
    for (const g of group) {
      g.error ??= twins ? "both .md and .mdx exist for this slug" : "more than one file for this slug and locale";
    }
  }

  // Pre-resolve references with reads only.
  const lookups = new Map<string, Promise<DocumentRecord | null>>();
  const lookup = (collection: string, by: { docId: string } | { slug: string }): Promise<DocumentRecord | null> => {
    const key = "docId" in by ? `id\0${collection}\0${by.docId}` : `slug\0${collection}\0${by.slug}`;
    let p = lookups.get(key);
    if (!p) { p = getDocument(ctx, { collection, ...by }); lookups.set(key, p); }
    return p;
  };
  const live = async (collection: string, by: { docId: string } | { slug: string }): Promise<boolean> => {
    const d = await lookup(collection, by);
    return d !== null && d.deletedAt === null;
  };
  const sourceFile = (collection: string, ref: string): Entry | undefined =>
    entries.find((x) => x.isSource && x.error === null && x.col.name === collection && x.slug === slugKey(ref));

  const refsOf = (e: Entry): Array<{ field: string; ph: RefPlaceholder }> => {
    const out: Array<{ field: string; ph: RefPlaceholder }> = [];
    for (const scope of [e.shared, e.localized]) {
      for (const [k, v] of Object.entries(scope)) {
        for (const ph of collectRefs(fieldOf(e.col, k), v)) out.push({ field: k, ph });
      }
    }
    return out;
  };

  for (let changed = true; changed;) {
    changed = false;
    for (const e of entries) {
      if (e.error !== null) continue;
      for (const { field, ph } of refsOf(e)) {
        let ok: boolean;
        let why: string;
        if (UUID.test(ph.$ref)) {
          ok = await live(ph.collection, { docId: ph.$ref });
          why = `${field}: dangling reference "${ph.$ref}" in collection ${ph.collection}`;
        } else {
          ok = sourceFile(ph.collection, ph.$ref) !== undefined || await live(ph.collection, { slug: slugKey(ph.$ref) });
          why = `${field}: unresolved reference "${ph.$ref}" in collection ${ph.collection}`;
        }
        if (!ok) { e.error = why; changed = true; break; }
      }
    }
  }

  // ---- Passes -----------------------------------------------------------------------------------------
  const runMap = new Map<string, string>();
  const mapKey = (collection: string, slug: string) => `${collection}\0${slug}`;
  const fileMsgs = new Map<string, string>();
  const outcomes = new Map<string, FileOutcome>();
  const setOutcome = (e: Entry, outcome: FileOutcome["outcome"], published = false) =>
    outcomes.set(e.rel, { file: e.rel, docId: e.docId, outcome, published });

  const inTx = <T>(fn: (tctx: Ctx) => Promise<T>): Promise<T> =>
    ctx.sql.begin(async (tx) => fn({ ...ctx, sql: tx as unknown as Sql })) as Promise<T>;

  const fail = (e: Entry, err: unknown) => {
    if (err instanceof LicenceError) throw err;
    fileMsgs.set(e.rel, msg(err));
    setOutcome(e, "error");
  };

  for (const e of entries) {
    if (e.error !== null) { fileMsgs.set(e.rel, e.error); setOutcome(e, "error"); }
  }

  // Pass 1: identity.
  for (const e of entries) {
    if (e.error !== null || !e.isSource) continue;
    try {
      const res = await inTx(async (tctx) => {
        const found = await getDocument(tctx, { collection: e.col.name, slug: e.slug });
        if (found && found.deletedAt === null) return { id: found.id, created: false };
        const { id } = await createDocument(tctx, { collection: e.col.name });
        await saveDraft(tctx, { docId: id, locale: "shared", data: { slug: e.slug } });
        return { id, created: true };
      });
      e.docId = res.id;
      e.created = res.created;
      runMap.set(mapKey(e.col.name, e.slug), res.id);
    } catch (err) {
      fail(e, err);
    }
  }

  // Pass 2: content, source locale first.
  const pass2 = [...entries.filter((e) => e.isSource), ...entries.filter((e) => !e.isSource)];
  const needs = (a: HeadPair | undefined, hash: string, created: boolean): "unchanged" | { replaced: { state: string; version: number } | null } => {
    const draft = a?.draft ?? null;
    const pub = a?.published ?? null;
    const pubEq = pub !== null && hashValue(pub.data) === hash;
    if (draft !== null && hashValue(draft.data) === hash) return "unchanged";
    if (draft === null && pubEq) return "unchanged";
    if (draft !== null && (draft.state === "DRAFT_AI" || draft.state === "APPROVED") && pubEq) return "unchanged";
    const pending = draft !== null && (draft.state === "DRAFT_AI" || draft.state === "APPROVED");
    // An unpublished human draft is lost work too; skip our own pass-1 draft of a document created in this run.
    const unpublishedHuman = draft !== null && draft.state === "DRAFT_HUMAN" && !created && (pub === null || draft.version > pub.version);
    return { replaced: pending || unpublishedHuman ? { state: draft.state, version: draft.version } : null };
  };

  for (const e of pass2) {
    if (e.error !== null || outcomes.has(e.rel)) continue;
    const local: FileMessage[] = [];
    let foundDocId: string | null = null;
    try {
      const result = await inTx(async (tctx) => {
        // (a) resolve references
        const resolved = new Map<string, string>();
        for (const { field, ph } of refsOf(e)) {
          if (UUID.test(ph.$ref)) { resolved.set(`${ph.collection}\0${ph.$ref}`, ph.$ref); continue; }
          const slug = slugKey(ph.$ref);
          let id = runMap.get(mapKey(ph.collection, slug));
          if (id === undefined) {
            // A scan-time hit is still valid; a miss is re-read inside this transaction and never memoized
            // (the pool may hold a single connection, and a rolled-back read must not leak into the memo).
            const memo = lookups.get(`slug\0${ph.collection}\0${slug}`);
            const d = memo !== undefined && (await memo) !== null
              ? await memo
              : await getDocument(tctx, { collection: ph.collection, slug });
            if (d !== null && d.deletedAt === null) id = d.id;
          }
          if (id === undefined) throw new Error(`${field}: unresolved reference "${ph.$ref}" in collection ${ph.collection}`);
          resolved.set(`${ph.collection}\0${ph.$ref}`, id);
        }
        const data = (scope: Record<string, unknown>): Record<string, unknown> => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(scope)) {
            const f = fieldOf(e.col, k);
            out[k] = normalizeValue(f, mapRefs(f, v, (ph) => resolved.get(`${ph.collection}\0${ph.$ref}`)!), k);
          }
          return out;
        };

        // (b) the document
        let docId = e.docId ?? runMap.get(mapKey(e.col.name, e.slug)) ?? null;
        if (docId === null) {
          const d = await getDocument(tctx, { collection: e.col.name, slug: e.slug });
          if (d !== null && d.deletedAt === null) docId = d.id;
        }
        foundDocId = docId;
        if (docId === null) throw new Error(`no source document for ${e.col.name}/${e.slug}`);

        // (c) scopes
        const scopes: Array<{ locale: string; data: Record<string, unknown> }> = [];
        if (e.isSource) scopes.push({ locale: "shared", data: { slug: e.slug, ...data(e.shared) } });
        scopes.push({ locale: e.locale, data: data(e.localized) });

        const heads = async () => (await getDocument(tctx, { collection: e.col.name, docId: docId! }))!;
        const pair = (rec: DocumentRecord, locale: string): HeadPair | undefined =>
          locale === "shared" ? rec.shared : rec.locales[locale];
        let rec = await heads();
        let saved = false;
        for (const s of scopes) {
          const p = pair(rec, s.locale);
          if (Object.keys(s.data).length === 0 && !p?.draft && !p?.published) continue;
          const n = needs(p, hashValue(s.data), e.created);
          if (n === "unchanged") continue;
          if (n.replaced) {
            local.push({ file: e.rel, message: `replaced ${n.replaced.state === "DRAFT_HUMAN" ? "unpublished" : "pending"} ${n.replaced.state} draft v${n.replaced.version} for ${s.locale}` });
          }
          await saveDraft(tctx, { docId, locale: s.locale, data: s.data });
          saved = true;
        }

        // (d) publish
        let published = false;
        if (input.publish) {
          rec = await heads();
          for (const s of scopes) {
            const d = pair(rec, s.locale)?.draft;
            if (d && d.state === "DRAFT_HUMAN" && hashValue(d.data) === hashValue(s.data)) {
              await publish(tctx, { docId, locale: s.locale });
              published = true;
            }
          }
        }
        return { docId, saved, published };
      });
      e.docId = result.docId;
      warnings.push(...local);
      setOutcome(e, e.created ? "created" : result.saved ? "updated" : "unchanged", result.published);
    } catch (err) {
      e.docId ??= foundDocId;
      fail(e, err);
    }
  }

  const files: FileOutcome[] = entries.map((e) => outcomes.get(e.rel)!);
  const errors: FileMessage[] = [];
  for (const e of entries) {
    const m = fileMsgs.get(e.rel);
    if (m !== undefined) errors.push({ file: e.rel, message: m });
  }
  return { files, warnings, errors };
}
