import fs from "node:fs";
import path from "node:path";
import type { Sql } from "postgres";
import type { Ctx } from "@mogging/core";
import { importFolder } from "../../src/import.js";
import type { ImportReport, StarlightImportOptions } from "../../src/import.js";
import { layout, project } from "./fixtures.js";

const D = "src/content/docs";

/** One stored snapshot row of one scope of a document, with ids and timestamps removed. */
export type EndStateScope = {
  /** `"shared"` or the locale. */
  scope: string;
  version: number;
  state: string;
  headDraft: boolean;
  headPublished: boolean;
  data: unknown;
  /** `null` for the shared scope. */
  sourceHashes: unknown;
  createdBy: string;
  publishedBy: string | null;
  unpublishedBy: string | null;
  hasPublishedAt: boolean;
  hasUnpublishedAt: boolean;
};

/** The stored end state of the `docs` collection: documents sorted by slug, scopes by scope then version. */
export type EndState = { documents: Array<{ slug: string; createdBy: string; scopes: EndStateScope[] }> };

/** An `ImportReport` with ids removed, files, warnings and errors sorted by path, and `starlight.concurrency` left out. */
export type NormalizedReport = {
  files: Array<{ file: string; outcome: string; published: boolean }>;
  warnings: Array<{ file: string; message: string }>;
  errors: Array<{ file: string; message: string }>;
  starlight?: Omit<NonNullable<ImportReport["starlight"]>, "concurrency">;
};

/**
 * Reads every stored snapshot row of every document of the `docs` collection (live and soft-deleted) into an
 * id-free, timestamp-free structure, so two runs can be compared for equality.
 *
 * @param sql - Connection on the test schema.
 * @returns The end state: documents sorted by slug, scopes by scope then version.
 */
