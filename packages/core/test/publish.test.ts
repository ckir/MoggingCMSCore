import { expect, test } from "vitest";
import {
  NotFoundError, NotPublishableError, ValidationError, createDocument, defineCollection, defineConfig, deleteDocument,
  migrate, publish, resolve, richText, saveDraft, slug, text, unpublish,
} from "../src/index.js";
import { ctxFor, extraConnection, insertAiDraftLocalized, md } from "./fixtures.js";
import { withTestDb } from "./db.js";
import type { Sql } from "postgres";

async function setup(sql: Sql) {
  await migrate(sql);
  const ctx = ctxFor(sql, "publisher");
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  return { ctx, docId };
}

test("publish flips flags and stamps published_at/published_by", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await publish(ctx, { docId, locale: "en" });
  const [row] = await sql`select * from document_localized where doc_id = ${docId}`;
  expect(row).toMatchObject({ state: "PUBLISHED", is_head_published: true, is_head_draft: false, published_by: "publisher", unpublished_at: null });
  expect(row!.published_at).toBeInstanceOf(Date);
}));

test("previous head gets unpublished_at", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "B" } });
  await publish(ctx, { docId, locale: "en" });
  const rows = await sql`select version, is_head_published, state, published_at, unpublished_at from document_localized where doc_id = ${docId} order by version`;
  expect(rows[0]).toMatchObject({ version: 1, is_head_published: false, state: "PUBLISHED" });
  expect(rows[0]!.unpublished_at).toBeInstanceOf(Date);
  expect(rows[1]).toMatchObject({ version: 2, is_head_published: true, unpublished_at: null });
  expect(rows[0]!.unpublished_at).toEqual(rows[1]!.published_at);
}));

test("DRAFT_AI cannot be published", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await insertAiDraftLocalized(sql, docId, "de", 1, { title: "KI" });
  await expect(publish(ctx, { docId, locale: "de" })).rejects.toThrow(NotPublishableError);
  await expect(publish(ctx, { docId, locale: "de", version: 1 })).rejects.toThrow(NotPublishableError);
  const [row] = await sql`select state, is_head_draft, is_head_published from document_localized where doc_id = ${docId}`;
  expect(row).toMatchObject({ state: "DRAFT_AI", is_head_draft: true, is_head_published: false });
}));

test("a historical draft version cannot be published", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "B" } });
  await expect(publish(ctx, { docId, locale: "en", version: 1 })).rejects.toThrow(NotPublishableError);
  const rows = await sql`select version, is_head_draft, is_head_published from document_localized where doc_id = ${docId} order by version`;
  expect(rows.map(r => [r.version, r.is_head_draft, r.is_head_published])).toEqual([[1, false, false], [2, true, false]]);
}));

test("republish by version inserts a copy; the original row keeps its own publication window", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await publish(ctx, { docId, locale: "en" });
  const [before] = await sql`select id, published_at from document_localized where doc_id = ${docId}`;
  await unpublish(ctx, { docId, locale: "en" });
  const [mid] = await sql`select is_head_published, unpublished_at, unpublished_by, state from document_localized where doc_id = ${docId}`;
  expect(mid).toMatchObject({ is_head_published: false, state: "PUBLISHED", unpublished_by: "publisher" });
  expect(mid!.unpublished_at).toBeInstanceOf(Date);
  await new Promise((r) => setTimeout(r, 5)); // keep the republish instant strictly after the unpublish instant
  await publish(ctxFor(sql, "rollbacker"), { docId, locale: "en", version: 1 });
  const rows = await sql`select id, version, state, data, source_hashes, is_head_published, is_head_draft, created_by, published_at, published_by,
      unpublished_at from document_localized where doc_id = ${docId} order by version`;
  expect(rows).toHaveLength(2);
  // The original keeps its id, its window and its flags; republishing did not touch it.
  expect(rows[0]).toMatchObject({ id: before!.id, version: 1, is_head_published: false, unpublished_at: mid!.unpublished_at, created_by: "publisher" });
  expect(rows[0]!.published_at).toEqual(before!.published_at);
  // The copy is the new published head with the same content.
  expect(rows[1]).toMatchObject({
    version: 2, state: "PUBLISHED", data: { title: "A" }, is_head_published: true, is_head_draft: false,
    created_by: "rollbacker", published_by: "rollbacker", unpublished_at: null,
  });
  expect(Object.keys(rows[1]!.source_hashes as object)).toEqual(["title"]);
  expect(rows[1]!.source_hashes).toEqual(rows[0]!.source_hashes);
  // Time travel inside the original window still sees the original publication.
  const inside = await resolve(ctx, { collection: "posts", locale: "en", ids: [docId], asOf: before!.published_at as Date });
  expect(inside.map((d) => d.data.title)).toEqual(["A"]);
  const gap = await resolve(ctx, { collection: "posts", locale: "en", ids: [docId], asOf: new Date((mid!.unpublished_at as Date).getTime() + 0) });
  expect(gap).toEqual([]);
}));

