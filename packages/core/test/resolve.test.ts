import { expect, test } from "vitest";
import postgres from "postgres";
import type { Sql } from "postgres";
import {
  NotFoundError, ValidationError, createDocument, getDocument, listDocuments, migrate, publish, resolve,
  resolveReference, saveDraft, unpublish, deleteDocument, defineCollection, defineConfig, number, richText, slug,
} from "../src/index.js";
import { ctxFor, insertPublishedLocalized } from "./fixtures.js";
import { withTestDb } from "./db.js";

async function setup(sql: Sql) {
  await migrate(sql);
  const ctx = ctxFor(sql, "reader");
  const ids: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const { id } = await createDocument(ctx, { collection: "posts" });
    ids.push(id);
    await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: `post-${i}` } });
    await publish(ctx, { docId: id, locale: "shared" });
    await insertPublishedLocalized(sql, id, "en", 1, {
      title: `T${i} en`, body: `B${i} en`, legal: `L${i} en`, price: 10 * i,
    }, { title: "h-en" });
    await insertPublishedLocalized(sql, id, "de", 1, { title: `T${i} de`, body: `B${i} de` });
  }
  await insertPublishedLocalized(sql, ids[0]!, "de-CH", 1, { title: "T1 de-CH" });
  return { ctx, ids };
}

test("de-CH resolves title from de-CH, body from de, legal from en and reports fellBack", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  const [d] = await resolve(ctx, { collection: "posts", locale: "de-CH", ids: [ids[0]!] });
  expect(d!.fellBack).toEqual({ body: "de", legal: "en" });
  expect(d!.data).toMatchObject({ slug: "post-1", title: "T1 de-CH", body: "B1 de", legal: "L1 en" });
}));

test("price with fallback none is missing when de lacks it", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  const [d] = await resolve(ctx, { collection: "posts", locale: "de", ids: [ids[0]!] });
  expect(d!.missing).toContain("price");
  expect(d!.data).not.toHaveProperty("price");
  expect(d!.fellBack.price).toBeUndefined();
}));

test("a field saved as JSON null in de falls back to en", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "EN title", body: "EN body" } });
  await publish(ctx, { docId: id, locale: "en" });
  await saveDraft(ctx, { docId: id, locale: "de", data: { title: null, body: "DE body" } });
  await publish(ctx, { docId: id, locale: "de" });
  const [d] = await resolve(ctx, { collection: "posts", locale: "de" });
  expect(d!.data.title).toBe("EN title");
  expect(d!.data.body).toBe("DE body");
  expect(d!.fellBack).toEqual({ title: "en" });
}));

test("an empty string in de is returned as empty, not fallen back", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  await sql`update document_localized set is_head_published = false, unpublished_at = now() where doc_id = ${ids[0]!} and locale = 'de' and version = 1`;
  await insertPublishedLocalized(sql, ids[0]!, "de", 2, { title: "", body: "B de", tags: [] });
  const [d] = await resolve(ctx, { collection: "posts", locale: "de", ids: [ids[0]!] });
  expect(d!.data.title).toBe("");
  expect(d!.data.tags).toEqual([]);
  expect(d!.fellBack).toEqual({ legal: "en" });
}));

test("asOf before first publication returns no documents", async () => withTestDb(async (sql) => {
  const { ctx } = await setup(sql);
  expect(await resolve(ctx, { collection: "posts", locale: "en", asOf: new Date("2000-01-01") })).toEqual([]);
}));

test("asOf between two publications returns the first version", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "first", body: "b" } });
  await publish(ctx, { docId: id, locale: "en" });
  await sql`select pg_sleep(0.01)`;
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "second", body: "b" } });
  await publish(ctx, { docId: id, locale: "en" });
  const rows = await sql`select version, published_at from document_localized where doc_id = ${id} order by version`;
  const t1 = (rows[0]!.published_at as Date).getTime();
  const t2 = (rows[1]!.published_at as Date).getTime();
  expect(t2).toBeGreaterThan(t1);
  const mid = new Date(t2 - 1);
  const [old] = await resolve(ctx, { collection: "posts", locale: "en", asOf: mid });
  expect(old!.data.title).toBe("first");
  const [atT1] = await resolve(ctx, { collection: "posts", locale: "en", asOf: new Date(t1) });
  expect(atT1!.data.title).toBe("first");
  const [atT2] = await resolve(ctx, { collection: "posts", locale: "en", asOf: new Date(t2) });
  expect(atT2!.data.title).toBe("second");
  const [now] = await resolve(ctx, { collection: "posts", locale: "en" });
  expect(now!.data.title).toBe("second");
}));

