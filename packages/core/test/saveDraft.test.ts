import { expect, test } from "vitest";
import { ConflictError, NotFoundError, ValidationError, createDocument, deleteDocument, hashValue, migrate, saveDraft } from "../src/index.js";
import { ctxFor, extraConnection, insertPublishedLocalized } from "./fixtures.js";
import { withTestDb } from "./db.js";
import type { Sql } from "postgres";

async function setup(sql: Sql) {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  return { ctx, docId };
}

test("first save allocates version 1 and becomes draft head", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  expect(await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello" } })).toEqual({ version: 1 });
  const [row] = await sql`select * from document_localized where doc_id = ${docId}`;
  expect(row).toMatchObject({ locale: "en", version: 1, state: "DRAFT_HUMAN", is_head_draft: true, is_head_published: false, created_by: "tester", data: { title: "Hello" } });
  expect(row!.source_hashes).toEqual({ title: hashValue("Hello") });
}));

test("second save allocates version 2 and clears the previous draft head", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  expect(await saveDraft(ctx, { docId, locale: "en", data: { title: "B" } })).toEqual({ version: 2 });
  const rows = await sql`select version, is_head_draft from document_localized where doc_id = ${docId} order by version`;
  expect(rows.map(r => [r.version, r.is_head_draft])).toEqual([[1, false], [2, true]]);
}));

test("undeclared field is rejected", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await expect(saveDraft(ctx, { docId, locale: "en", data: { titel: "x" } })).rejects.toThrow(ValidationError);
}));

test("a draft with a valid and an undeclared field stores nothing", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await expect(saveDraft(ctx, { docId, locale: "en", data: { title: "ok", titel: "x" } })).rejects.toThrow(ValidationError);
  const [{ n }] = await sql`select count(*)::int as n from document_localized where doc_id = ${docId}`;
  expect(n).toBe(0);
}));

test("shared field saved under a locale is rejected, and vice versa", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await expect(saveDraft(ctx, { docId, locale: "en", data: { slug: "hello" } })).rejects.toThrow(ValidationError);
  await expect(saveDraft(ctx, { docId, locale: "shared", data: { title: "x" } })).rejects.toThrow(ValidationError);
  expect(await saveDraft(ctx, { docId, locale: "shared", data: { slug: "Hello" } })).toEqual({ version: 1 });
  const [row] = await sql`select * from document_shared where doc_id = ${docId}`;
  expect(row).toMatchObject({ version: 1, state: "DRAFT_HUMAN", is_head_draft: true, created_by: "tester", data: { slug: "hello" } });
}));

test("top-level null is stripped before storage", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", legal: null } });
  const [row] = await sql`select data, source_hashes from document_localized where doc_id = ${docId}`;
  expect(row!.data).toEqual({ title: "Hello" });
  expect(Object.keys(row!.source_hashes)).toEqual(["title"]);
}));

test("values are normalized before storage (NFC)", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Café" } });
  const [row] = await sql`select data from document_localized where doc_id = ${docId}`;
  expect(row!.data).toEqual({ title: "Café" });
}));

test("locale de-ch is stored as de-CH", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "de-ch", data: { title: "Gruezi" } });
  const rows = await sql`select locale from document_localized where doc_id = ${docId}`;
  expect(rows.map(r => r.locale)).toEqual(["de-CH"]);
}));

test("undeclared or malformed locale is rejected", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await expect(saveDraft(ctx, { docId, locale: "fr", data: { title: "x" } })).rejects.toThrow(ValidationError);
  await expect(saveDraft(ctx, { docId, locale: "de_CH", data: { title: "x" } })).rejects.toThrow(ValidationError);
}));

test("unknown document and unknown collection throw NotFoundError", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await expect(saveDraft(ctx, { docId: "00000000-0000-4000-8000-000000000000", locale: "en", data: {} })).rejects.toThrow(NotFoundError);
  await expect(createDocument(ctx, { collection: "nope" })).rejects.toThrow(NotFoundError);
  await deleteDocument(ctx, { docId });
  const [d] = await sql`select deleted_at from documents where id = ${docId}`;
  expect(d!.deleted_at).not.toBeNull();
  await expect(saveDraft(ctx, { docId, locale: "en", data: {} })).rejects.toThrow(NotFoundError);
}));

