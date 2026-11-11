import { expect, test } from "vitest";
import type { Sql } from "postgres";
import {
  NotPublishableError, ValidationError, approve, approveClean, createDocument, hashValue, migrate, publish,
  recordAiDraft, saveDraft,
} from "../src/index.js";
import { ctxFor, extraConnection } from "./fixtures.js";
import { withTestDb } from "./db.js";

const prov = (fieldPath: string, extra: { warnings?: string[]; jobId?: number } = {}) => ({
  fieldPath, modelId: "m1", promptVersion: "p1", promptTokens: 10, completionTokens: 20, costMicros: 300, ...extra,
});

/** A document whose source locale (en) has a published v1 with title and body. */
async function setup(sql: Sql) {
  await migrate(sql);
  const ctx = ctxFor(sql, "reviewer");
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  const hashes = { title: hashValue("Hello"), body: hashValue("World") };
  return { ctx, docId, hashes };
}

const heads = (sql: Sql, docId: string, locale: string) =>
  sql`select version, state, data, source_hashes, is_head_draft, is_head_published from document_localized
    where doc_id = ${docId} and locale = ${locale} order by version`;

test("recordAiDraft returns SOURCE_MOVED when source advanced", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello 2", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  const r = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
  });
  expect(r).toEqual({ cancelled: "SOURCE_MOVED" });
  expect(await heads(sql, docId, "de")).toHaveLength(0);
  const [{ n }] = await sql`select count(*)::int as n from content_provenance`;
  expect(n).toBe(0);
}));

test("recordAiDraft returns DRAFT_HUMAN when a human draft exists and inserts nothing", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Von Hand" } });
  const r = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "KI" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
  });
  expect(r).toEqual({ cancelled: "DRAFT_HUMAN" });
  const rows = await heads(sql, docId, "de");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "DRAFT_HUMAN", data: { title: "Von Hand" }, is_head_draft: true });
  const [{ n }] = await sql`select count(*)::int as n from content_provenance`;
  expect(n).toBe(0);
}));

test("recordAiDraft records a DRAFT_AI head with merged source_hashes, provenance rows and a real job id", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  const [job] = await sql`insert into ai_jobs (doc_id, locale, field_paths, source_version, state)
    values (${docId}, 'de', ${["title"]}, 1, 'RUNNING') returning id`;
  const r = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo" }, sourceVersion: 1, sourceHashes: hashes,
    provenance: [prov("title", { jobId: Number(job!.id), warnings: ["glossary"] })],
  });
  expect(r).toEqual({ version: 1 });
  const [row] = await heads(sql, docId, "de");
  expect(row).toMatchObject({ state: "DRAFT_AI", is_head_draft: true, data: { title: "Hallo" }, source_hashes: { title: hashes.title } });
  const [p] = await sql`select * from content_provenance where doc_id = ${docId}`;
  expect(p).toMatchObject({ locale: "de", version: 1, field_path: "title", model_id: "m1", warnings: ["glossary"], edited: false });
  expect(Number(p!.job_id)).toBe(Number(job!.id));
}));

test("recordAiDraft rejects source locale, shared and undeclared or prototype-named fields", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  const base = { docId, sourceVersion: 1, sourceHashes: hashes, provenance: [] };
  await expect(recordAiDraft(ctx, { ...base, locale: "en", fields: { title: "x" } })).rejects.toThrow(ValidationError);
  await expect(recordAiDraft(ctx, { ...base, locale: "shared", fields: { title: "x" } })).rejects.toThrow(ValidationError);
  await expect(recordAiDraft(ctx, { ...base, locale: "de", fields: { nope: "x" } })).rejects.toThrow(ValidationError);
  await expect(recordAiDraft(ctx, { ...base, locale: "de", fields: { constructor: "x" } })).rejects.toThrow(ValidationError);
  await expect(recordAiDraft(ctx, { ...base, locale: "de", fields: { slug: "x" } })).rejects.toThrow(ValidationError);
  expect(await heads(sql, docId, "de")).toHaveLength(0);
}));