test("asOf equal to a publishedAt returned by getDocument resolves that exact version (20 fresh publishes)", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  const stamps: Array<[number, Date]> = [];
  for (let n = 1; n <= 20; n++) {
    await saveDraft(ctx, { docId: id, locale: "en", data: { title: `v${n}`, body: "b" } });
    await publish(ctx, { docId: id, locale: "en" });
    const doc = await getDocument(ctx, { collection: "posts", docId: id });
    stamps.push([n, doc!.locales.en!.published!.publishedAt!]);
  }
  for (const [n, t] of stamps) {
    const [d] = await resolve(ctx, { collection: "posts", locale: "en", asOf: t });
    expect(d!.data.title).toBe(`v${n}`);
  }
}));

test("two publications in consecutive milliseconds: asOf at each returns its own version", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "a", body: "b" } });
  await publish(ctx, { docId: id, locale: "en" });
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "b", body: "b" } });
  await publish(ctx, { docId: id, locale: "en" });
  // Force the consecutive-millisecond shape deterministically.
  await sql`update document_localized set published_at = '2030-01-01T00:00:00.000Z' where doc_id = ${id} and version = 1`;
  await sql`update document_localized set unpublished_at = '2030-01-01T00:00:00.001Z' where doc_id = ${id} and version = 1`;
  await sql`update document_localized set published_at = '2030-01-01T00:00:00.001Z' where doc_id = ${id} and version = 2`;
  const at = async (iso: string) => (await resolve(ctx, { collection: "posts", locale: "en", asOf: new Date(iso) }))[0]?.data.title;
  expect(await at("2030-01-01T00:00:00.000Z")).toBe("a");
  expect(await at("2030-01-01T00:00:00.001Z")).toBe("b");
}));

test("boundaries: published_at == asOf is included, unpublished_at == asOf is excluded", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await insertPublishedLocalized(sql, id, "en", 1, { title: "x", body: "b" });
  await sql`update document_localized set published_at = '2030-01-01T00:00:00.000Z', unpublished_at = '2030-01-02T00:00:00.000Z', is_head_published = false where doc_id = ${id}`;
  const n = async (iso: string) => (await resolve(ctx, { collection: "posts", locale: "en", asOf: new Date(iso) })).length;
  expect(await n("2029-12-31T23:59:59.999Z")).toBe(0);
  expect(await n("2030-01-01T00:00:00.000Z")).toBe(1);
  expect(await n("2030-01-01T23:59:59.999Z")).toBe(1);
  expect(await n("2030-01-02T00:00:00.000Z")).toBe(0);
}));

test("publish, unpublish, republish: asOf inside the gap shows nothing for that locale, chains still apply", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "s" } });
  await publish(ctx, { docId: id, locale: "shared" });
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "EN", body: "b" } });
  await publish(ctx, { docId: id, locale: "en" });
  await saveDraft(ctx, { docId: id, locale: "de", data: { title: "DE", body: "b" } });
  await publish(ctx, { docId: id, locale: "de" });
  await unpublish(ctx, { docId: id, locale: "de" });
  await publish(ctx, { docId: id, locale: "de", version: 1 });
  // Pin stamps: en live from day 1; de live [day1, day2) then [day4, ...)
  await sql`update document_shared set published_at = '2030-01-01T00:00:00Z' where doc_id = ${id}`;
  await sql`update document_localized set published_at = '2030-01-01T00:00:00Z' where doc_id = ${id} and locale = 'en'`;
  await sql`update document_localized set published_at = '2030-01-04T00:00:00Z' where doc_id = ${id} and locale = 'de'`;
  // the gap [day2, day4) is represented by the unpublish stamp then republish stamp; verify via data below
  const get = async (iso: string) => (await resolve(ctx, { collection: "posts", locale: "de", asOf: new Date(iso) }))[0];
  const inGap = await get("2030-01-02T00:00:00Z");
  expect(inGap!.data.title).toBe("EN");
  expect(inGap!.fellBack.title).toBe("en");
  const after = await get("2030-01-04T00:00:00Z");
  expect(after!.data.title).toBe("DE");
  expect(after!.fellBack).toEqual({});
  // shared in a gap: shows no shared fields, document still present through localized heads
  await sql`update document_shared set published_at = '2030-01-03T00:00:00Z' where doc_id = ${id}`;
  const noShared = await get("2030-01-02T00:00:00Z");
  expect(noShared!.data).not.toHaveProperty("slug");
  expect(noShared!.data.title).toBe("EN");
}));