export async function dumpEndState(sql: Sql): Promise<EndState> {
  const shared = await sql`
    select d.created_by as doc_created_by, s.doc_id, s.version, s.state, s.data, s.is_head_draft, s.is_head_published, s.created_by, s.published_by, s.unpublished_by,
           s.published_at is not null as has_published_at, s.unpublished_at is not null as has_unpublished_at
      from document_shared s join documents d on d.id = s.doc_id where d.collection = 'docs'`;
  const localized = await sql`
    select d.created_by as doc_created_by, l.doc_id, l.locale, l.version, l.state, l.data, l.source_hashes, l.is_head_draft, l.is_head_published,
           l.created_by, l.published_by, l.unpublished_by,
           l.published_at is not null as has_published_at, l.unpublished_at is not null as has_unpublished_at
      from document_localized l join documents d on d.id = l.doc_id where d.collection = 'docs'`;
  const byDoc = new Map<string, EndStateScope[]>();
  const slugOf = new Map<string, string>();
  const creatorOf = new Map<string, string>();
  const push = (docId: string, scope: EndStateScope): void => {
    const list = byDoc.get(docId) ?? [];
    list.push(scope);
    byDoc.set(docId, list);
  };
  for (const r of [...shared, ...localized]) creatorOf.set(r["doc_id"] as string, r["doc_created_by"] as string);
  for (const r of shared) {
    const data = r["data"] as Record<string, unknown>;
    if (typeof data["slug"] === "string" && !slugOf.has(r["doc_id"] as string)) slugOf.set(r["doc_id"] as string, data["slug"]);
    push(r["doc_id"] as string, {
      scope: "shared", version: r["version"] as number, state: r["state"] as string,
      headDraft: r["is_head_draft"] as boolean, headPublished: r["is_head_published"] as boolean,
      data, sourceHashes: null, createdBy: r["created_by"] as string, publishedBy: (r["published_by"] as string | null) ?? null,
      unpublishedBy: (r["unpublished_by"] as string | null) ?? null,
      hasPublishedAt: r["has_published_at"] as boolean, hasUnpublishedAt: r["has_unpublished_at"] as boolean,
    });
  }
  for (const r of localized) {
    push(r["doc_id"] as string, {
      scope: r["locale"] as string, version: r["version"] as number, state: r["state"] as string,
      headDraft: r["is_head_draft"] as boolean, headPublished: r["is_head_published"] as boolean,
      data: r["data"], sourceHashes: r["source_hashes"], createdBy: r["created_by"] as string,
      publishedBy: (r["published_by"] as string | null) ?? null,
      unpublishedBy: (r["unpublished_by"] as string | null) ?? null,
      hasPublishedAt: r["has_published_at"] as boolean, hasUnpublishedAt: r["has_unpublished_at"] as boolean,
    });
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const documents = [...byDoc.entries()].map(([docId, scopes]) => ({
    slug: slugOf.get(docId) ?? `?${docId}`,
    createdBy: creatorOf.get(docId)!,
    scopes: scopes.sort((a, b) => cmp(a.scope, b.scope) || a.version - b.version),
  }));
  documents.sort((a, b) => cmp(a.slug, b.slug));
  return { documents };
}

/**
 * Strips the ids and ordering noise from an import report.
 *
 * @param r - The report of one `importFolder` run.
 * @returns The report with `docId` removed, files, warnings and errors sorted by path, and `starlight.concurrency` dropped.
 */
export function normalizeReport(r: ImportReport): NormalizedReport {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const byFile = <T extends { file: string }>(xs: T[]): T[] => [...xs].sort((a, b) => cmp(a.file, b.file));
  const out: NormalizedReport = {
    files: byFile(r.files).map((f) => ({ file: f.file, outcome: f.outcome, published: f.published })),
    warnings: byFile(r.warnings).map((m) => ({ file: m.file, message: m.message })),
    errors: byFile(r.errors).map((m) => ({ file: m.file, message: m.message })),
  };
  if (r.starlight) {
    const { concurrency: _omitted, ...rest } = r.starlight as ImportReport["starlight"] & { concurrency?: unknown };
    out.starlight = rest;
  }
  return out;
}

/** A page file; an empty `title` writes `title:` with no value, which YAML reads as null (absent, so the translation is incomplete). */
const page = (title: string, body: string): string => `---\ntitle:${title === "" ? "" : ` ${title}`}\n---\n${body}\n`;

function put(root: string, rel: string, text: string): void {
  const full = path.join(root, D, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

/**
 * Runs the three-phase Starlight import scenario on one migrated schema and records the report and the stored end
 * state after each phase. A: save-only, three new English pages with German and `zh-CN` files, `c`'s German title
 * empty (incomplete, saved not published). B: save-only, `a`'s German file edited. C: with publish, `b`'s German
 * file edited (save and publish) while `a`'s German file stays as B left it (a pending draft, publish-only).
 *
 * @param sql - Connection on a migrated test schema.
 * @param ctx - Write context over `sql`.
 * @param extra - Extra Starlight options merged over the layout for every phase.
 * @returns One entry per phase, with its normalized report and the end state after it.
 */
export async function runScenario(
  sql: Sql, ctx: Ctx, extra: Partial<StarlightImportOptions> = {},
): Promise<Array<{ name: string; report: NormalizedReport; state: EndState }>> {
  const root = project({});
  const phase = async (name: string, publish: boolean) => {
    const report = await importFolder(ctx, { dir: root, publish, starlight: { layout, ...extra } });
    return { name, report: normalizeReport(report), state: await dumpEndState(sql) };
  };
  const out: Array<{ name: string; report: NormalizedReport; state: EndState }> = [];

  for (const s of ["a", "b", "c"]) {
    put(root, `${s}.md`, page(s.toUpperCase(), `English ${s}`));
    put(root, `de/${s}.md`, page(s === "c" ? "" : `${s}-de`, `Deutsch ${s}`));
    put(root, `zh-cn/${s}.md`, page(`${s}-zh`, `Chinese ${s}`));
  }
  out.push(await phase("A: day one, save only", false));

  put(root, "de/a.md", page("a-de-2", "Deutsch a zwei"));
  out.push(await phase("B: tracked save only", false));

  put(root, "de/b.md", page("b-de-2", "Deutsch b zwei"));
  out.push(await phase("C: tracked save and publish, plus a publish-only draft", true));
  return out;
}