test("recordAiDraft supersedes a stale APPROVED draft and keeps its non-stale field values", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo", body: "Welt" }, sourceVersion: 1, sourceHashes: hashes,
    provenance: [prov("title"), prov("body")],
  });
  const approved = await approve(ctx, { docId, locale: "de", edits: { title: "Servus" } });
  expect(approved).toEqual({ version: 2 });

  // The source body changes: body is stale, title is not.
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "Brave World" } });
  await publish(ctx, { docId, locale: "en" });
  const newHashes = { body: hashValue("Brave World") };
  const r = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { body: "Tapfere Welt" }, sourceVersion: 2, sourceHashes: newHashes,
    provenance: [prov("body")],
  });
  expect(r).toEqual({ version: 3 });
  const rows = await heads(sql, docId, "de");
  expect(rows.map((x) => [x.version, x.state, x.is_head_draft])).toEqual([
    [1, "DRAFT_AI", false], [2, "APPROVED", false], [3, "DRAFT_AI", true],
  ]);
  expect(rows[2]!.data).toEqual({ title: "Servus", body: "Tapfere Welt" });
  expect(rows[2]!.source_hashes).toEqual({ title: hashes.title, body: newHashes.body });
}));

test("recordAiDraft builds from the published head when there is no draft", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Alt", legal: "Recht" } });
  await publish(ctx, { docId, locale: "de" });
  const r = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Neu" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
  });
  expect(r).toEqual({ version: 2 });
  const rows = await heads(sql, docId, "de");
  expect(rows[0]).toMatchObject({ state: "PUBLISHED", is_head_published: true, is_head_draft: false });
  expect(rows[1]).toMatchObject({ state: "DRAFT_AI", is_head_draft: true, data: { title: "Neu", legal: "Recht" } });
}));

test("concurrent saveDraft and recordAiDraft on the same (doc, locale): the human draft is never overwritten", async () => withTestDb(async (sql) => {
  const other = await extraConnection(sql);
  try {
    const humanCtx = ctxFor(sql, "human");
    const aiCtx = ctxFor(other, "ai");
    for (let i = 0; i < 20; i++) {
      const { docId, hashes } = await setup(sql);
      const [h, a] = await Promise.allSettled([
        saveDraft(humanCtx, { docId, locale: "de", data: { title: `Mensch ${i}` } }),
        recordAiDraft(aiCtx, {
          docId, locale: "de", fields: { title: `KI ${i}` }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
        }),
      ]);
      expect(h.status).toBe("fulfilled");
      expect(a.status).toBe("fulfilled");
      const drafts = await sql`select version, state, data from document_localized
        where doc_id = ${docId} and locale = 'de' and is_head_draft`;
      expect(drafts).toHaveLength(1);
      const aiResult = (a as PromiseFulfilledResult<Awaited<ReturnType<typeof recordAiDraft>>>).value;
      if ("cancelled" in aiResult) {
        expect(aiResult.cancelled).toBe("DRAFT_HUMAN");
        expect(drafts[0]).toMatchObject({ state: "DRAFT_HUMAN", data: { title: `Mensch ${i}` } });
      } else {
        // AI won the lock first, the human draft then superseded it: the human draft must be the head.
        expect(drafts[0]).toMatchObject({ state: "DRAFT_HUMAN", data: { title: `Mensch ${i}` } });
        const all = await sql`select version, state from document_localized where doc_id = ${docId} and locale = 'de' order by version`;
        expect(all.map((x) => x.state)).toEqual(["DRAFT_AI", "DRAFT_HUMAN"]);
      }
    }
  } finally {
    await other.end();
  }
}));

