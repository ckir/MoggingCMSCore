import { expect, test } from "vitest";
import type { Sql } from "postgres";
import {
  ConflictError, NotPublishableError, ValidationError, approve, approveClean, createDocument, getDocument, getDraftReview,
  getSyncState, hashValue, listDraftHeads, migrate, publish, recordAiDraft, rejectDraft, saveDraft, trackFields, unpublish,
} from "../src/index.js";
import { ctxFor, extraConnection, insertPublishedLocalized } from "./fixtures.js";
import { withTestDb } from "./db.js";

const prov = (fieldPath: string, extra: { warnings?: string[]; jobId?: number; callId?: string } = {}) => ({
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
  const a = await sql`select doc_id, locale, bulk_id from content_provenance where model_id = 'human:bulk-approve' order by locale`;
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
  const n = await sql`select count(*)::int as n from content_provenance where model_id = 'human:bulk-approve' and bulk_id = ${ids[0]!.bulk_id as string}`;
  expect(n[0]!.n).toBe(2);
}));

test("approveClean writes exactly one bulk-approval marker per approved draft, including one with no provenance rows", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const { id: docB } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: docB, locale: "en", data: { title: "Hello" } });
  await publish(ctx, { docId: docB, locale: "en" });
  const h = { title: hashValue("Hello") };
  await recordAiDraft(ctx, { docId, locale: "de", fields: { title: "T" }, sourceVersion: 1, sourceHashes: h, provenance: [prov("title"), prov("body")] });
  await recordAiDraft(ctx, { docId: docB, locale: "de", fields: { title: "T" }, sourceVersion: 1, sourceHashes: h, provenance: [] });
  const r = await approveClean(ctx, {});
  expect(r.approved).toBe(2);
  const markers = await sql`select * from content_provenance where model_id = 'human:bulk-approve' order by doc_id`;
  expect(markers).toHaveLength(2);
  expect(new Set(markers.map((m) => m.bulk_id)).size).toBe(1);
  for (const m of markers) {
    expect(m).toMatchObject({
      version: 2, field_path: null, job_id: null, prompt_version: "", prompt_tokens: 0, completion_tokens: 0,
      cost_micros: "0", approved_by: "reviewer", edited: false, discarded: false,
    });
    expect(m.approved_at).toBeInstanceOf(Date);
  }
  expect(markers.map((m) => m.doc_id).sort()).toEqual([docId, docB].sort());
  const [{ n }] = await sql`select count(*)::int as n from content_provenance where model_id = 'human:bulk-approve' and bulk_id = ${markers[0]!.bulk_id as string}`;
  expect(n).toBe(r.approved);
  // Copied field rows carry the bulk id too.
  const copied = await sql`select bulk_id from content_provenance where doc_id = ${docId} and version = 2 and field_path is not null`;
  expect(copied.every((c) => c.bulk_id === markers[0]!.bulk_id)).toBe(true);
}));

test("direct approve writes no bulk marker", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, { docId, locale: "de", fields: { title: "T" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")] });
  await approve(ctx, { docId, locale: "de", bulkId: "22222222-2222-4222-8222-222222222222" });
  const [{ n }] = await sql`select count(*)::int as n from content_provenance where model_id = 'human:bulk-approve'`;
  expect(n).toBe(0);
}));

test("copied provenance rows carry zero tokens and cost; the AI version stays the single cost record", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "T", body: "B" }, sourceVersion: 1, sourceHashes: hashes,
    provenance: [prov("title"), prov("body")],
  });
  await approve(ctx, { docId, locale: "de", edits: { title: "E" } });
  const ai = await sql`select prompt_tokens, completion_tokens, cost_micros from content_provenance where doc_id = ${docId} and version = 1`;
  expect(ai.map((x) => [x.prompt_tokens, x.completion_tokens, Number(x.cost_micros)])).toEqual([[10, 20, 300], [10, 20, 300]]);
  const approved = await sql`select model_id, prompt_version, prompt_tokens, completion_tokens, cost_micros from content_provenance where doc_id = ${docId} and version = 2`;
  expect(approved).toHaveLength(2);
  for (const x of approved) expect(x).toMatchObject({ model_id: "m1", prompt_version: "p1", prompt_tokens: 0, completion_tokens: 0 });
  expect(approved.every((x) => Number(x.cost_micros) === 0)).toBe(true);
  const [{ total }] = await sql`select sum(cost_micros)::int as total from content_provenance where doc_id = ${docId}`;
  expect(total).toBe(600);
}));