test("human save of a target records current source hashes", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await insertPublishedLocalized(sql, docId, "en", 1, { title: "Hello" }, { title: hashValue("Hello") });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Hallo", legal: "Recht" } });
  const [row] = await sql`select source_hashes from document_localized where doc_id = ${docId} and locale = 'de'`;
  // legal has no published source value: no hash is recorded (reads as untracked, spec 6.4)
  expect(row!.source_hashes).toEqual({ title: hashValue("Hello") });
}));

test("source locale save records the hash of its own values", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", price: 5 } });
  const [row] = await sql`select source_hashes from document_localized where doc_id = ${docId}`;
  expect(row!.source_hashes).toEqual({ title: hashValue("Hello"), price: hashValue(5) });
}));

test("a save is a complete snapshot: omitted fields are absent", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A", legal: "L" } });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "B" } });
  const [row] = await sql`select data from document_localized where doc_id = ${docId} and is_head_draft`;
  expect(row!.data).toEqual({ title: "B" });
}));

test("stale expectedVersion throws ConflictError; matching one succeeds", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await expect(saveDraft(ctx, { docId, locale: "en", data: { title: "x" }, expectedVersion: 3 })).rejects.toThrow(ConflictError);
  expect(await saveDraft(ctx, { docId, locale: "en", data: { title: "x" }, expectedVersion: 0 })).toEqual({ version: 1 });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "y" } });
  await expect(saveDraft(ctx, { docId, locale: "en", data: { title: "z" }, expectedVersion: 1 })).rejects.toThrow(ConflictError);
  expect(await saveDraft(ctx, { docId, locale: "en", data: { title: "z" }, expectedVersion: 2 })).toEqual({ version: 3 });
}));

test("expectedVersion falls back to the published head when no draft head exists", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await insertPublishedLocalized(sql, docId, "en", 1, { title: "P" });
  await expect(saveDraft(ctx, { docId, locale: "en", data: { title: "x" }, expectedVersion: 0 })).rejects.toThrow(ConflictError);
  expect(await saveDraft(ctx, { docId, locale: "en", data: { title: "x" }, expectedVersion: 1 })).toEqual({ version: 2 });
}));

test("two concurrent saves with the same expectedVersion: one succeeds, one conflicts (repeated)", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const other = await extraConnection(sql);
  try {
    const ctxB = ctxFor(other, "other");
    for (let i = 0; i < 25; i++) {
      const [{ n }] = await sql`select count(*)::int as n from document_localized where doc_id = ${docId}`;
      const a = { docId, locale: "en", data: { title: `v${i}` }, expectedVersion: n };
      const results = await Promise.allSettled([saveDraft(ctx, a), saveDraft(ctxB, a)]);
      expect(results.filter(r => r.status === "fulfilled"), `round ${i}`).toHaveLength(1);
      expect(results.filter(r => r.status === "rejected" && r.reason instanceof ConflictError), `round ${i}`).toHaveLength(1);
    }
    const heads = await sql`select count(*)::int as n from document_localized where doc_id = ${docId} and is_head_draft`;
    expect(heads[0]!.n).toBe(1);
  } finally {
    await other.end();
  }
}));

test("prototype-named undeclared keys are rejected and nothing is written", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    for (const locale of ["de", "shared"]) {
      const data = JSON.parse(`{"${key}":1}`) as Record<string, unknown>;
      await expect(saveDraft(ctx, { docId, locale, data }), `${locale}/${key}`).rejects.toThrow(ValidationError);
    }
  }
  const [{ n: nl }] = await sql`select count(*)::int as n from document_localized where doc_id = ${docId}`;
  const [{ n: ns }] = await sql`select count(*)::int as n from document_shared where doc_id = ${docId}`;
  expect([nl, ns]).toEqual([0, 0]);
}));