test("approve with edits marks edited provenance and produces APPROVED head", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo", body: "Welt", legal: "Recht" }, sourceVersion: 1, sourceHashes: hashes,
    provenance: [prov("title"), prov("body", { warnings: ["tone"] }), prov("legal")],
  });
  const bulkId = "11111111-1111-4111-8111-111111111111";
  const r = await approve(ctx, {
    docId, locale: "de", edits: { title: "Servus" }, acknowledgedWarnings: ["tone"], bulkId,
  });
  expect(r).toEqual({ version: 2 });
  const rows = await heads(sql, docId, "de");
  expect(rows[0]).toMatchObject({ state: "DRAFT_AI", is_head_draft: false });
  expect(rows[1]).toMatchObject({ state: "APPROVED", is_head_draft: true, data: { title: "Servus", body: "Welt", legal: "Recht" } });
  const p = await sql`select * from content_provenance where doc_id = ${docId} and version = 2 order by field_path`;
  expect(p.map((x) => [x.field_path, x.edited, x.discarded])).toEqual([
    ["body", false, false], ["legal", false, false], ["title", true, false],
  ]);
  for (const x of p) {
    expect(x).toMatchObject({ approved_by: "reviewer", bulk_id: bulkId, acknowledged_warnings: ["tone"], model_id: "m1" });
    expect(x.approved_at).toBeInstanceOf(Date);
  }
  expect(p.find((x) => x.field_path === "body")!.warnings).toEqual(["tone"]);
  // The AI version's own rows are untouched.
  const orig = await sql`select edited, approved_by from content_provenance where doc_id = ${docId} and version = 1`;
  expect(orig.every((x) => x.edited === false && x.approved_by === null)).toBe(true);
}));

test("approve rejectFields reverts to published value", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Alt" } });
  await publish(ctx, { docId, locale: "de" });
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Neu", body: "Welt" }, sourceVersion: 1, sourceHashes: hashes,
    provenance: [prov("title"), prov("body")],
  });
  await approve(ctx, { docId, locale: "de", rejectFields: ["title", "body"] });
  const rows = await heads(sql, docId, "de");
  const head = rows.find((x) => x.is_head_draft)!;
  expect(head.state).toBe("APPROVED");
  expect(head.data).toEqual({ title: "Alt" }); // title reverted, body had no published value: removed
  expect(head.source_hashes).toEqual({ title: hashValue("Hello") });
  const p = await sql`select field_path, discarded, discard_reason from content_provenance where doc_id = ${docId} and version = ${head.version as number} order by field_path`;
  expect(p.map((x) => [x.field_path, x.discarded])).toEqual([["body", true], ["title", true]]);
}));

test("approve on a non-DRAFT_AI head throws NotPublishableError and writes nothing", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await expect(approve(ctx, { docId, locale: "de" })).rejects.toThrow(NotPublishableError); // no head
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Von Hand" } });
  await expect(approve(ctx, { docId, locale: "de" })).rejects.toThrow(NotPublishableError); // DRAFT_HUMAN
  expect(await heads(sql, docId, "de")).toHaveLength(1);
}));

test("approve with an undeclared field in edits throws ValidationError and writes nothing", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
  });
  for (const edits of [{ nope: "x" }, { constructor: "x" }, { title: 5 }]) {
    await expect(approve(ctx, { docId, locale: "de", edits })).rejects.toThrow(ValidationError);
  }
  await expect(approve(ctx, { docId, locale: "de", rejectFields: ["nope"] })).rejects.toThrow(ValidationError);
  await expect(approve(ctx, { docId, locale: "de", edits: { title: "a" }, rejectFields: ["title"] })).rejects.toThrow(ValidationError);
  const rows = await heads(sql, docId, "de");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "DRAFT_AI", is_head_draft: true });
  const [{ n }] = await sql`select count(*)::int as n from content_provenance`;
  expect(n).toBe(1);
}));