test("republish leaves an existing draft head untouched", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "B" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "C" } });
  await publish(ctx, { docId, locale: "en", version: 1 });
  const rows = await sql`select version, state, data, is_head_draft, is_head_published from document_localized where doc_id = ${docId} order by version`;
  expect(rows.map(r => [r.version, r.state, r.is_head_draft, r.is_head_published])).toEqual([
    [1, "PUBLISHED", false, false], [2, "PUBLISHED", false, false], [3, "DRAFT_HUMAN", true, false], [4, "PUBLISHED", false, true],
  ]);
  expect(rows[3]!.data).toEqual({ title: "A" });
}));

test("unpublish leaves the draft head alone and is a no-op when nothing is published", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await unpublish(ctx, { docId, locale: "en" });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "B" } });
  await unpublish(ctx, { docId, locale: "en" });
  await unpublish(ctx, { docId, locale: "en" });
  const rows = await sql`select version, is_head_draft, is_head_published from document_localized where doc_id = ${docId} order by version`;
  expect(rows.map(r => [r.version, r.is_head_draft, r.is_head_published])).toEqual([[1, false, false], [2, true, false]]);
  await expect(unpublish(ctx, { docId: "00000000-0000-4000-8000-000000000000", locale: "en" })).rejects.toThrow(NotFoundError);
}));

test("shared snapshot follows the same lifecycle", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "shared", data: { slug: "one" } });
  await publish(ctx, { docId, locale: "shared" });
  await saveDraft(ctx, { docId, locale: "shared", data: { slug: "two" } });
  await publish(ctx, { docId, locale: "shared" });
  let rows = await sql`select version, state, is_head_draft, is_head_published, published_by, published_at, unpublished_at from document_shared where doc_id = ${docId} order by version`;
  expect(rows[0]).toMatchObject({ version: 1, state: "PUBLISHED", is_head_published: false, is_head_draft: false });
  expect(rows[0]!.unpublished_at).toBeInstanceOf(Date);
  expect(rows[1]).toMatchObject({ version: 2, state: "PUBLISHED", is_head_published: true, published_by: "publisher", unpublished_at: null });
  await unpublish(ctx, { docId, locale: "shared" });
  await publish(ctx, { docId, locale: "shared", version: 2 }); // republish: inserts v3 as a copy
  await saveDraft(ctx, { docId, locale: "shared", data: { slug: "three" } });
  await expect(publish(ctx, { docId, locale: "shared", version: 3 })).rejects.toThrow(NotPublishableError); // already the head
  rows = await sql`select version, data, is_head_draft, is_head_published from document_shared where doc_id = ${docId} order by version`;
  expect(rows.map(r => [r.version, r.is_head_draft, r.is_head_published])).toEqual([[1, false, false], [2, false, false], [3, false, true], [4, true, false]]);
  expect(rows[2]!.data).toEqual({ slug: "two" });
}));

test("APPROVED draft head can be published", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await sql`update document_localized set state = 'APPROVED' where doc_id = ${docId}`;
  await publish(ctx, { docId, locale: "en" });
  const [row] = await sql`select state, is_head_published from document_localized where doc_id = ${docId}`;
  expect(row).toMatchObject({ state: "PUBLISHED", is_head_published: true });
}));