test("an edited field hashes the current source published value even when the source moved; non-edited keep the AI hash", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "T", body: "B" }, sourceVersion: 1, sourceHashes: hashes,
    provenance: [prov("title"), prov("body")],
  });
  // Move the source head directly (publish flip by SQL): title changes, body is dropped.
  await sql`update document_localized set is_head_published = false where doc_id = ${docId} and locale = 'en'`;
  await sql`insert into document_localized (doc_id, locale, version, state, data, is_head_published, created_by)
    values (${docId}, 'en', 2, 'PUBLISHED', ${sql.json({ title: "Hello 2" })}, true, 'fixture')`;
  await approve(ctx, { docId, locale: "de", edits: { title: "E" } });
  let [head] = await sql`select source_hashes from document_localized where doc_id = ${docId} and locale = 'de' and is_head_draft`;
  expect(head!.source_hashes).toEqual({ title: hashValue("Hello 2"), body: hashes.body });

  // Edited field the source has no published value for: no hash stored.
  await recordAiDraft(ctx, { docId, locale: "de", fields: { title: "T" }, sourceVersion: 2, sourceHashes: { title: hashValue("Hello 2") }, provenance: [prov("title")] });
  await approve(ctx, { docId, locale: "de", edits: { body: "Neu" } });
  [head] = await sql`select source_hashes from document_localized where doc_id = ${docId} and locale = 'de' and is_head_draft`;
  expect(head!.source_hashes).toEqual({ title: hashValue("Hello 2") });
}));

test("recordAiDraft after unpublish keeps the sibling fields and their hashes", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Deutscher Titel", body: "Deutscher Text" } });
  await publish(ctx, { docId, locale: "de" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "New world" } });
  await publish(ctx, { docId, locale: "en" });
  await unpublish(ctx, { docId, locale: "de" });
  const en = (await getDocument(ctx, { collection: "posts", docId }))!.locales.en!.published!;
  const r = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { body: "Neuer deutscher Text" }, sourceVersion: en.version,
    sourceHashes: { body: en.sourceHashes.body! }, provenance: [prov("body")],
  });
  expect(r).toEqual({ version: 2 });
  const rows = await heads(sql, docId, "de");
  expect(rows[1]).toMatchObject({
    state: "DRAFT_AI", is_head_draft: true,
    data: { title: "Deutscher Titel", body: "Neuer deutscher Text" },
    source_hashes: { title: hashes.title, body: en.sourceHashes.body },
  });
  await approve(ctx, { docId, locale: "de" });
  await publish(ctx, { docId, locale: "de" });
  const states = Object.fromEntries((await getSyncState(ctx, { docId, locale: "de" })).map((x) => [x.field, x.state]));
  expect(states).toEqual({ title: "current", body: "current" });
}));

test("recordAiDraft with only non-head rows and no published head bases on the LATEST row by version", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "de", data: { title: "A" } });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "B", legal: "L" } });
  await sql`update document_localized set is_head_draft = false where doc_id = ${docId} and locale = 'de'`;
  const r = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { body: "Welt" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("body")],
  });
  expect(r).toEqual({ version: 3 });
  const rows = await heads(sql, docId, "de");
  expect(rows[2]!.data).toEqual({ title: "B", legal: "L", body: "Welt" });
  expect(rows[2]!.source_hashes).toEqual({ title: hashes.title, body: hashes.body });
}));

test("recordAiDraft prefers the published head over a later superseded draft row", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await insertPublishedLocalized(sql, docId, "de", 1, { title: "Pub" }, { title: hashes.title });
  await sql`insert into document_localized (doc_id, locale, version, state, data, source_hashes, is_head_draft, created_by)
    values (${docId}, 'de', 2, 'DRAFT_HUMAN', ${sql.json({ title: "Old draft", legal: "x" })}, ${sql.json({})}, false, 'fixture')`;
  const r = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { body: "Welt" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("body")],
  });
  expect(r).toEqual({ version: 3 });
  const rows = await heads(sql, docId, "de");
  expect(rows[2]!.data).toEqual({ title: "Pub", body: "Welt" });
  expect(rows[2]!.source_hashes).toEqual({ title: hashes.title, body: hashes.body });
}));