test("a per-field fallback override skips the default chain: de-CH legal comes from en even when de has legal", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  await sql`update document_localized set is_head_published = false, unpublished_at = now() where doc_id = ${ids[0]!} and locale = 'de'`;
  await insertPublishedLocalized(sql, ids[0]!, "de", 2, { title: "T1 de", body: "B1 de", legal: "L1 de" });
  const [d] = await resolve(ctx, { collection: "posts", locale: "de-CH", ids: [ids[0]!] });
  expect(d!.data.legal).toBe("L1 en");
  expect(d!.fellBack.legal).toBe("en");
  expect(d!.data.body).toBe("B1 de");
  const [de] = await resolve(ctx, { collection: "posts", locale: "de", ids: [ids[0]!] });
  expect(de!.data.legal).toBe("L1 de");
}));

test("asOf applies the window to unpublished rows and to fallback locales", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  const before = new Date(Date.now() - 60_000);
  await sql`update document_localized set published_at = ${before.toISOString()}::timestamptz where doc_id = ${ids[0]!} and locale = 'en'`;
  const mid = new Date(Date.now() - 30_000);
  const [d] = await resolve(ctx, { collection: "posts", locale: "de", ids: [ids[0]!], asOf: mid });
  // de was published just now (after mid), en before: everything falls back to en.
  expect(d!.data.title).toBe("T1 en");
  expect(d!.fellBack.title).toBe("en");
  await sql`update document_localized set is_head_published = false, unpublished_at = ${new Date(Date.now() - 10_000).toISOString()}::timestamptz where doc_id = ${ids[0]!} and locale = 'en'`;
  expect(await resolve(ctx, { collection: "posts", locale: "en", ids: [ids[0]!], asOf: mid }).then((r) => r[0]!.data.title)).toBe("T1 en");
  // en is unpublished and posts has localized fields: shared alone does not make the document visible (R9).
  expect((await resolve(ctx, { collection: "posts", locale: "en", ids: [ids[0]!], asOf: new Date() })).length).toBe(0);
  expect((await resolve(ctx, { collection: "posts", locale: "de", ids: [ids[0]!], asOf: new Date() })).length).toBe(1); // de head visible
}));

test("soft-deleted document is absent from resolve, absent asOf after deletion, present asOf before", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  const before = new Date(Date.now() - 1000);
  await sql`update documents set created_at = created_at - interval '1 hour' where id = ${ids[0]!}`;
  await sql`update document_localized set published_at = ${new Date(Date.now() - 3_600_000).toISOString()}::timestamptz where doc_id = ${ids[0]!}`;
  await sql`update document_shared set published_at = ${new Date(Date.now() - 3_600_000).toISOString()}::timestamptz where doc_id = ${ids[0]!}`;
  await sql`update documents set deleted_at = now() where id = ${ids[0]!}`;
  const live = await resolve(ctx, { collection: "posts", locale: "en" });
  expect(live.map((r) => r.id)).not.toContain(ids[0]!);
  const after = await resolve(ctx, { collection: "posts", locale: "en", asOf: new Date(Date.now() + 1000) });
  expect(after.map((r) => r.id)).not.toContain(ids[0]!);
  const earlier = await resolve(ctx, { collection: "posts", locale: "en", asOf: before });
  expect(earlier.map((r) => r.id)).toContain(ids[0]!);
}));

test("resolve of 50 documents issues one SQL statement", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const [{ s }] = (await sql`select current_schema() as s`) as unknown as [{ s: string }];
  let count = 0;
  const counting = postgres(process.env.DATABASE_URL!, {
    max: 1, onnotice: () => {}, connection: { search_path: s }, debug: () => { count++; },
  });
  try {
    const ctx = { ...ctxFor(counting), actor: "t" };
    const created: string[] = [];
    for (let i = 0; i < 50; i++) {
      const { id } = await createDocument(ctx, { collection: "posts" });
      created.push(id);
      await insertPublishedLocalized(counting, id, "en", 1, { title: `t${i}`, body: "b" });
    }
    count = 0;
    const out = await resolve(ctx, { collection: "posts", locale: "de-CH" });
    expect(out).toHaveLength(50);
    // Identity and projection, not just cardinality: every document once, in creation order, with its own data.
    expect(out.map((d) => d.id)).toEqual(created);
    expect(out.map((d) => d.data.title)).toEqual(created.map((_, i) => `t${i}`));
    expect(out.every((d) => d.data.body === "b" && d.fellBack.title === "en")).toBe(true);
    expect(count).toBe(1);
  } finally {
    await counting.end();
  }
}));

