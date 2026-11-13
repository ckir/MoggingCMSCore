import { expect, test } from "vitest";
import {
  ConflictError, NotFoundError, ValidationError, createDocument, deleteDocument, getSyncState, hashValue, migrate, publish,
  recordAiDraft, saveDraft, trackFields, unpublish,
} from "../src/index.js";
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

test("a U+0000 in a value is a ValidationError and writes no row", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await expect(saveDraft(ctx, { docId, locale: "en", data: { title: "a\u0000b" } })).rejects.toThrow(ValidationError);
  const [{ n }] = await sql`select count(*)::int as n from document_localized where doc_id = ${docId}`;
  expect(n).toBe(0);
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

// ---- Re-saving a target snapshot must not assert sync on unchanged fields (spec 6.4, ruling R13) ----

const stateOf = (rows: Awaited<ReturnType<typeof getSyncState>>) =>
  Object.fromEntries(rows.map((r) => [`${r.locale}.${r.field}`, r.state]));

const hashesOf = async (sql: Sql, docId: string, locale: string, version: number) => {
  const [row] = await sql`select source_hashes from document_localized where doc_id = ${docId} and locale = ${locale} and version = ${version}`;
  return row!.source_hashes as Record<string, string>;
};

test("re-saving an unchanged stale field does not make it current (typo fix keeps body stale)", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "T de typo", body: "B de" } });
  await publish(ctx, { docId, locale: "de" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B2" } });
  await publish(ctx, { docId, locale: "en" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });
  // The editor fixes only the title typo and resubmits the whole snapshot, body unchanged.
  await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", body: "B de" } });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });
  await publish(ctx, { docId, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });
}));

test("changed field gets the current source hash, unchanged keeps the old one, new field gets the current one", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B", legal: "L" } });
  await publish(ctx, { docId, locale: "en" });
  const { version: v1 } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", body: "B de" } });
  expect(await hashesOf(sql, docId, "de", v1)).toEqual({ title: hashValue("T"), body: hashValue("B") });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T2", body: "B2", legal: "L" } });
  await publish(ctx, { docId, locale: "en" });
  const { version: v2 } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T2 de", body: "B de", legal: "L de" } });
  expect(await hashesOf(sql, docId, "de", v2)).toEqual({
    title: hashValue("T2"), // changed: current source hash
    body: hashValue("B"), // unchanged: base hash carried forward (not hashValue("B2"))
    legal: hashValue("L"), // new: current source hash
  });
}));

test("an unchanged field with no stored hash stays untracked", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  // de has legal, but the source has no published legal value at save time: no hash recorded.
  await insertPublishedLocalized(sql, docId, "en", 1, { title: "T" }, { title: hashValue("T") });
  const { version: v1 } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", legal: "Recht" } });
  expect(await hashesOf(sql, docId, "de", v1)).toEqual({ title: hashValue("T") });
  // The source gains a legal value, then de is re-saved with legal unchanged.
  await sql`update document_localized set data = ${sql.json({ title: "T", legal: "L" })},
    source_hashes = ${sql.json({ title: hashValue("T"), legal: hashValue("L") })} where doc_id = ${docId} and locale = 'en'`;
  const { version: v2 } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T de 2", legal: "Recht" } });
  expect(await hashesOf(sql, docId, "de", v2)).toEqual({ title: hashValue("T") });
  await publish(ctx, { docId, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))["de.legal"]).toBe("untracked");
}));

test("a first save of a locale (no base head) stamps every field from the source", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B" } });
  await publish(ctx, { docId, locale: "en" });
  const { version } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", body: "B de" } });
  expect(await hashesOf(sql, docId, "de", version)).toEqual({ title: hashValue("T"), body: hashValue("B") });
}));

test("the base is the draft head when both a draft head and a published head exist", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", body: "B de" } });
  await publish(ctx, { docId, locale: "de" }); // published de: title->hash(T), body->hash(B)
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B2" } });
  await publish(ctx, { docId, locale: "en" });
  // Draft head: body changed (stamped with hash(B2)), title unchanged (carries hash(T)).
  await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", body: "B de 2" } });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B3" } });
  await publish(ctx, { docId, locale: "en" });
  // Next save: body unchanged vs the DRAFT head (it differs from the published head) -> keeps the draft's
  // hash(B2); judged against the published head it would be a change and read hash(B3).
  const { version } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", body: "B de 2" } });
  expect(await hashesOf(sql, docId, "de", version)).toEqual({ title: hashValue("T"), body: hashValue("B2") });
}));

test("trackFields on an unchanged field is the explicit assertion: it reads current afterwards", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", body: "B de" } });
  await publish(ctx, { docId, locale: "de" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B2" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", body: "B de" } });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))["de.body"]).toBe("stale");
  await publish(ctx, { docId, locale: "de" });
  await trackFields(ctx, { docId, locale: "de", fields: ["body"] });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "current" });
}));

