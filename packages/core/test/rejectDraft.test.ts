import { afterAll, beforeAll, expect, test } from "vitest";
import type { Sql } from "postgres";
import {
  ConflictError, LicenceError, NotFoundError, NotPublishableError, ValidationError, approve, assertLicensed,
  createDocument, getDocument, getSyncState, hashValue, migrate, publish, recordAiDraft, rejectDraft, saveDraft, unpublish,
} from "../src/index.js";
import { ctxFor } from "./fixtures.js";
import { withTestDb } from "./db.js";

const DAY = 24 * 60 * 60 * 1000;

// Keep the suite hermetic against a developer shell that exports a key.
let savedEnv: string | undefined;
beforeAll(() => { savedEnv = process.env.MOGGING_LICENSE_KEY; delete process.env.MOGGING_LICENSE_KEY; });
afterAll(() => { if (savedEnv !== undefined) process.env.MOGGING_LICENSE_KEY = savedEnv; });

const prov = (fieldPath: string) => ({
  fieldPath, modelId: "m1", promptVersion: "p1", promptTokens: 10, completionTokens: 20, costMicros: 300,
});

/** A document whose source locale (en) has a published v1, plus a DRAFT_AI de v1 recorded by the pipeline. */
async function setup(sql: Sql) {
  await migrate(sql);
  const ctx = ctxFor(sql, "reviewer");
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  const hashes = { title: hashValue("Hello"), body: hashValue("World") };
  const draft = (fields: Record<string, unknown> = { title: "Hallo", body: "Welt" }) => recordAiDraft(ctx, {
    docId, locale: "de", fields, sourceVersion: 1, sourceHashes: hashes, provenance: Object.keys(fields).map(prov),
  });
  await draft();
  return { ctx, docId, hashes, draft };
}

const rows = (sql: Sql, docId: string) =>
  sql`select version, state, is_head_draft from document_localized where doc_id = ${docId} and locale = 'de' order by version`;

test("rejectDraft clears the DRAFT_AI head, keeps the row in history and records a human:reject marker", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  const r = await rejectDraft(ctx, { docId, locale: "de", reason: "bad tone" });
  expect(r).toEqual({ version: 1 });
  expect(await rows(sql, docId)).toMatchObject([{ version: 1, state: "DRAFT_AI", is_head_draft: false }]);
  const marker = await sql`select * from content_provenance where model_id = 'human:reject'`;
  expect(marker).toHaveLength(1);
  expect(marker[0]).toMatchObject({
    doc_id: docId, locale: "de", version: 1, field_path: null, approved_by: "reviewer", discard_reason: "bad tone",
    prompt_version: "", prompt_tokens: 0, completion_tokens: 0, cost_micros: "0",
  });
  expect(marker[0]!.approved_at).toBeInstanceOf(Date);
  const doc = await getDocument(ctx, { collection: "posts", docId });
  expect(doc!.locales.de?.draft ?? null).toBeNull();
}));

test("rejectDraft without a reason stores a null discard_reason", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await rejectDraft(ctx, { docId, locale: "DE" });
  const [m] = await sql`select discard_reason from content_provenance where model_id = 'human:reject'`;
  expect(m!.discard_reason).toBeNull();
}));

test("rejectDraft refuses an APPROVED head, a DRAFT_HUMAN head and a missing head with NotPublishableError", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await approve(ctx, { docId, locale: "de" });
  await expect(rejectDraft(ctx, { docId, locale: "de" })).rejects.toThrow(NotPublishableError);
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Von Hand" } });
  await expect(rejectDraft(ctx, { docId, locale: "de" })).rejects.toThrow(NotPublishableError);
  await expect(rejectDraft(ctx, { docId, locale: "de-CH" })).rejects.toThrow(NotPublishableError);
  const [{ n }] = await sql`select count(*)::int as n from content_provenance where model_id = 'human:reject'`;
  expect(n).toBe(0);
}));

test("rejectDraft refuses the source locale and \"shared\" with ValidationError, an unknown document with NotFoundError", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await expect(rejectDraft(ctx, { docId, locale: "en" })).rejects.toThrow(ValidationError);
  await expect(rejectDraft(ctx, { docId, locale: "shared" })).rejects.toThrow(ValidationError);
  await expect(rejectDraft(ctx, { docId, locale: "fr" })).rejects.toThrow(ValidationError);
  await expect(rejectDraft(ctx, { docId: "00000000-0000-4000-8000-000000000000", locale: "de" })).rejects.toThrow(NotFoundError);
  await expect(rejectDraft(ctx, { docId: "nope", locale: "de" })).rejects.toThrow(NotFoundError);
}));