test("publishing with no draft head and no version throws NotPublishableError", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await publish(ctx, { docId, locale: "en" });
  await expect(publish(ctx, { docId, locale: "en" })).rejects.toThrow(NotPublishableError);
}));

test("unknown document, locale or version throws NotFoundError", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await expect(publish(ctx, { docId: "00000000-0000-4000-8000-000000000000", locale: "en" })).rejects.toThrow(NotFoundError);
  await expect(publish(ctx, { docId: "not-a-uuid", locale: "en" })).rejects.toThrow(NotFoundError);
  await expect(publish(ctx, { docId, locale: "de" })).rejects.toThrow(NotFoundError);
  await expect(publish(ctx, { docId, locale: "en", version: 99 })).rejects.toThrow(NotFoundError);
}));

test("two concurrent publishes of the same draft head: one wins, the other is NotPublishable", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const other = await extraConnection(sql);
  try {
    const ctx2 = ctxFor(other, "other");
    for (let i = 0; i < 20; i++) {
      await saveDraft(ctx, { docId, locale: "en", data: { title: `v${i}` } });
      const results = await Promise.allSettled([publish(ctx, { docId, locale: "en" }), publish(ctx2, { docId, locale: "en" })]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult;
      expect(failed.reason).toBeInstanceOf(NotPublishableError);
      const [{ n }] = await sql`select count(*)::int as n from document_localized where doc_id = ${docId} and is_head_published`;
      expect(n).toBe(1);
    }
  } finally { await other.end(); }
}));

test("lifecycle timestamps are millisecond-granular and touch exactly", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "B" } });
  await publish(ctx, { docId, locale: "en" });
  await unpublish(ctx, { docId, locale: "en" });
  await deleteDocument(ctx, { docId });
  const rows = await sql`select published_at = date_trunc('milliseconds', published_at) as p_ms,
      unpublished_at = date_trunc('milliseconds', unpublished_at) as u_ms from document_localized where doc_id = ${docId} order by version`;
  expect(rows.map((r) => [r.p_ms, r.u_ms])).toEqual([[true, true], [true, true]]);
  const [d] = await sql`select deleted_at = date_trunc('milliseconds', deleted_at) as ms from documents where id = ${docId}`;
  expect(d!.ms).toBe(true);
}));

test("publishing a draft head by explicit version flips in place and never copies", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await publish(ctx, { docId, locale: "en", version: 1 });
  let rows = await sql`select version, state, is_head_draft, is_head_published from document_localized where doc_id = ${docId} order by version`;
  expect(rows.map(r => [r.version, r.state, r.is_head_draft, r.is_head_published])).toEqual([[1, "PUBLISHED", false, true]]);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "B" } });
  await publish(ctx, { docId, locale: "en", version: 2 });
  rows = await sql`select version, state, is_head_draft, is_head_published from document_localized where doc_id = ${docId} order by version`;
  expect(rows.map(r => [r.version, r.state, r.is_head_draft, r.is_head_published])).toEqual([
    [1, "PUBLISHED", false, false], [2, "PUBLISHED", false, true],
  ]);
}));

test("two concurrent republishes of the same earlier version: both succeed, versions stay unique, exactly one head", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "A" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "B" } });
  await publish(ctx, { docId, locale: "en" });
  const other = await extraConnection(sql);
  try {
    const ctx2 = ctxFor(other, "other");
    const results = await Promise.allSettled([
      publish(ctx, { docId, locale: "en", version: 1 }),
      publish(ctx2, { docId, locale: "en", version: 1 }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const rows = await sql`select version, data, is_head_published from document_localized where doc_id = ${docId} order by version`;
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect(rows.filter((r) => r.is_head_published).map((r) => r.version)).toEqual([4]); // the later copy supersedes the earlier one
    expect(rows[2]!.data).toEqual({ title: "A" });
    expect(rows[3]!.data).toEqual({ title: "A" });
  } finally { await other.end(); }
}));