test("ids and limit filter, ordered by created_at then id", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  const all = await resolve(ctx, { collection: "posts", locale: "en" });
  expect(all.map((r) => r.id)).toEqual(ids);
  expect((await resolve(ctx, { collection: "posts", locale: "en", limit: 2 })).map((r) => r.id)).toEqual(ids.slice(0, 2));
  expect((await resolve(ctx, { collection: "posts", locale: "en", ids: [ids[2]!, ids[0]!] })).map((r) => r.id)).toEqual([ids[0], ids[2]]);
  expect(await resolve(ctx, { collection: "posts", locale: "en", ids: [] })).toEqual([]);
}));

test("only declared fields are returned; stray keys are ignored", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await insertPublishedLocalized(sql, id, "en", 1, { title: "x", stray: 1, constructor: 2 });
  const [d] = await resolve(ctx, { collection: "posts", locale: "en" });
  expect(Object.keys(d!.data)).toEqual(["title"]);
  expect(d!.missing.sort()).toEqual(["body", "legal", "price", "tags"]);
}));

test("prototype-named and unknown input is rejected, not crashed on", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  await expect(resolve(ctx, { collection: "constructor", locale: "en" })).rejects.toThrow(NotFoundError);
  await expect(getDocument(ctx, { collection: "__proto__", slug: "x" })).rejects.toThrow(NotFoundError);
  await expect(listDocuments(ctx, { collection: "toString" })).rejects.toThrow(NotFoundError);
  await expect(resolve(ctx, { collection: "posts", locale: "xx" })).rejects.toThrow(ValidationError);
  await expect(resolve(ctx, { collection: "posts", locale: "en!" })).rejects.toThrow(ValidationError);
}));

test("getDocument by slug returns raw heads per locale with sourceHashes and no fallback", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  await saveDraft(ctx, { docId: ids[0]!, locale: "de", data: { title: "draft de", body: "b" } });
  const doc = await getDocument(ctx, { collection: "posts", slug: "post-1" });
  expect(doc!.id).toBe(ids[0]);
  expect(doc!.collection).toBe("posts");
  expect(doc!.deletedAt).toBeNull();
  expect(doc!.shared.published!.data).toEqual({ slug: "post-1" });
  expect(doc!.shared.draft).toBeNull();
  expect(Object.keys(doc!.locales).sort()).toEqual(["de", "de-CH", "en"]);
  expect(doc!.locales.en!.published!.sourceHashes).toEqual({ title: "h-en" });
  expect(doc!.locales.en!.published!.state).toBe("PUBLISHED");
  expect(doc!.locales.en!.draft).toBeNull();
  expect(doc!.locales["de-CH"]!.published!.data).toEqual({ title: "T1 de-CH" }); // no fallback merged in
  expect(doc!.locales.de!.draft!.data).toMatchObject({ title: "draft de" });
  expect(doc!.locales.de!.draft!.publishedAt).toBeNull();
  expect(doc!.locales.de!.published!.publishedAt).toBeInstanceOf(Date);
  const byId = await getDocument(ctx, { collection: "posts", docId: ids[0]! });
  expect(byId).toEqual(doc);
}));

test("getDocument finds a slug that only exists in the draft head and returns soft-deleted documents", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "only-draft" } });
  const doc = await getDocument(ctx, { collection: "posts", slug: "only-draft" });
  expect(doc!.shared.draft!.data).toEqual({ slug: "only-draft" });
  expect(doc!.shared.published).toBeNull();
  await sql`update documents set deleted_at = now() where id = ${id}`;
  expect((await getDocument(ctx, { collection: "posts", docId: id }))!.deletedAt).toBeInstanceOf(Date);
}));

test("getDocument returns null for an unknown slug, unknown id and malformed id", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  expect(await getDocument(ctx, { collection: "posts", slug: "nope" })).toBeNull();
  expect(await getDocument(ctx, { collection: "posts", docId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
  expect(await getDocument(ctx, { collection: "posts", docId: "not-a-uuid" })).toBeNull();
}));

test("getDocument requires exactly one of docId or slug", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  await expect(getDocument(ctx, { collection: "posts" })).rejects.toThrow(ValidationError);
  await expect(getDocument(ctx, { collection: "posts", docId: "00000000-0000-4000-8000-000000000000", slug: "x" })).rejects.toThrow(ValidationError);
}));