test("the pair is stale again after a reject, so enqueue-level state is unchanged", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await rejectDraft(ctx, { docId, locale: "de" });
  const state = await getSyncState(ctx, { docId, locale: "de" });
  expect(state.find((s) => s.field === "title")!.state).toBe("missing");
}));

test("rejectDraft expectedVersion: the current version succeeds, a stale one throws ConflictError and writes nothing", async () => withTestDb(async (sql) => {
  const { ctx, docId, draft } = await setup(sql);
  await draft({ title: "Hallo 2" }); // v2 replaces v1
  await expect(rejectDraft(ctx, { docId, locale: "de", expectedVersion: 1 })).rejects.toThrow(ConflictError);
  expect(await rows(sql, docId)).toMatchObject([
    { version: 1, is_head_draft: false }, { version: 2, state: "DRAFT_AI", is_head_draft: true },
  ]);
  const [{ n }] = await sql`select count(*)::int as n from content_provenance where model_id = 'human:reject'`;
  expect(n).toBe(0);
  expect(await rejectDraft(ctx, { docId, locale: "de", expectedVersion: 2 })).toEqual({ version: 2 });
}));

test("rejectDraft is not licence-guarded", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await sql`update migrations set applied_at = ${new Date(Date.now() - 31 * DAY)}`;
  await expect(assertLicensed(ctx)).rejects.toThrow(LicenceError);
  expect(await rejectDraft(ctx, { docId, locale: "de" })).toEqual({ version: 1 });
}));

test("a recordAiDraft after a reject stores the next version as the new draft head and keeps the rejected row in history", async () => withTestDb(async (sql) => {
  const { ctx, docId, draft } = await setup(sql);
  await rejectDraft(ctx, { docId, locale: "de" });
  const next = await draft({ title: "Hallo neu", body: "Welt neu" });
  expect(next).toMatchObject({ version: 2 });
  expect(await rows(sql, docId)).toMatchObject([
    { version: 1, state: "DRAFT_AI", is_head_draft: false },
    { version: 2, state: "DRAFT_AI", is_head_draft: true },
  ]);
  const doc = await getDocument(ctx, { collection: "posts", docId });
  expect(doc!.locales.de?.draft?.version).toBe(2);
  expect(doc!.locales.de?.draft?.data).toEqual({ title: "Hallo neu", body: "Welt neu" });
}));

const headData = async (sql: Sql, docId: string) => {
  const [h] = await sql`select data, field_warnings from document_localized where doc_id = ${docId} and locale = 'de' and is_head_draft`;
  return h!;
};

test("redraft after reject carries no rejected text", async () => withTestDb(async (sql) => {
  const { ctx, docId, draft } = await setup(sql);
  await rejectDraft(ctx, { docId, locale: "de" });
  await draft({ title: "Neu" });
  const head = await headData(sql, docId);
  expect(head.data).toEqual({ title: "Neu" });
  expect(head.field_warnings).toEqual({});
}));

test("redraft after reject restarts from the approved predecessor", async () => withTestDb(async (sql) => {
  const { ctx, docId, draft } = await setup(sql);
  await approve(ctx, { docId, locale: "de" }); // v2 APPROVED
  await draft({ title: "AI" }); // v3 supersedes v2
  await rejectDraft(ctx, { docId, locale: "de" }); // rejects v3
  expect(await draft({ body: "B2" })).toEqual({ version: 4 });
  expect((await headData(sql, docId)).data).toEqual({ title: "Hallo", body: "B2" });
  const p = await sql`select superseded_version from content_provenance
    where doc_id = ${docId} and locale = 'de' and version = 4`;
  expect(p).toHaveLength(1);
  expect(p[0]!.superseded_version).toBeNull();
}));

test("redraft after unpublish still starts from the published row", async () => withTestDb(async (sql) => {
  const { ctx, docId, draft } = await setup(sql);
  await approve(ctx, { docId, locale: "de" });
  await publish(ctx, { docId, locale: "de" });
  await unpublish(ctx, { docId, locale: "de" });
  await draft({ title: "X" });
  expect((await headData(sql, docId)).data).toEqual({ title: "X", body: "Welt" });
}));
