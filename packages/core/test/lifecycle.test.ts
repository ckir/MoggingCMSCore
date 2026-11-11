import { expect, test } from "vitest";
import {
  addToRelease, approve, createDocument, createRelease, deleteDocument, getDocument, getSyncState, migrate, publish, recordAiDraft, resolve,
  saveDraft, unpublish,
} from "../src/index.js";
import { ctxFor } from "./fixtures.js";
import { withTestDb } from "./db.js";

const stateOf = (rows: Awaited<ReturnType<typeof getSyncState>>) =>
  Object.fromEntries(rows.map((r) => [`${r.locale}.${r.field}`, r.state]));

test("lifecycle: translate, source moves, re-translate by AI, approve, publish, resolve", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "editor");
  const { id: docId } = await createDocument(ctx, { collection: "posts" });

  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Hallo", body: "Welt" } });
  await publish(ctx, { docId, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "current" });

  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "New world" } });
  await publish(ctx, { docId, locale: "en" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });

  // The AI translates against the current source version, with the hashes read back from the database.
  const en = (await getDocument(ctx, { collection: "posts", docId }))!.locales.en!.published!;
  expect(en.version).toBe(2);
  const result = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { body: "Neue Welt" }, sourceVersion: en.version,
    sourceHashes: { body: en.sourceHashes.body! },
    provenance: [{ fieldPath: "body", modelId: "m", promptVersion: "1", promptTokens: 1, completionTokens: 1, costMicros: 1 }],
  });
  expect(result).toEqual({ version: 2 });
  await approve(ctx, { docId, locale: "de" });
  await publish(ctx, { docId, locale: "de" });

  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "current" });
  const [doc] = await resolve(ctx, { collection: "posts", locale: "de" });
  expect(doc).toMatchObject({ id: docId, data: { title: "Hallo", body: "Neue Welt" }, fellBack: {} });
  expect(doc!.missing).not.toContain("title");
  expect(doc!.missing).not.toContain("body");
}));

test("lifecycle: deleteDocument hides the document from resolve, asOf before the deletion still sees it", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "editor");
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  await new Promise((r) => setTimeout(r, 25));
  await deleteDocument(ctx, { docId });
  const [{ deleted_at: deletedAt }] = (await sql`select deleted_at from documents where id = ${docId}`) as unknown as [{ deleted_at: Date }];

  expect(await resolve(ctx, { collection: "posts", locale: "en" })).toEqual([]);
  const before = await resolve(ctx, { collection: "posts", locale: "en", asOf: new Date(deletedAt.getTime() - 1) });
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ id: docId, data: { title: "Hello", body: "World" }, fellBack: {} });
  expect(await resolve(ctx, { collection: "posts", locale: "en", asOf: deletedAt })).toEqual([]);
  expect(await resolve(ctx, { collection: "posts", locale: "en", asOf: new Date(deletedAt.getTime() + 1000) })).toEqual([]);
}));

async function staleBodyDoc(ctx: ReturnType<typeof ctxFor>) {
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Halo", body: "Welt" } });
  await publish(ctx, { docId, locale: "de" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "New world" } });
  await publish(ctx, { docId, locale: "en" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });
  return docId;
}

test("regression pin: a typo fix that resubmits the unchanged body keeps it stale (published base)", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "editor");
  const docId = await staleBodyDoc(ctx);
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Hallo", body: "Welt" } });
  await publish(ctx, { docId, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });
}));

test("regression pin: unpublish, typo fix, re-save and publish keeps the unchanged body stale", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "editor");
  const docId = await staleBodyDoc(ctx);
  await unpublish(ctx, { docId, locale: "de" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Hallo", body: "Welt" } });
  await publish(ctx, { docId, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });
}));

test("regression pin: AI re-translation after unpublish keeps the sibling field and ends current", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "editor");
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Hallo", body: "Welt" } });
  await publish(ctx, { docId, locale: "de" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "New world" } });
  await publish(ctx, { docId, locale: "en" });
  await unpublish(ctx, { docId, locale: "de" });
  const en = (await getDocument(ctx, { collection: "posts", docId }))!.locales.en!.published!;
  const r = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { body: "Neue Welt" }, sourceVersion: en.version, sourceHashes: { body: en.sourceHashes.body! },
    provenance: [{ fieldPath: "body", modelId: "m", promptVersion: "1", promptTokens: 1, completionTokens: 1, costMicros: 1 }],
  });
  expect(r).toEqual({ version: 2 });
  await approve(ctx, { docId, locale: "de" });
  await publish(ctx, { docId, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "current" });
  const [doc] = await resolve(ctx, { collection: "posts", locale: "de" });
  expect(doc).toMatchObject({ data: { title: "Hallo", body: "Neue Welt" }, fellBack: {} });
}));

test("every lifecycle write records its actor (spec 8.7)", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const maker = ctxFor(sql, "maker");
  const pub = ctxFor(sql, "publisher");
  const un = ctxFor(sql, "unpublisher");
  const del = ctxFor(sql, "deleter");
  const rel = ctxFor(sql, "releaser");
  const { id: docId } = await createDocument(maker, { collection: "posts" });
  await saveDraft(maker, { docId, locale: "shared", data: { slug: "a" } });
  await publish(pub, { docId, locale: "shared" });
  await saveDraft(maker, { docId, locale: "shared", data: { slug: "b" } });
  await publish(ctxFor(sql, "second"), { docId, locale: "shared" }); // supersedes v1: the superseding actor is recorded
  await saveDraft(maker, { docId, locale: "en", data: { title: "T", body: "B" } });
  await publish(pub, { docId, locale: "en" });
  await unpublish(un, { docId, locale: "en" });
  await saveDraft(maker, { docId, locale: "shared", data: { slug: "c" } });
  const { id: rid } = await createRelease(rel, { name: "r" });
  await addToRelease(rel, { releaseId: rid, docId, locale: "shared", version: 3 });
  await deleteDocument(del, { docId });

  const [d] = await sql`select created_by, deleted_by from documents where id = ${docId}`;
  expect(d).toMatchObject({ created_by: "maker", deleted_by: "deleter" });
  const sh = await sql`select version, unpublished_by from document_shared where doc_id = ${docId} order by version`;
  expect(sh.map((r) => [r.version, r.unpublished_by])).toEqual([[1, "second"], [2, null], [3, null]]);
  const [loc] = await sql`select unpublished_by from document_localized where doc_id = ${docId} and locale = 'en'`;
  expect(loc!.unpublished_by).toBe("unpublisher");
  const [item] = await sql`select added_by, added_at from release_items where release_id = ${rid}`;
  expect(item!.added_by).toBe("releaser");
  expect(item!.added_at).toBeInstanceOf(Date);
}));

test("content_provenance has a partial index on bulk_id", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const rows = await sql`select indexdef from pg_indexes where schemaname = current_schema() and indexname = 'idx_provenance_bulk'`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.indexdef).toMatch(/\(bulk_id\) WHERE \(bulk_id IS NOT NULL\)/);
}));