// Required fields (plan 7, F3): enforced at publish, per scope, on top-level fields only.
const notesFields = (titleRequired: boolean) => ({
  slug: slug(),
  title: text({ localized: true, required: titleRequired }),
  code: text({ required: true }),
  subtitle: text({ localized: true }),
  body: richText({ localized: true, body: true }),
});
const notesConfig = (titleRequired: boolean) => defineConfig({
  collections: [defineCollection("notes", notesFields(titleRequired))],
  locales: { source: "en", chains: { de: ["en"] } },
});

async function setupNotes(sql: Sql, titleRequired = true) {
  await migrate(sql);
  const ctx = { ...ctxFor(sql, "publisher"), config: notesConfig(titleRequired) };
  const { id: docId } = await createDocument(ctx, { collection: "notes" });
  return { ctx, docId };
}

test("publish refuses a locale head without a required localized field, naming it", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setupNotes(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { body: md("x") } });
  await expect(publish(ctx, { docId, locale: "en" })).rejects.toThrow(
    `Cannot publish version 1 of ${docId}/en: missing required field title`,
  );
  await expect(publish(ctx, { docId, locale: "en" })).rejects.toBeInstanceOf(ValidationError);
  const rows = await sql`select is_head_published, is_head_draft, state from document_localized where doc_id = ${docId} and locale = 'en'`;
  expect(rows.map((r) => r.is_head_published)).toEqual([false]);
  expect(rows[0]).toMatchObject({ is_head_draft: true, state: "DRAFT_HUMAN" });
}));

test("publish refuses a shared head without a required shared field", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setupNotes(sql);
  await saveDraft(ctx, { docId, locale: "shared", data: { slug: "a" } });
  await expect(publish(ctx, { docId, locale: "shared" })).rejects.toThrow(
    `Cannot publish version 1 of ${docId}/shared: missing required field code`,
  );
  const rows = await sql`select is_head_published from document_shared where doc_id = ${docId}`;
  expect(rows.map((r) => r.is_head_published)).toEqual([false]);
}));

test("an empty value counts as present", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setupNotes(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "", body: md("") } });
  await publish(ctx, { docId, locale: "en" });
  const [row] = await sql`select is_head_published, data from document_localized where doc_id = ${docId} and locale = 'en'`;
  expect(row!.is_head_published).toBe(true);
  expect((row!.data as Record<string, unknown>).title).toBe("");
}));

test("a republish of a row that lacks a newly required field is refused", async () => withTestDb(async (sql) => {
  const { ctx: relaxed, docId } = await setupNotes(sql, false);
  await saveDraft(relaxed, { docId, locale: "en", data: { body: md("x") } });
  await publish(relaxed, { docId, locale: "en" });
  await saveDraft(relaxed, { docId, locale: "en", data: { title: "T", body: md("y") } });
  await publish(relaxed, { docId, locale: "en" });
  const strict = { ...relaxed, config: notesConfig(true) };
  await expect(publish(strict, { docId, locale: "en", version: 1 })).rejects.toThrow(
    `Cannot publish version 1 of ${docId}/en: missing required field title`,
  );
  const rows = await sql`select version, is_head_published from document_localized where doc_id = ${docId} order by version`;
  expect(rows.map((r) => [r.version, r.is_head_published])).toEqual([[1, false], [2, true]]);
}));

test("drafts may be incomplete", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setupNotes(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { body: md("x") } });
  await saveDraft(ctx, { docId, locale: "shared", data: { slug: "a" } });
  const rows = await sql`select is_head_draft from document_localized where doc_id = ${docId}`;
  expect(rows.map((r) => r.is_head_draft)).toEqual([true]);
}));

test("a required field named like an Object.prototype member is enforced", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const config = defineConfig({
    collections: [defineCollection("notes", {
      slug: slug(),
      valueOf: text({ localized: true, required: true }),
      body: richText({ localized: true, body: true }),
    })],
    locales: { source: "en", chains: { de: ["en"] } },
  });
  const ctx = { ...ctxFor(sql, "publisher"), config };
  const { id: docId } = await createDocument(ctx, { collection: "notes" });
  await saveDraft(ctx, { docId, locale: "en", data: { body: md("x") } });
  await expect(publish(ctx, { docId, locale: "en" })).rejects.toThrow(
    `Cannot publish version 1 of ${docId}/en: missing required field valueOf`,
  );
}));