test("approveClean skips a draft that a human superseded between the scan and the document lock", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
  });
  const other = await extraConnection(sql);
  try {
    let bulk: Promise<Awaited<ReturnType<typeof approveClean>>> | undefined;
    await other.begin(async (tx) => {
      await tx`select id from documents where id = ${docId} for update`; // hold the per-document lock
      bulk = approveClean(ctx, { locale: "de" }); // scan sees the DRAFT_AI head, then blocks on the lock
      for (let i = 0; i < 200; i++) { // wait until approveClean is really queued behind our lock
        const [{ n }] = (await tx`select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and pid <> pg_backend_pid()`) as unknown as [{ n: number }];
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // A human draft takes over the head while approveClean waits.
      await tx`update document_localized set is_head_draft = false where doc_id = ${docId} and locale = 'de' and is_head_draft`;
      await tx`insert into document_localized (doc_id, locale, version, state, data, is_head_draft, created_by)
        values (${docId}, 'de', 99, 'DRAFT_HUMAN', ${tx.json({ title: "Von Hand" })}, true, 'human')`;
    });
    const r = await bulk!;
    expect(r).toEqual({ approved: 0, skipped: [{ docId, locale: "de", reason: "no longer a DRAFT_AI head" }] });
    const rows = await heads(sql, docId, "de");
    expect(rows.filter((x) => x.is_head_draft).map((x) => [x.version, x.state])).toEqual([[99, "DRAFT_HUMAN"]]);
    const [{ n }] = await sql`select count(*)::int as n from content_provenance where bulk_id is not null`;
    expect(n).toBe(0);
  } finally { await other.end(); }
}));

test("superseding a DRAFT_AI head records superseded_version on the new provenance rows", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  const input = { docId, locale: "de", sourceVersion: 1, sourceHashes: hashes };
  expect(await recordAiDraft(ctx, { ...input, fields: { title: "Hallo" }, provenance: [prov("title")] })).toEqual({ version: 1 });
  expect(await recordAiDraft(ctx, { ...input, fields: { title: "Hallo!", body: "Welt" }, provenance: [prov("title"), prov("body")] }))
    .toEqual({ version: 2 });
  const v1 = await sql`select superseded_version from content_provenance where doc_id = ${docId} and version = 1`;
  expect(v1.map((r) => r.superseded_version)).toEqual([null]);
  const v2 = await sql`select superseded_version from content_provenance where doc_id = ${docId} and version = 2`;
  expect(v2).toHaveLength(2);
  expect(v2.map((r) => r.superseded_version)).toEqual([1, 1]);
}));

test("superseding an APPROVED head records the APPROVED version as superseded_version", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  const input = { docId, locale: "de", sourceVersion: 1, sourceHashes: hashes };
  expect(await recordAiDraft(ctx, { ...input, fields: { title: "Hallo" }, provenance: [prov("title")] })).toEqual({ version: 1 });
  expect(await approve(ctx, { docId, locale: "de" })).toEqual({ version: 2 });
  expect(await recordAiDraft(ctx, { ...input, fields: { title: "Hallo!", body: "Welt" }, provenance: [prov("title"), prov("body")] }))
    .toEqual({ version: 3 });
  const v3 = await sql`select superseded_version from content_provenance where doc_id = ${docId} and version = 3`;
  expect(v3).toHaveLength(2);
  expect(v3.map((r) => r.superseded_version)).toEqual([2, 2]);
}));

test("a first AI draft over a published head records superseded_version null", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await insertPublishedLocalized(sql, docId, "de", 1, { title: "Pub" }, { title: hashes.title });
  expect(await recordAiDraft(ctx, {
    docId, locale: "de", fields: { body: "Welt" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("body")],
  })).toEqual({ version: 2 });
  const rows = await sql`select superseded_version from content_provenance where doc_id = ${docId} and version = 2`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.superseded_version).toBeNull();
}));

