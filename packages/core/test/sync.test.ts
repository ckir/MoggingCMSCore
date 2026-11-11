import { expect, test } from "vitest";
import postgres from "postgres";
import type { Sql } from "postgres";
import {
  NotFoundError, ValidationError, createDocument, deleteDocument, getSyncState, hashValue, migrate, publish,
  saveDraft, trackFields,
} from "../src/index.js";
import { ctxFor, insertPublishedLocalized } from "./fixtures.js";
import { withTestDb } from "./db.js";

const stateOf = (rows: Awaited<ReturnType<typeof getSyncState>>) =>
  Object.fromEntries(rows.map((r) => [`${r.locale}.${r.field}`, r.state]));

async function enDoc(sql: Sql, data: Record<string, unknown> = { title: "T", body: "B" }) {
  await migrate(sql);
  const ctx = ctxFor(sql, "ed");
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "en", data });
  await publish(ctx, { docId: id, locale: "en" });
  return { ctx, id };
}

test("new locale with no snapshot reports every localized field missing", async () => withTestDb(async (sql) => {
  const { ctx, id } = await enDoc(sql);
  const rows = await getSyncState(ctx, { docId: id });
  // posts has localized fields title/body present in source; de and de-CH have no snapshot.
  expect(rows).toHaveLength(4);
  expect(rows.every((r) => r.state === "missing" && r.sourceVersion === 1)).toBe(true);
  expect(stateOf(rows)).toEqual({
    "de.title": "missing", "de.body": "missing", "de-CH.title": "missing", "de-CH.body": "missing",
  });
}));

test("source change on title makes de title stale and leaves body current", async () => withTestDb(async (sql) => {
  const { ctx, id } = await enDoc(sql);
  await saveDraft(ctx, { docId: id, locale: "de", data: { title: "T de", body: "B de" } });
  await publish(ctx, { docId: id, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId: id, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "current" });
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "T2", body: "B" } });
  await publish(ctx, { docId: id, locale: "en" });
  const rows = await getSyncState(ctx, { docId: id, locale: "de" });
  expect(stateOf(rows)).toEqual({ "de.title": "stale", "de.body": "current" });
  expect(rows.every((r) => r.sourceVersion === 2)).toBe(true);
}));

test("human save of de after the change makes it current", async () => withTestDb(async (sql) => {
  const { ctx, id } = await enDoc(sql);
  await saveDraft(ctx, { docId: id, locale: "de", data: { title: "T de", body: "B de" } });
  await publish(ctx, { docId: id, locale: "de" });
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "T2", body: "B" } });
  await publish(ctx, { docId: id, locale: "en" });
  expect(stateOf(await getSyncState(ctx, { docId: id, locale: "de" }))["de.title"]).toBe("stale");
  // The target head is now the published one; a new draft head becomes the current head only once published.
  await saveDraft(ctx, { docId: id, locale: "de", data: { title: "T2 de", body: "B de" } });
  await publish(ctx, { docId: id, locale: "de" });
  expect(stateOf(await getSyncState(ctx, { docId: id, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "current" });
}));

test("field present in de but absent from schema-declared source is orphaned", async () => withTestDb(async (sql) => {
  const { ctx, id } = await enDoc(sql); // source has title, body only; no legal
  await insertPublishedLocalized(sql, id, "de", 1, { title: "T de", legal: "L de" }, { title: hashValue("T") });
  const rows = await getSyncState(ctx, { docId: id, locale: "de" });
  expect(stateOf(rows)).toEqual({ "de.title": "current", "de.body": "missing", "de.legal": "orphaned" });
}));