test("after unpublish (no draft head, no published head) a re-save still carries unchanged hashes forward", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World" } });
  await publish(ctx, { docId, locale: "en" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Halo", body: "Welt" } });
  await publish(ctx, { docId, locale: "de" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "New world" } });
  await publish(ctx, { docId, locale: "en" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });
  await unpublish(ctx, { docId, locale: "de" });
  await saveDraft(ctx, { docId, locale: "de", data: { title: "Hallo", body: "Welt" } });
  await publish(ctx, { docId, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });
}));

test("a human save after an AI draft carries the AI hash for an unchanged field", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B" } });
  await publish(ctx, { docId, locale: "en" });
  const ai = await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "T ai", body: "B ai" }, sourceVersion: 1,
    sourceHashes: { title: hashValue("T"), body: hashValue("B") },
    provenance: [{ fieldPath: "body", modelId: "m", promptVersion: "1", promptTokens: 1, completionTokens: 1, costMicros: 1 }],
  });
  expect(ai).toEqual({ version: 1 });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B2" } });
  await publish(ctx, { docId, locale: "en" });
  const { version } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T human", body: "B ai" } });
  expect(await hashesOf(sql, docId, "de", version)).toEqual({ title: hashValue("T"), body: hashValue("B") });
  await publish(ctx, { docId, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "stale" });
}));

test("target re-save compares canonical forms over awkward stored values: unchanged carries, changed re-stamps", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B", price: 1 } });
  await publish(ctx, { docId, locale: "en" });
  // Raw values the caller resubmits verbatim: 1e-7, -0, 0.1+0.2, decomposed accent in a value and in an object
  // key, list with null elements, nested null keys.
  const raw = () => ({
    "cafe\u0301": "Cafe\u0301", tiny: 1e-7, negZero: -0, sum: 0.1 + 0.2,
    list: [null, "x", null, { deep: null, k: [null] }], nest: { a: { b: null } },
  });
  const { version: v1 } = await saveDraft(ctx, { docId, locale: "de", data: { title: "t", body: raw(), price: 0.1 + 0.2 } });
  const first = await hashesOf(sql, docId, "de", v1);
  expect(first).toEqual({ title: hashValue("T"), body: hashValue("B"), price: hashValue(1) });
  const [stored] = await sql`select data from document_localized where doc_id = ${docId} and locale = 'de' and version = ${v1}`;
  expect(Object.keys((stored!.data as { body: object }).body)).toContain("caf\u00e9");
  // The source moves on; any spurious re-stamp would now read the new source hashes.
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T2", body: "B2", price: 2 } });
  await publish(ctx, { docId, locale: "en" });
  const { version: v2 } = await saveDraft(ctx, { docId, locale: "de", data: { title: "t", body: raw(), price: 0.1 + 0.2 } });
  expect(await hashesOf(sql, docId, "de", v2)).toEqual(first);
  await publish(ctx, { docId, locale: "de" });
  // Re-save the stored data read back from the database (jsonb forms of the numbers): still unchanged.
  const [back] = await sql`select data from document_localized where doc_id = ${docId} and locale = 'de' and version = ${v2}`;
  const { version: v3 } = await saveDraft(ctx, { docId, locale: "de", data: back!.data as Record<string, unknown> });
  expect(await hashesOf(sql, docId, "de", v3)).toEqual(first);
  // A changed value re-stamps that field only.
  const changed = raw(); changed.tiny = 2e-7;
  const { version: v4 } = await saveDraft(ctx, { docId, locale: "de", data: { title: "t", body: changed, price: 0.1 + 0.2 } });
  expect(await hashesOf(sql, docId, "de", v4)).toEqual({ title: first.title, body: hashValue("B2"), price: first.price });
}));

test("jsonb round trip: stored self-hash equals hashValue of the data read back", async () => withTestDb(async (sql) => {
  const { ctx, docId } = await setup(sql);
  // body is richText (arbitrary JSON): nested nulls, a list with null elements, numbers 0 / -0.5 / 1e21,
  // nested objects and a decomposed e-acute (normalized to NFC before hashing and storage).
  const body = {
    type: "doc", note: null, text: "Cafe\u0301",
    nums: [0, -0.5, 1e21, null], deep: { a: { b: null, c: [null, { d: "x", e: null }] } },
  };
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Cafe\u0301", body, price: 1e21 } });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "y", price: 0, tags: ["a", "caf\u00e9"] } });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "z", price: -0.5, body: [null, 0, { k: null }] } });
  const rows = await sql`select data, source_hashes from document_localized where doc_id = ${docId} order by version`;
  expect(rows).toHaveLength(3);
  for (const r of rows) {
    const data = r.data as Record<string, unknown>;
    const hashes = r.source_hashes as Record<string, string>;
    expect(Object.keys(hashes).sort()).toEqual(Object.keys(data).sort());
    for (const k of Object.keys(data)) expect(hashes[k], k).toBe(hashValue(data[k]));
  }
  const first = rows[0]!.data as Record<string, unknown>;
  expect(first.title).toBe("Caf\u00e9");
  expect((first.body as { text: string }).text).toBe("Caf\u00e9");
}));