test("a provenance entry with callId stores it; without, call_id is null", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  const callId = "3f2b8c1e-5d4a-4e7b-9a6c-0d1e2f3a4b5c";
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo", body: "Welt" }, sourceVersion: 1, sourceHashes: hashes,
    provenance: [prov("title", { callId }), prov("body")],
  });
  const rows = await sql`select field_path, call_id from content_provenance where doc_id = ${docId} order by field_path`;
  expect(rows.map((r) => [r.field_path, r.call_id])).toEqual([["body", null], ["title", callId]]);
}));

test("approve copies call_id and superseded_version onto the APPROVED version's provenance rows", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  const callId = "3f2b8c1e-5d4a-4e7b-9a6c-0d1e2f3a4b5c";
  const input = { docId, locale: "de", sourceVersion: 1, sourceHashes: hashes };
  await recordAiDraft(ctx, { ...input, fields: { title: "Hallo" }, provenance: [prov("title")] });
  await recordAiDraft(ctx, { ...input, fields: { title: "Hallo!" }, provenance: [prov("title", { callId })] });
  const approved = await approve(ctx, { docId, locale: "de" });
  expect(approved).toEqual({ version: 3 });
  const rows = await sql`select call_id, superseded_version, approved_by from content_provenance
    where doc_id = ${docId} and version = 3 and field_path = 'title'`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ call_id: callId, superseded_version: 1, approved_by: "reviewer" });
}));

test("glossary rejects a duplicate (source_locale, target_locale, term) and requires updated_by", async () => withTestDb(async (sql) => {
  await migrate(sql);
  await sql`insert into glossary (source_locale, target_locale, term, updated_by) values ('en', 'de', 'Dashboard', 'owner')`;
  await expect(sql`insert into glossary (source_locale, target_locale, term, updated_by) values ('en', 'de', 'Dashboard', 'owner')`)
    .rejects.toMatchObject({ code: "23505" });
  await sql`insert into glossary (source_locale, target_locale, term, updated_by) values ('en', 'fr', 'Dashboard', 'owner')`;
  await expect(sql`insert into glossary (source_locale, target_locale, term) values ('en', 'de', 'Other')`)
    .rejects.toMatchObject({ code: "23502" });
  const [g] = await sql`select updated_at from glossary where target_locale = 'fr'`;
  expect(g!.updated_at).toBeInstanceOf(Date);
}));

// ---- expectedVersion (D-stale), the warnings gate (D-warn) and field_warnings (D-fwarn) ----

const W1 = 'glossary: "cat" expected "gata"';
const W2 = "tone: too formal";

/** An AI draft whose provenance rows carry `warned[field]` (fields not listed have none). */
function aiDraft(
  ctx: ReturnType<typeof ctxFor>, docId: string, fields: Record<string, unknown>, warned: Record<string, string[]> = {},
  sourceVersion = 1, sourceHashes: Record<string, string> = { title: hashValue("Hello"), body: hashValue("World") },
) {
  return recordAiDraft(ctx, {
    docId, locale: "de", fields, sourceVersion, sourceHashes,
    provenance: Object.keys(fields).map((k) => prov(k, { warnings: warned[k] ?? [] })),
  });
}

/** Publishes a new source body ("World 2") and returns the v2 hashes for a body-only AI draft. */
async function moveSourceBody(ctx: ReturnType<typeof ctxFor>, docId: string) {
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World 2" } });
  await publish(ctx, { docId, locale: "en" });
  return { body: hashValue("World 2") };
}

const fieldWarnings = async (sql: Sql, docId: string) =>
  (await sql`select version, state, field_warnings from document_localized where doc_id = ${docId} and locale = 'de' order by version`)
    .map((r) => [r.version, r.state, r.field_warnings]);

test("approve with a stale expectedVersion throws ConflictError, writes no APPROVED row and leaves the draft head and its provenance untouched", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Hallo", body: "Welt" });
  await aiDraft(ctx, docId, { title: "Hallo 2" }); // v2 replaces v1
  const before = await sql`select * from content_provenance order by id`;
  await expect(approve(ctx, { docId, locale: "de", expectedVersion: 1 }))
    .rejects.toThrow(`Expected draft version 1 of ${docId}/de but the head is 2`);
  await expect(approve(ctx, { docId, locale: "de", expectedVersion: 1 })).rejects.toThrow(ConflictError);
  expect((await heads(sql, docId, "de")).map((r) => [r.version, r.state, r.is_head_draft])).toEqual([
    [1, "DRAFT_AI", false], [2, "DRAFT_AI", true],
  ]);
  expect(await sql`select * from content_provenance order by id`).toEqual(before);
}));