test("approve stamps a clock_timestamp read after the lock wait, not the transaction start", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
  });
  const other = await extraConnection(sql);
  try {
    let releasedAt = 0;
    let pending!: Promise<{ version: number }>;
    await other.begin(async (tx) => {
      await tx`select id from documents where id = ${docId} for update`;
      pending = approve(ctx, { docId, locale: "de" });
      await new Promise((r) => setTimeout(r, 400));
      releasedAt = Date.now();
    });
    await pending;
    const [row] = await sql`select approved_at, created_at from content_provenance where doc_id = ${docId} and version = 2`;
    const [snap] = await sql`select created_at from document_localized where doc_id = ${docId} and locale = 'de' and version = 2`;
    expect((row!.approved_at as Date).getTime()).toBeGreaterThanOrEqual(releasedAt - 5);
    expect(row!.approved_at).toEqual(snap!.created_at);
  } finally {
    await other.end();
  }
}));

test("approveClean approves only drafts without warnings and shares one bulk_id", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const { id: docB } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: docB, locale: "en", data: { title: "Hello" } });
  await publish(ctx, { docId: docB, locale: "en" });
  const { id: docC } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: docC, locale: "en", data: { title: "Hello" } });
  await publish(ctx, { docId: docC, locale: "en" });
  const h = { title: hashValue("Hello") };

  await recordAiDraft(ctx, { docId, locale: "de", fields: { title: "A" }, sourceVersion: 1, sourceHashes: h, provenance: [prov("title")] });
  await recordAiDraft(ctx, { docId, locale: "de-CH", fields: { title: "A2" }, sourceVersion: 1, sourceHashes: h, provenance: [prov("title")] });
  await recordAiDraft(ctx, { docId: docB, locale: "de", fields: { title: "B" }, sourceVersion: 1, sourceHashes: h, provenance: [prov("title", { warnings: ["glossary"] })] });
  await recordAiDraft(ctx, { docId: docC, locale: "de", fields: { title: "C" }, sourceVersion: 1, sourceHashes: h, provenance: [prov("title")] });
  await saveDraft(ctx, { docId: docC, locale: "de", data: { title: "C human" } }); // head is now DRAFT_HUMAN: not in scope

  const r = await approveClean(ctx, { locale: "de" });
  expect(r.approved).toBe(1);
  expect(r.skipped).toEqual([{ docId: docB, locale: "de", reason: "has warnings" }]);

  const r2 = await approveClean(ctx, { collection: "posts" });
  expect(r2.approved).toBe(1); // the de-CH draft of docId
  expect(r2.skipped).toEqual([{ docId: docB, locale: "de", reason: "has warnings" }]);

  const bulk = await sql`select distinct bulk_id, approved_by from content_provenance where bulk_id is not null`;
  expect(bulk).toHaveLength(2); // one shared id per approveClean run
  const a = await sql`select doc_id, locale, bulk_id from content_provenance where bulk_id is not null order by locale`;
  expect(a).toHaveLength(2);
  expect(a.every((x) => /^[0-9a-f-]{36}$/.test(x.bulk_id as string))).toBe(true);
  expect((await heads(sql, docB, "de")).map((x) => x.state)).toEqual(["DRAFT_AI"]);

  // Scope filter that matches nothing.
  expect(await approveClean(ctx, { collection: "posts", locale: "de-CH" })).toEqual({ approved: 0, skipped: [] });
  await expect(approveClean(ctx, { collection: "nope" })).rejects.toThrow(ValidationError);
}));

test("approveClean shares a single bulk_id across several approvals", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const { id: docB } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: docB, locale: "en", data: { title: "Hello" } });
  await publish(ctx, { docId: docB, locale: "en" });
  const h = { title: hashValue("Hello") };
  for (const id of [docId, docB]) {
    await recordAiDraft(ctx, { docId: id, locale: "de", fields: { title: "T" }, sourceVersion: 1, sourceHashes: h, provenance: [prov("title")] });
  }
  expect(await approveClean(ctx, {})).toEqual({ approved: 2, skipped: [] });
  const ids = await sql`select distinct bulk_id from content_provenance where bulk_id is not null`;
  expect(ids).toHaveLength(1);
  const n = await sql`select count(*)::int as n from content_provenance where bulk_id is not null`;
  expect(n[0]!.n).toBe(2);
}));
