import { expect, test } from "vitest";
import {
  NotFoundError, ValidationError, createDocument, listLocaleRows, listPublishedVersions, migrate, publish, rejectDraft,
  saveDraft, unpublish,
} from "../src/index.js";
import { ctxFor, insertAiDraftLocalized, insertPublishedLocalized } from "./fixtures.js";
import { withTestDb } from "./db.js";

test("listLocaleRows sees rows without a head and omits a locale with no row", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await insertAiDraftLocalized(sql, id, "de", 1, { title: "Titel" });
  await rejectDraft(ctx, { docId: id, locale: "de" });
  await saveDraft(ctx, { docId: id, locale: "de-CH", data: { title: "Titel CH" } });
  await publish(ctx, { docId: id, locale: "de-CH" });
  await unpublish(ctx, { docId: id, locale: "de-CH" });
  const heads = await sql`select count(*)::int as n from document_localized where doc_id = ${id} and (is_head_published or is_head_draft)`;
  expect(heads[0]!.n).toBe(0); // both pairs really are head-less
  expect(await listLocaleRows(ctx, { collection: "posts", docIds: [id] })).toEqual([
    { docId: id, locale: "de" }, { docId: id, locale: "de-CH" },
  ]);
}));

test("listLocaleRows: unknown, malformed and foreign ids contribute nothing; more than 1000 ids is refused", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "T" } });
  const unknown = "00000000-0000-4000-8000-000000000000";
  expect(await listLocaleRows(ctx, { collection: "posts", docIds: ["nope", unknown, id, id] })).toEqual([{ docId: id, locale: "en" }]);
  expect(await listLocaleRows(ctx, { collection: "posts", docIds: [] })).toEqual([]);
  await expect(listLocaleRows(ctx, { collection: "posts", docIds: Array(1001).fill(id) })).rejects.toBeInstanceOf(ValidationError);
  await expect(listLocaleRows(ctx, { collection: "nope", docIds: [id] })).rejects.toBeInstanceOf(NotFoundError);
}));

test("listPublishedVersions returns every published version newest first", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "de", data: { title: "eins" } });
  await publish(ctx, { docId: id, locale: "de" });
  await saveDraft(ctx, { docId: id, locale: "de", data: { title: "zwei" } });
  await publish(ctx, { docId: id, locale: "de" });
  await unpublish(ctx, { docId: id, locale: "de" });
  await publish(ctx, { docId: id, locale: "de", version: 1 }); // republish: a copy as version 3
  await saveDraft(ctx, { docId: id, locale: "de", data: { title: "vier (draft)" } }); // a draft head is not listed
  expect(await listPublishedVersions(ctx, { collection: "posts", locale: "de", docIds: [id] })).toEqual([
    { docId: id, version: 3, data: { title: "eins" } },
    { docId: id, version: 2, data: { title: "zwei" } },
    { docId: id, version: 1, data: { title: "eins" } },
  ]);
}));

test("listPublishedVersions orders by docId, takes the locale case-normalized, and omits draft-only and other-locale rows", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const a = (await createDocument(ctx, { collection: "posts" })).id;
  const b = (await createDocument(ctx, { collection: "posts" })).id;
  const draftOnly = (await createDocument(ctx, { collection: "posts" })).id;
  for (const id of [a, b]) {
    await insertPublishedLocalized(sql, id, "de-CH", 1, { title: `${id} v1` });
    await sql`update document_localized set is_head_published = false where doc_id = ${id} and locale = 'de-CH' and version = 1`;
    await insertPublishedLocalized(sql, id, "de-CH", 2, { title: `${id} v2` });
    await insertPublishedLocalized(sql, id, "de", 1, { title: "other locale" });
  }
  await saveDraft(ctx, { docId: draftOnly, locale: "de-CH", data: { title: "draft" } });
  const rows = await listPublishedVersions(ctx, { collection: "posts", locale: "de-ch", docIds: [draftOnly, b, a] });
  const [first, second] = [a, b].sort();
  expect(rows.map((r) => [r.docId, r.version])).toEqual([[first, 2], [first, 1], [second, 2], [second, 1]]);
  expect(await listPublishedVersions(ctx, { collection: "posts", locale: "en", docIds: [a, b] })).toEqual([]);
}));

test("listPublishedVersions refuses shared, undeclared and malformed locales, a foreign collection and over 1000 ids", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  for (const locale of ["shared", "fr", "not a locale"]) {
    await expect(listPublishedVersions(ctx, { collection: "posts", locale, docIds: [id] }), locale).rejects.toBeInstanceOf(ValidationError);
  }
  await expect(listPublishedVersions(ctx, { collection: "posts", locale: "de", docIds: Array(1001).fill(id) })).rejects.toBeInstanceOf(ValidationError);
  await expect(listPublishedVersions(ctx, { collection: "nope", locale: "de", docIds: [id] })).rejects.toBeInstanceOf(NotFoundError);
}));