test("approve with the current expectedVersion behaves as without", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Hallo", body: "Welt" });
  expect(await approve(ctx, { docId, locale: "de", expectedVersion: 1 })).toEqual({ version: 2 });
  expect((await heads(sql, docId, "de"))[1]).toMatchObject({ state: "APPROVED", is_head_draft: true });
}));

test("approve with edits and a stale expectedVersion stores none of the edits", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Hallo", body: "Welt" });
  await aiDraft(ctx, docId, { title: "Hallo 2" });
  await expect(approve(ctx, { docId, locale: "de", edits: { title: "Servus" }, expectedVersion: 1 })).rejects.toThrow(ConflictError);
  const rows = await heads(sql, docId, "de");
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ state: "DRAFT_AI", is_head_draft: true, data: { title: "Hallo 2", body: "Welt" } });
}));

test("approveClean still approves a head whose version changed since the scan", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Hallo", body: "Welt" });
  await aiDraft(ctx, docId, { title: "Hallo 2" });
  expect(await approveClean(ctx)).toEqual({ approved: 1, skipped: [] });
  expect((await heads(sql, docId, "de"))[2]).toMatchObject({ version: 3, state: "APPROVED" });
}));

test("approve of a draft with warnings and no acknowledgedWarnings throws ValidationError naming the warning text and writes nothing", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Hallo", body: "Welt" }, { title: [W1] });
  const before = await sql`select * from content_provenance order by id`;
  const e = await approve(ctx, { docId, locale: "de" }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  expect((e as Error).message).toBe(`${docId}/de has 1 warning(s) not acknowledged: ${W1}`);
  expect(await heads(sql, docId, "de")).toHaveLength(1);
  expect(await sql`select * from content_provenance order by id`).toEqual(before);
}));

test("acknowledging every distinct text approves and records acknowledged_warnings on every row", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Hallo", body: "Welt" }, { title: [W1], body: [W1] });
  expect(await approve(ctx, { docId, locale: "de", acknowledgedWarnings: [W1] })).toEqual({ version: 2 });
  const p = await sql`select field_path, acknowledged_warnings from content_provenance where doc_id = ${docId} and version = 2 order by field_path`;
  expect(p.map((r) => [r.field_path, r.acknowledged_warnings])).toEqual([["body", [W1]], ["title", [W1]]]);
}));

test("a partial acknowledgement (two distinct texts, one named) throws and names the missing one", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Hallo", body: "Welt" }, { title: [W1], body: [W2] });
  const e = await approve(ctx, { docId, locale: "de", acknowledgedWarnings: [W1] }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  expect((e as Error).message).toBe(`${docId}/de has 2 warning(s) not acknowledged: ${W2}`);
  expect(await heads(sql, docId, "de")).toHaveLength(1);
}));

test("an acknowledgement for a text the draft does not carry throws", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Hallo", body: "Welt" }, { title: [W1] });
  const e = await approve(ctx, { docId, locale: "de", acknowledgedWarnings: [W1, "invented"] }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  expect((e as Error).message).toBe(`${docId}/de acknowledges unknown warnings: invented`);
  expect(await heads(sql, docId, "de")).toHaveLength(1);
}));

test("a warning-free draft with a non-empty acknowledgedWarnings throws", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Hallo", body: "Welt" });
  await expect(approve(ctx, { docId, locale: "de", acknowledgedWarnings: ["tone"] })).rejects.toThrow(/acknowledges unknown warnings: tone/);
  expect(await heads(sql, docId, "de")).toHaveLength(1);
  // An empty acknowledgement is the same as none.
  expect(await approve(ctx, { docId, locale: "de", acknowledgedWarnings: [] })).toEqual({ version: 2 });
}));

