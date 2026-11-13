import { expect, test } from "vitest";
import type { Sql } from "postgres";
import {
  NotFoundError, ValidationError, approve, createDocument, getDocument, getDraftReview, hashValue, listDraftHeads,
  migrate, publish, recordAiDraft, rejectDraft, saveDraft,
} from "../src/index.js";
import type { Ctx } from "../src/index.js";
import { ctxFor } from "./fixtures.js";
import { withTestDb } from "./db.js";

const W = 'glossary: "cat" expected "gata"';

const prov = (fieldPath: string, warnings: string[] = []) => ({
  fieldPath, modelId: "m1", promptVersion: "p1", promptTokens: 10, completionTokens: 20, costMicros: 300, warnings,
});

async function enDoc(ctx: Ctx, slug?: string): Promise<string> {
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  if (slug !== undefined) await saveDraft(ctx, { docId, locale: "shared", data: { slug } });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  return docId;
}

const HASHES = { title: hashValue("Hello"), body: hashValue("World") };

const aiDraft = (
  ctx: Ctx, docId: string, locale: string, fields: Record<string, unknown>, warned: Record<string, string[]> = {},
  sourceVersion = 1, sourceHashes: Record<string, string> = HASHES,
) => recordAiDraft(ctx, {
  docId, locale, fields, sourceVersion, sourceHashes,
  provenance: Object.keys(fields).map((k) => prov(k, warned[k] ?? [])),
});

test("listDraftHeads returns draft heads with collection, slug, locale, version and warningCount", async () => withTestDb(async (sql: Sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "lister");
  const a = await enDoc(ctx, "alpha");
  await aiDraft(ctx, a, "de", { title: "Hallo", body: "Welt" }, { title: [W, "tone"], body: [W] });
  await aiDraft(ctx, a, "de-CH", { title: "Gruezi" });
  const b = await enDoc(ctx);
  await saveDraft(ctx, { docId: b, locale: "de", data: { title: "Von Hand" } });
  // A deleted document's heads are not listed.
  const gone = await enDoc(ctx);
  await aiDraft(ctx, gone, "de", { title: "Weg" });
  await sql`update documents set deleted_at = now(), deleted_by = 'x' where id = ${gone}`;

  const all = await listDraftHeads(ctx);
  expect(all.next).toBeNull();
  const key = (i: { docId: string; locale: string }) => `${i.docId}:${i.locale}`;
  expect(all.items.map(key)).toEqual([`${a}:de`, `${a}:de-CH`, `${a}:shared`, `${b}:de`].sort((x, y) => {
    const [xd, xl] = x.split(":") as [string, string];
    const [yd, yl] = y.split(":") as [string, string];
    return xd === yd ? (xl < yl ? -1 : 1) : (xd < yd ? -1 : 1);
  }));
  const byKey = new Map(all.items.map((i) => [key(i), i]));
  expect(byKey.get(`${a}:de`)).toMatchObject({
    collection: "posts", slug: "alpha", version: 1, state: "DRAFT_AI", createdBy: "lister", warningCount: 2,
  });
  expect(byKey.get(`${a}:de`)!.createdAt).toBeInstanceOf(Date);
  expect(byKey.get(`${a}:de-CH`)).toMatchObject({ state: "DRAFT_AI", warningCount: 0, slug: "alpha" });
  expect(byKey.get(`${a}:shared`)).toMatchObject({ state: "DRAFT_HUMAN", version: 1, warningCount: 0, slug: "alpha" });
  expect(byKey.get(`${b}:de`)).toMatchObject({ state: "DRAFT_HUMAN", warningCount: 0, slug: null });

  expect((await listDraftHeads(ctx, { state: "DRAFT_AI" })).items).toHaveLength(2);
  expect((await listDraftHeads(ctx, { state: "DRAFT_HUMAN" })).items).toHaveLength(2);
  expect((await listDraftHeads(ctx, { state: "APPROVED" })).items).toHaveLength(0);
  expect((await listDraftHeads(ctx, { collection: "posts" })).items).toHaveLength(4);
  expect((await listDraftHeads(ctx, { locale: "DE" })).items.map(key).sort()).toEqual([`${a}:de`, `${b}:de`].sort());
  expect((await listDraftHeads(ctx, { locale: "shared" })).items.map(key)).toEqual([`${a}:shared`]);

  const seen: string[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const page = await listDraftHeads(ctx, after === undefined ? { limit: 1 } : { limit: 1, after });
    expect(page.items.length).toBeLessThanOrEqual(1);
    seen.push(...page.items.map(key));
    if (page.next === null) break;
    expect(page.next).toBe(key(page.items[0]!));
    after = page.next;
  }
  expect(seen).toEqual(all.items.map(key));
}));

