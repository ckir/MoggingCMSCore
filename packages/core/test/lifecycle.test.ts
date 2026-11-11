import { expect, test } from "vitest";
import {
  approve, createDocument, deleteDocument, getDocument, getSyncState, migrate, publish, recordAiDraft, resolve,
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