test("a field carried over from a superseded draft keeps its warning: approve, approveClean, getDraftReview and listDraftHeads see it", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  const body = await moveSourceBody(ctx, docId);
  await aiDraft(ctx, docId, { body: "Welt 2" }, {}, 2, body); // v2 carries title from v1
  expect(await fieldWarnings(sql, docId)).toEqual([[1, "DRAFT_AI", { title: [W1] }], [2, "DRAFT_AI", { title: [W1] }]]);

  await expect(approve(ctx, { docId, locale: "de" })).rejects.toThrow(W1);
  expect(await approveClean(ctx)).toEqual({ approved: 0, skipped: [{ docId, locale: "de", reason: "has warnings" }] });
  const review = await getDraftReview(ctx, { docId, locale: "de" });
  expect(review.version).toBe(2);
  expect(review.fields.find((f) => f.path === "title")!.warnings).toEqual([W1]);
  expect(review.fields.find((f) => f.path === "body")!.warnings).toEqual([]);
  expect((await listDraftHeads(ctx)).items).toMatchObject([{ docId, locale: "de", version: 2, warningCount: 1 }]);

  expect(await approve(ctx, { docId, locale: "de", acknowledgedWarnings: [W1] })).toEqual({ version: 3 });
}));

test("an edited and acknowledged warning is not demanded again by a later draft that carries the field", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  await approve(ctx, { docId, locale: "de", edits: { title: "Hallo" }, acknowledgedWarnings: [W1] });
  const body = await moveSourceBody(ctx, docId);
  await aiDraft(ctx, docId, { body: "Welt 2" }, {}, 2, body); // v3 carries title from the APPROVED v2
  expect(await fieldWarnings(sql, docId)).toEqual([
    [1, "DRAFT_AI", { title: [W1] }], [2, "APPROVED", {}], [3, "DRAFT_AI", {}],
  ]);
  const review = await getDraftReview(ctx, { docId, locale: "de" });
  expect(review.fields.every((f) => f.warnings.length === 0)).toBe(true);
  expect(await approve(ctx, { docId, locale: "de" })).toEqual({ version: 4 });
}));

test("the gate holds after track", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  const body = await moveSourceBody(ctx, docId);
  await aiDraft(ctx, docId, { body: "Welt 2" }, {}, 2, body);
  await trackFields(ctx, { docId, locale: "de", fields: ["title"] }); // the never-published de's draft head
  await expect(approve(ctx, { docId, locale: "de" })).rejects.toThrow(W1);
  expect(await approveClean(ctx)).toEqual({ approved: 0, skipped: [{ docId, locale: "de", reason: "has warnings" }] });
}));

test("a reject discards the rejected draft's text and its warnings: the next draft carries neither", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  await rejectDraft(ctx, { docId, locale: "de" });
  await aiDraft(ctx, docId, { body: "Welt 2" }); // v2 has no base: the rejected v1 row is not carried
  expect(await fieldWarnings(sql, docId)).toEqual([[1, "DRAFT_AI", { title: [W1] }], [2, "DRAFT_AI", {}]]);
  const review = await getDraftReview(ctx, { docId, locale: "de" });
  expect(review.fields.every((f) => f.warnings.length === 0)).toBe(true);
  expect(await approve(ctx, { docId, locale: "de" })).toEqual({ version: 3 });
}));

test("the gate holds with no provenance rows", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  const body = await moveSourceBody(ctx, docId);
  await recordAiDraft(ctx, { docId, locale: "de", fields: { body: "Welt 2" }, sourceVersion: 2, sourceHashes: body, provenance: [] });
  await expect(approve(ctx, { docId, locale: "de" })).rejects.toThrow(W1);
  expect(await approve(ctx, { docId, locale: "de", acknowledgedWarnings: [W1] })).toEqual({ version: 3 });
  const marker = await sql`select * from content_provenance where doc_id = ${docId} and version = 3`;
  expect(marker).toHaveLength(1);
  expect(marker[0]).toMatchObject({
    model_id: "human:approve", field_path: null, warnings: [W1], acknowledged_warnings: [W1], approved_by: "reviewer",
    prompt_version: "", prompt_tokens: 0, completion_tokens: 0, cost_micros: "0",
  });
  expect(marker[0]!.approved_at).toBeInstanceOf(Date);
}));