test("untracked field becomes current after trackFields", async () => withTestDb(async (sql) => {
  const { ctx, id } = await enDoc(sql);
  await insertPublishedLocalized(sql, id, "de", 1, { title: "T de", body: "B de" }); // no hashes
  expect(stateOf(await getSyncState(ctx, { docId: id, locale: "de" }))).toEqual({ "de.title": "untracked", "de.body": "untracked" });
  await trackFields(ctx, { docId: id, locale: "de", fields: ["title"] });
  expect(stateOf(await getSyncState(ctx, { docId: id, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "untracked" });
  const [row] = await sql`select source_hashes from document_localized where doc_id = ${id} and locale = 'de'`;
  expect(row!.source_hashes).toEqual({ title: hashValue("T") });
}));

test("trackFields writes no new version and exactly one human:track provenance row per field", async () => withTestDb(async (sql) => {
  const { id } = await enDoc(sql);
  const ctx = ctxFor(sql, "tracker");
  await insertPublishedLocalized(sql, id, "de", 1, { title: "T de", body: "B de" });
  await trackFields(ctx, { docId: id, locale: "de", fields: ["title", "body", "title"] });
  const [{ n }] = (await sql`select count(*)::int as n from document_localized where doc_id = ${id} and locale = 'de'`) as unknown as [{ n: number }];
  expect(n).toBe(1);
  const prov = await sql`select field_path, model_id, approved_by, version, prompt_version, prompt_tokens, cost_micros
    from content_provenance where doc_id = ${id} and locale = 'de' order by field_path`;
  expect(prov.map((p) => ({ ...p }))).toEqual([
    { field_path: "body", model_id: "human:track", approved_by: "tracker", version: 1, prompt_version: "", prompt_tokens: 0, cost_micros: "0" },
    { field_path: "title", model_id: "human:track", approved_by: "tracker", version: 1, prompt_version: "", prompt_tokens: 0, cost_micros: "0" },
  ]);
}));

test("trackFields tracks the draft head when the target has no published head", async () => withTestDb(async (sql) => {
  const { ctx, id } = await enDoc(sql);
  await sql`insert into document_localized (doc_id, locale, version, state, data, is_head_draft, created_by)
    values (${id}, 'de', 1, 'DRAFT_HUMAN', ${sql.json({ title: "T de" })}, true, 'x')`;
  await trackFields(ctx, { docId: id, locale: "de", fields: ["title"] });
  expect(stateOf(await getSyncState(ctx, { docId: id, locale: "de" }))["de.title"]).toBe("current");
}));

test("trackFields rejects undeclared and prototype-named fields and writes nothing", async () => withTestDb(async (sql) => {
  const { ctx, id } = await enDoc(sql);
  await insertPublishedLocalized(sql, id, "de", 1, { title: "T de", body: "B de" });
  for (const bad of ["constructor", "__proto__", "nope", "slug"]) {
    await expect(trackFields(ctx, { docId: id, locale: "de", fields: ["title", bad] })).rejects.toBeInstanceOf(ValidationError);
  }
  const [{ n }] = (await sql`select count(*)::int as n from content_provenance`) as unknown as [{ n: number }];
  expect(n).toBe(0);
  const [row] = await sql`select source_hashes from document_localized where doc_id = ${id} and locale = 'de'`;
  expect(row!.source_hashes).toEqual({});
}));

test("trackFields validates locale, missing target, missing source value and missing target value all-or-nothing", async () => withTestDb(async (sql) => {
  const { ctx, id } = await enDoc(sql);
  await expect(trackFields(ctx, { docId: id, locale: "en", fields: ["title"] })).rejects.toBeInstanceOf(ValidationError);
  await expect(trackFields(ctx, { docId: id, locale: "shared", fields: ["title"] })).rejects.toBeInstanceOf(ValidationError);
  await expect(trackFields(ctx, { docId: id, locale: "fr", fields: ["title"] })).rejects.toBeInstanceOf(ValidationError);
  await expect(trackFields(ctx, { docId: id, locale: "de", fields: ["title"] })).rejects.toBeInstanceOf(NotFoundError);
  await insertPublishedLocalized(sql, id, "de", 1, { title: "T de", legal: "L de" });
  // legal: source has no value -> nothing written, even for title
  await expect(trackFields(ctx, { docId: id, locale: "de", fields: ["title", "legal"] })).rejects.toThrow(/source has no value/);
  // body: source has it, de does not
  await expect(trackFields(ctx, { docId: id, locale: "de", fields: ["title", "body"] })).rejects.toBeInstanceOf(ValidationError);
  const [{ n }] = (await sql`select count(*)::int as n from content_provenance`) as unknown as [{ n: number }];
  expect(n).toBe(0);
  const [row] = await sql`select source_hashes from document_localized where doc_id = ${id} and locale = 'de'`;
  expect(row!.source_hashes).toEqual({});
}));

test("docId and locale filters, and soft-deleted documents are excluded", async () => withTestDb(async (sql) => {
  const a = await enDoc(sql);
  const b = await enDoc(sql);
  const all = await getSyncState(a.ctx, {});
  expect(all).toHaveLength(8);
  expect(await getSyncState(a.ctx, { docId: a.id })).toHaveLength(4);
  expect((await getSyncState(a.ctx, { locale: "DE-ch" })).every((r) => r.locale === "de-CH")).toBe(true);
  expect(await getSyncState(a.ctx, { locale: "de-CH" })).toHaveLength(4);
  expect(await getSyncState(a.ctx, { collection: "posts", docId: b.id, locale: "de" })).toHaveLength(2);
  await expect(getSyncState(a.ctx, { locale: "en" })).rejects.toBeInstanceOf(ValidationError);
  await expect(getSyncState(a.ctx, { locale: "fr" })).rejects.toBeInstanceOf(ValidationError);
  await deleteDocument(a.ctx, { docId: a.id });
  const after = await getSyncState(a.ctx, {});
  expect(after).toHaveLength(4);
  expect(after.every((r) => r.docId === b.id)).toBe(true);
  expect(await getSyncState(a.ctx, { docId: a.id })).toEqual([]);
}));

test("sourceVersion follows the republished source for every state", async () => withTestDb(async (sql) => {
  const { ctx, id } = await enDoc(sql);
  await insertPublishedLocalized(sql, id, "de", 1, { title: "T de", legal: "L de" }, { title: hashValue("T") });
  await insertPublishedLocalized(sql, id, "de-CH", 1, { body: "B ch" });
  for (const v of [2, 3]) {
    await saveDraft(ctx, { docId: id, locale: "en", data: { title: "T", body: `B${v}` } });
    await publish(ctx, { docId: id, locale: "en" });
  }
  const rows = await getSyncState(ctx, { docId: id });
  expect(new Set(Object.values(stateOf(rows)))).toEqual(new Set(["current", "missing", "orphaned", "untracked"]));
  expect(rows.every((r) => r.sourceVersion === 3)).toBe(true);
}));

test("sweep over 200 docs x 3 locales returns the expected count", { timeout: 60_000 }, async () => withTestDb(async (sql) => {
  await migrate(sql);
  const [{ s }] = (await sql`select current_schema() as s`) as unknown as [{ s: string }];
  let count = 0;
  const counting = postgres(process.env.DATABASE_URL!, {
    max: 1, onnotice: () => {}, connection: { search_path: s }, debug: () => { count++; },
  });
  try {
    const ctx = ctxFor(counting);
    const DOCS = 200;
    let expected = 0;
    for (let i = 0; i < DOCS; i++) {
      const { id } = await createDocument(ctx, { collection: "posts" });
      // source: title always, body on even docs; targets: de has title only (+orphan legal on every 4th).
      const src: Record<string, unknown> = { title: `t${i}` };
      if (i % 2 === 0) src.body = `b${i}`;
      await insertPublishedLocalized(counting, id, "en", 1, src, {});
      const de: Record<string, unknown> = { title: `d${i}` };
      if (i % 4 === 0) de.legal = "x";
      await insertPublishedLocalized(counting, id, "de", 1, de);
      // de-CH and fr-less: de-CH has no snapshot. Pairs per locale = union of source and target fields.
      const srcKeys = Object.keys(src);
      expected += new Set([...srcKeys, ...Object.keys(de)]).size; // de
      expected += srcKeys.length; // de-CH (no snapshot)
    }
    count = 0;
    const rows = await getSyncState(ctx, {});
    expect(count).toBe(1);
    expect(rows).toHaveLength(expected);
    expect(rows.filter((r) => r.state === "orphaned")).toHaveLength(DOCS / 4);
    expect(rows.filter((r) => r.locale === "de-CH").every((r) => r.state === "missing")).toBe(true);
  } finally {
    await counting.end();
  }
}));