test("listDocuments paginates by keyset and excludes soft-deleted docs by default", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  await sql`update documents set deleted_at = now() where id = ${ids[1]!}`;
  const p1 = await listDocuments(ctx, { collection: "posts", limit: 1 });
  expect(p1.items.map((i) => i.id)).toEqual([ids[0]]);
  expect(p1.items[0]!.slug).toBe("post-1");
  expect(p1.items[0]!.createdAt).toBeInstanceOf(Date);
  expect(p1.next).toBe(ids[0]);
  const p2 = await listDocuments(ctx, { collection: "posts", limit: 1, after: p1.next! });
  expect(p2.items.map((i) => i.id)).toEqual([ids[2]]);
  expect(p2.next).toBeNull();
  const withDeleted = await listDocuments(ctx, { collection: "posts", includeDeleted: true });
  expect(withDeleted.items.map((i) => i.id)).toEqual(ids);
  expect(withDeleted.next).toBeNull();
  const { id: bare } = await createDocument(ctx, { collection: "posts" });
  const last = await listDocuments(ctx, { collection: "posts", after: ids[2]! });
  expect(last.items).toEqual([{ id: bare, slug: null, createdAt: expect.any(Date) }]);
  await expect(listDocuments(ctx, { collection: "posts", after: "zzz" })).rejects.toThrow(ValidationError);
}));

test("resolveReference reports the locale the target resolved in", async () => withTestDb(async (sql) => {
  const { ctx, ids } = await setup(sql);
  expect(await resolveReference(ctx, { docId: ids[0]!, locale: "de-CH" })).toEqual({ id: ids[0], resolvedLocale: "de-CH" });
  expect(await resolveReference(ctx, { docId: ids[1]!, locale: "de-CH" })).toEqual({ id: ids[1], resolvedLocale: "de" });
  await sql`update document_localized set is_head_published = false where doc_id = ${ids[1]!} and locale = 'de'`;
  expect(await resolveReference(ctx, { docId: ids[1]!, locale: "de-CH" })).toEqual({ id: ids[1], resolvedLocale: "en" });
  await sql`update document_localized set is_head_published = false where doc_id = ${ids[1]!}`;
  // the shared head is still published, but posts has localized fields and none is published: not resolvable
  expect(await resolveReference(ctx, { docId: ids[1]!, locale: "de" })).toBeNull();
  await sql`update documents set deleted_at = now() where id = ${ids[2]!}`;
  expect(await resolveReference(ctx, { docId: ids[2]!, locale: "en" })).toBeNull();
  expect(await resolveReference(ctx, { docId: "00000000-0000-4000-8000-000000000000", locale: "en" })).toBeNull();
  expect(await resolveReference(ctx, { docId: "bogus", locale: "en" })).toBeNull();
}));

test("a document with only its shared head published is omitted when the collection has localized fields", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const { id } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "a" } });
  await publish(ctx, { docId: id, locale: "shared" });
  expect(await resolve(ctx, { collection: "posts", locale: "de-CH" })).toEqual([]);
  expect(await resolveReference(ctx, { docId: id, locale: "de-CH" })).toBeNull();
  await saveDraft(ctx, { docId: id, locale: "en", data: { title: "T", body: "B" } });
  await publish(ctx, { docId: id, locale: "en" });
  const out = await resolve(ctx, { collection: "posts", locale: "de-CH" });
  expect(out.map((d) => d.id)).toEqual([id]);
  expect(out[0]!.data).toMatchObject({ slug: "a", title: "T" });
  expect(await resolveReference(ctx, { docId: id, locale: "de-CH" })).toEqual({ id, resolvedLocale: "en" });
  await deleteDocument(ctx, { docId: id });
  expect(await resolveReference(ctx, { docId: id, locale: "de-CH" })).toBeNull();
}));

test("a collection with only shared fields still resolves on its shared head", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const cfg = defineConfig({
    collections: [defineCollection("pages", { slug: slug(), order: number(), body: richText({ body: true }) })],
    locales: { source: "en", chains: { de: ["en"] } },
  });
  const ctx = { sql, config: cfg, actor: "t" };
  const { id } = await createDocument(ctx, { collection: "pages" });
  expect(await resolve(ctx, { collection: "pages", locale: "de" })).toEqual([]); // nothing published
  await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "home", order: 1, body: "x" } });
  await publish(ctx, { docId: id, locale: "shared" });
  const out = await resolve(ctx, { collection: "pages", locale: "de" });
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ id, data: { slug: "home", order: 1, body: "x" }, missing: [] });
  expect(await resolveReference(ctx, { docId: id, locale: "de" })).toEqual({ id, resolvedLocale: "de" });
}));