test("a warning-free draft with provenance [] approves with no human:approve row", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, { docId, locale: "de", fields: { title: "Hallo" }, sourceVersion: 1, sourceHashes: hashes, provenance: [] });
  expect(await approve(ctx, { docId, locale: "de" })).toEqual({ version: 2 });
  const [{ n }] = await sql`select count(*)::int as n from content_provenance where model_id = 'human:approve'`;
  expect(n).toBe(0);
}));

test("provenance naming a field not in fields leaves field_warnings without that field", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo" }, sourceVersion: 1, sourceHashes: hashes,
    provenance: [prov("title"), prov("body", { warnings: [W1] })],
  });
  expect(await fieldWarnings(sql, docId)).toEqual([[1, "DRAFT_AI", {}]]);
  expect(await approve(ctx, { docId, locale: "de" })).toEqual({ version: 2 });
}));

test("acknowledge once: a later draft that carries an acknowledged field needs no acknowledgement and is approveClean-able", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  await approve(ctx, { docId, locale: "de", acknowledgedWarnings: [W1] }); // no edits
  const body = await moveSourceBody(ctx, docId);
  await aiDraft(ctx, docId, { body: "Welt 2" }, {}, 2, body); // v3
  expect(await approveClean(ctx)).toEqual({ approved: 1, skipped: [] });
  expect((await heads(sql, docId, "de"))[3]).toMatchObject({ version: 4, state: "APPROVED" });
}));

test("a re-drafted field drops its old warning", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  await aiDraft(ctx, docId, { title: "Hallo" });
  expect(await fieldWarnings(sql, docId)).toEqual([[1, "DRAFT_AI", { title: [W1] }], [2, "DRAFT_AI", {}]]);
  expect(await approve(ctx, { docId, locale: "de" })).toEqual({ version: 3 });
}));

test("a null field drops its warning", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  await recordAiDraft(ctx, { docId, locale: "de", fields: { title: null }, sourceVersion: 1, sourceHashes: hashes, provenance: [] });
  expect(await fieldWarnings(sql, docId)).toEqual([[1, "DRAFT_AI", { title: [W1] }], [2, "DRAFT_AI", {}]]);
  expect(await approve(ctx, { docId, locale: "de" })).toEqual({ version: 3 });
}));

test("field_warnings is {} on APPROVED, DRAFT_HUMAN and republished rows", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  await approve(ctx, { docId, locale: "de", acknowledgedWarnings: [W1] }); // v2 APPROVED
  await publish(ctx, { docId, locale: "de" }); // v2 PUBLISHED
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Von Hand" } }); // v3 DRAFT_HUMAN
  await publish(ctx, { docId, locale: "de" }); // v3 PUBLISHED, v2 no longer the head
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Noch einmal" } }); // v4 DRAFT_HUMAN
  await publish(ctx, { docId, locale: "de", version: 2 }); // v5 is a republish copy of v2
  expect(await fieldWarnings(sql, docId)).toEqual([
    [1, "DRAFT_AI", { title: [W1] }], [2, "PUBLISHED", {}], [3, "PUBLISHED", {}], [4, "DRAFT_HUMAN", {}], [5, "PUBLISHED", {}],
  ]);
}));

test("a stale expectedVersion is a ConflictError, not a warnings ValidationError", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await aiDraft(ctx, docId, { title: "Katze", body: "Welt" }, { title: [W1] });
  await aiDraft(ctx, docId, { title: "Katze 2" }, { title: [W2] });
  await expect(approve(ctx, { docId, locale: "de", expectedVersion: 1, acknowledgedWarnings: [W1] })).rejects.toThrow(ConflictError);
}));

test("approve with an acknowledged warning containing U+0000 is a ValidationError and writes nothing", async () => withTestDb(async (sql) => {
  const { ctx, docId, hashes } = await setup(sql);
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
  });
  // Warnings come from the database and cannot hold U+0000, so an acknowledgement that does is "unknown" and refused.
  await expect(approve(ctx, { docId, locale: "de", acknowledgedWarnings: ["tone\u0000"] })).rejects.toThrow(ValidationError);
  const [{ n }] = await sql`select count(*)::int as n from document_localized where doc_id = ${docId} and locale = 'de' and state = 'APPROVED'`;
  expect(n).toBe(0);
}));