test("listDraftHeads reports an APPROVED head with warningCount 0 and validates its input", async () => withTestDb(async (sql: Sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "lister");
  const a = await enDoc(ctx);
  await aiDraft(ctx, a, "de", { title: "Hallo" }, { title: [W] });
  await approve(ctx, { docId: a, locale: "de", acknowledgedWarnings: [W] });
  const approved = await listDraftHeads(ctx, { state: "APPROVED" });
  expect(approved.items).toMatchObject([{ docId: a, locale: "de", version: 2, state: "APPROVED", warningCount: 0 }]);
  await expect(listDraftHeads(ctx, { limit: 0 })).rejects.toThrow(ValidationError);
  await expect(listDraftHeads(ctx, { limit: 201 })).rejects.toThrow(ValidationError);
  await expect(listDraftHeads(ctx, { collection: "nope" })).rejects.toThrow(ValidationError);
  await expect(listDraftHeads(ctx, { after: "garbage" })).rejects.toThrow(ValidationError);
  await expect(listDraftHeads(ctx, { state: "PUBLISHED" as never })).rejects.toThrow(ValidationError);
}));

test("getDraftReview pairs draft, previous and source per field", async () => withTestDb(async (sql: Sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "reviewer");
  const docId = await enDoc(ctx, "alpha");
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Alt" } });
  await publish(ctx, { docId, locale: "de" });
  await aiDraft(ctx, docId, "de", { title: "Neu", body: "Welt" }, { title: [W] });

  const review = await getDraftReview(ctx, { docId, locale: "de" });
  expect(review).toMatchObject({
    docId, collection: "posts", slug: "alpha", locale: "de", version: 2, state: "DRAFT_AI", sourceLocale: "en",
    sourceVersion: 1, supersededVersion: null,
  });
  expect(review.fields.map((f) => f.path)).toEqual(["body", "title"]);
  const title = review.fields.find((f) => f.path === "title")!;
  expect(title).toEqual({
    path: "title", source: "Hello", previous: "Alt", previousFrom: "published", draft: "Neu", warnings: [W],
    edited: false, sourceChanged: false,
  });
  const body = review.fields.find((f) => f.path === "body")!;
  expect(body.source).toBe("World");
  expect(body.draft).toBe("Welt");
  expect(body.previous).toBeUndefined();
  expect(body.previousFrom).toBeNull();
  expect(body.warnings).toEqual([]);
  expect(Object.keys(JSON.parse(JSON.stringify(body)) as object)).not.toContain("previous");
}));

test("getDraftReview reports the superseded AI draft as previous", async () => withTestDb(async (sql: Sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "reviewer");
  const docId = await enDoc(ctx);
  await aiDraft(ctx, docId, "de", { title: "Erste", body: "Welt" });
  await aiDraft(ctx, docId, "de", { title: "Zweite" });
  const review = await getDraftReview(ctx, { docId, locale: "de" });
  expect(review).toMatchObject({ version: 2, supersededVersion: 1, slug: null });
  const title = review.fields.find((f) => f.path === "title")!;
  expect(title).toMatchObject({ draft: "Zweite", previous: "Erste", previousFrom: "superseded" });
  // The carried-over body is the same text as the superseded draft's.
  expect(review.fields.find((f) => f.path === "body")).toMatchObject({ draft: "Welt", previous: "Welt", previousFrom: "superseded" });
}));

test("getDraftReview marks edited fields after approve and sourceChanged after the source moves", async () => withTestDb(async (sql: Sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "reviewer");
  const docId = await enDoc(ctx);
  await aiDraft(ctx, docId, "de", { title: "Hallo", body: "Welt" });
  const fresh = await getDraftReview(ctx, { docId, locale: "de" });
  expect(fresh.fields.map((f) => [f.path, f.edited, f.sourceChanged])).toEqual([["body", false, false], ["title", false, false]]);

  await approve(ctx, { docId, locale: "de", edits: { title: "Servus" } });
  const approved = await getDraftReview(ctx, { docId, locale: "de" });
  expect(approved).toMatchObject({ version: 2, state: "APPROVED" });
  expect(approved.fields.map((f) => [f.path, f.draft, f.edited, f.sourceChanged])).toEqual([
    ["body", "Welt", false, false], ["title", "Servus", true, false],
  ]);

  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello 2", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  const moved = await getDraftReview(ctx, { docId, locale: "de" });
  expect(moved.sourceVersion).toBe(2);
  expect(moved.fields.map((f) => [f.path, f.source, f.sourceChanged])).toEqual([
    ["body", "World", false], ["title", "Hello 2", true],
  ]);
}));

test("getDraftReview throws NotFoundError with no draft head, an unknown document or after a reject", async () => withTestDb(async (sql: Sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "reviewer");
  const docId = await enDoc(ctx);
  await expect(getDraftReview(ctx, { docId, locale: "de" })).rejects.toThrow(NotFoundError);
  await aiDraft(ctx, docId, "de", { title: "Hallo" });
  await rejectDraft(ctx, { docId, locale: "de" });
  await expect(getDraftReview(ctx, { docId, locale: "de" })).rejects.toThrow(NotFoundError);
  await expect(getDraftReview(ctx, { docId: "00000000-0000-4000-8000-000000000000", locale: "de" })).rejects.toThrow(NotFoundError);
  await expect(getDraftReview(ctx, { docId: "nope", locale: "de" })).rejects.toThrow(NotFoundError);
  await expect(getDraftReview(ctx, { docId, locale: "shared" })).rejects.toThrow(ValidationError);
  await expect(getDraftReview(ctx, { docId, locale: "fr" })).rejects.toThrow(ValidationError);
  expect((await getDocument(ctx, { collection: "posts", docId }))!.locales.de?.draft ?? null).toBeNull();
}));
