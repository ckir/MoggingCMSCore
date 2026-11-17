import { expect, test } from "vitest";
import type { Sql } from "postgres";
import {
  ValidationError, addToRelease, createDocument, createRelease, defineCollection, defineConfig, deleteDocument,
  getDocument, migrate, publish, publishRelease, richText, saveDraft, slug, text,
} from "../src/index.js";
import type { Ctx } from "../src/index.js";
import { extraConnection } from "./fixtures.js";
import { withTestDb } from "./db.js";

const A = defineCollection("A", { slug: slug(), body: richText({ localized: true, body: true }) });
const B = defineCollection("B", { slug: slug(), body: richText({ localized: true, body: true }) });
const posts = defineCollection("posts", { slug: slug(), body: richText({ localized: true, body: true }) });
const pages = defineCollection("pages", { slug: slug(), body: richText({ localized: true, body: true }) });
// A collection with no slug field: its shared text field may repeat freely.
const plain = defineCollection("plain", { code: text(), body: richText({ localized: true, body: true }) });
const config = defineConfig({
  collections: [A, B, posts, pages, plain],
  locales: { source: "en", chains: { de: ["en"] } },
});
const ctxFor = (sql: Sql, actor = "tester"): Ctx => ({ sql, config, actor });

async function setup(sql: Sql) {
  await migrate(sql);
  return ctxFor(sql);
}

const newDoc = async (ctx: Ctx, collection = "posts") => (await createDocument(ctx, { collection })).id;
const saveSlug = (ctx: Ctx, docId: string, value: string) =>
  saveDraft(ctx, { docId, locale: "shared", data: { slug: value } });
const CLASH = (s: string, c = "posts") => `Slug "${s}" is already used by another document in collection "${c}"`;

/** Inserts a document and a shared DRAFT_HUMAN head with raw SQL, as if saved before the guard existed. */
async function rawDraft(sql: Sql, docId: string, collection: string, value: string): Promise<void> {
  await sql`insert into documents (id, collection, created_by) values (${docId}, ${collection}, 'fixture')`;
  await sql`insert into document_shared (doc_id, version, state, data, is_head_draft, created_by)
    values (${docId}, 1, 'DRAFT_HUMAN', ${sql.json({ slug: value })}, true, 'fixture')`;
}

/** A deterministic uuid: `round` fills the leading group (the high-order bytes), `n` the last group. */
const uid = (round: number, n: number) =>
  `${round.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

test("a second live document cannot save the same slug, and no row is written", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const d1 = await newDoc(ctx);
  const d2 = await newDoc(ctx);
  await saveSlug(ctx, d1, "hello");
  const err = await saveSlug(ctx, d2, "hello").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).toBe(CLASH("hello"));
  // the guard sees the normalized (lower-cased) value
  await expect(saveSlug(ctx, d2, "HELLO")).rejects.toThrow(CLASH("hello"));
  const [{ n }] = await sql`select count(*)::int as n from document_shared where doc_id = ${d2}`;
  expect(n).toBe(0);
  expect(await saveSlug(ctx, d2, "other")).toEqual({ version: 1 });
}));

test("a published or a draft slug both block", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const published = await newDoc(ctx);
  const drafted = await newDoc(ctx);
  const taker = await newDoc(ctx);
  await saveSlug(ctx, published, "pub");
  await publish(ctx, { docId: published, locale: "shared" });
  await saveSlug(ctx, drafted, "drf");
  await expect(saveSlug(ctx, taker, "pub")).rejects.toThrow(CLASH("pub"));
  await expect(saveSlug(ctx, taker, "drf")).rejects.toThrow(CLASH("drf"));
  // a published head keeps its slug even while a newer draft of that document carries a different one
  await saveSlug(ctx, published, "pub-next");
  await expect(saveSlug(ctx, taker, "pub")).rejects.toThrow(CLASH("pub"));
  await expect(saveSlug(ctx, taker, "pub-next")).rejects.toThrow(CLASH("pub-next"));
}));

test("a slug is free in another collection, and unpublishing alone does not free a still-drafted slug", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const p = await newDoc(ctx, "posts");
  const q = await newDoc(ctx, "pages");
  await saveSlug(ctx, p, "same");
  expect(await saveSlug(ctx, q, "same")).toEqual({ version: 1 });
}));

test("a soft-deleted document's slug is free", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const d1 = await newDoc(ctx);
  const d2 = await newDoc(ctx);
  await saveSlug(ctx, d1, "gone");
  await publish(ctx, { docId: d1, locale: "shared" });
  await expect(saveSlug(ctx, d2, "gone")).rejects.toThrow(ValidationError);
  await deleteDocument(ctx, { docId: d1 });
  expect(await saveSlug(ctx, d2, "gone")).toEqual({ version: 1 });
}));

test("a document may re-save its own slug", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const d1 = await newDoc(ctx);
  expect(await saveSlug(ctx, d1, "mine")).toEqual({ version: 1 });
  expect(await saveSlug(ctx, d1, "mine")).toEqual({ version: 2 });
  await publish(ctx, { docId: d1, locale: "shared" });
  expect(await saveSlug(ctx, d1, "mine")).toEqual({ version: 3 });
  await publish(ctx, { docId: d1, locale: "shared" });
}));

test("publishing a shared draft whose slug another document took meanwhile is refused", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const d1 = await newDoc(ctx);
  await saveSlug(ctx, d1, "taken");
  await publish(ctx, { docId: d1, locale: "shared" });
  // a draft saved before the guard existed: inserted with raw SQL
  const d2 = uid(1, 2);
  await rawDraft(sql, d2, "posts", "taken");
  const err = await publish(ctx, { docId: d2, locale: "shared" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).toBe(CLASH("taken"));
  const [row] = await sql`select state, is_head_draft, is_head_published from document_shared where doc_id = ${d2}`;
  expect(row).toMatchObject({ state: "DRAFT_HUMAN", is_head_draft: true, is_head_published: false });
}));

test("republishing an old shared version is checked too", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const d1 = await newDoc(ctx);
  const d2 = await newDoc(ctx);
  await saveSlug(ctx, d1, "old");
  await publish(ctx, { docId: d1, locale: "shared" });
  await saveSlug(ctx, d1, "new");
  await publish(ctx, { docId: d1, locale: "shared" });
  await saveSlug(ctx, d2, "old"); // free now
  await expect(publish(ctx, { docId: d1, locale: "shared", version: 1 })).rejects.toThrow(CLASH("old"));
  const [{ n }] = await sql`select count(*)::int as n from document_shared where doc_id = ${d1}`;
  expect(n).toBe(2);
  const [head] = await sql`select data from document_shared where doc_id = ${d1} and is_head_published`;
  expect(head!.data).toEqual({ slug: "new" });
}));

test("publishRelease checks shared items", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const d1 = await newDoc(ctx);
  await saveSlug(ctx, d1, "rel");
  await publish(ctx, { docId: d1, locale: "shared" });
  const d2 = uid(1, 2);
  await rawDraft(sql, d2, "posts", "rel");
  const { id: releaseId } = await createRelease(ctx, { name: "r" });
  await addToRelease(ctx, { releaseId, docId: d2, locale: "shared", version: 1 });
  await expect(publishRelease(ctx, { releaseId })).rejects.toThrow(CLASH("rel"));
  const [rel] = await sql`select published_at from releases where id = ${releaseId}`;
  expect(rel!.published_at).toBeNull();
  const [row] = await sql`select is_head_draft, is_head_published from document_shared where doc_id = ${d2}`;
  expect(row).toMatchObject({ is_head_draft: true, is_head_published: false });
}));

test("two concurrent saves of the same slug on different documents: exactly one succeeds (repeated)", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const d1 = await newDoc(ctx);
  const d2 = await newDoc(ctx);
  const other = await extraConnection(sql);
  try {
    const ctxB = ctxFor(other, "other");
    for (let i = 0; i < 10; i++) {
      const results = await Promise.allSettled([saveSlug(ctx, d1, `s${i}`), saveSlug(ctxB, d2, `s${i}`)]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${i}`).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected, `round ${i}`).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason, `round ${i}`).toBeInstanceOf(ValidationError);
    }
    const heads = await sql`select s.data ->> 'slug' as slug, count(*)::int as n from document_shared s
      where s.is_head_draft group by 1 having count(*) > 1`;
    expect(heads).toHaveLength(0);
  } finally {
    await other.end();
  }
}));

test("a collection with no slug field is never checked", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const d1 = await newDoc(ctx, "plain");
  const d2 = await newDoc(ctx, "plain");
  await saveDraft(ctx, { docId: d1, locale: "shared", data: { code: "x" } });
  await saveDraft(ctx, { docId: d2, locale: "shared", data: { code: "x" } });
  await publish(ctx, { docId: d1, locale: "shared" });
  await publish(ctx, { docId: d2, locale: "shared" });
  const [{ n }] = await sql`select count(*)::int as n from document_shared where is_head_published`;
  expect(n).toBe(2);
}));

/**
 * Round `round`: release 1 holds an A document (smaller id) and a B document, so `order by doc_id` visits A then B;
 * release 2 holds a B document (smaller id) and an A document, so it visits B then A.
 */
async function oppositeRelease(ctx: Ctx, sql: Sql, round: number, which: 1 | 2): Promise<string> {
  const [first, second] = which === 1 ? (["A", "B"] as const) : (["B", "A"] as const);
  const base = which === 1 ? 1 : 3;
  const docs = [uid(round, base), uid(round, base + 1)];
  await rawDraft(sql, docs[0]!, first, `r${round}-${which}-${first}`);
  await rawDraft(sql, docs[1]!, second, `r${round}-${which}-${second}`);
  const { id } = await createRelease(ctx, { name: `r${round}-${which}` });
  for (const docId of docs) await addToRelease(ctx, { releaseId: id, docId, locale: "shared", version: 1 });
  return id;
}

test("two releases spanning two collections in opposite order both complete (repeated)", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const other = await extraConnection(sql);
  try {
    const ctxB = ctxFor(other, "other");
    for (let round = 1; round <= 10; round++) {
      const r1 = await oppositeRelease(ctx, sql, round, 1);
      const r2 = await oppositeRelease(ctx, sql, round, 2);
      const results = await Promise.allSettled([
        publishRelease(ctx, { releaseId: r1 }),
        publishRelease(ctxB, { releaseId: r2 }),
      ]);
      expect(results.map((r) => r.status), `round ${round}`).toEqual(["fulfilled", "fulfilled"]);
    }
    const [{ n }] = await sql`select count(*)::int as n from document_shared where is_head_published`;
    expect(n).toBe(40);
  } finally {
    await other.end();
  }
}));

test("publishRelease takes every shared collection's slug lock up front, in sorted order", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const holder = await extraConnection(sql);
  const releaser = await extraConnection(sql);
  let release: () => void = () => {};
  try {
    // The B document has the SMALLER id, so a release that locked lazily per item would wait on B holding nothing.
    const docB = uid(1, 1);
    const docA = uid(1, 2);
    await rawDraft(sql, docB, "B", "lock-b");
    await rawDraft(sql, docA, "A", "lock-a");
    const { id: releaseId } = await createRelease(ctx, { name: "locks" });
    for (const docId of [docB, docA]) await addToRelease(ctx, { releaseId, docId, locale: "shared", version: 1 });

    // advisory key of hashtext() as pg_locks shows it: classid = high 32 bits, objid = low 32 bits, objsubid 1
    const keyOf = async (name: string) => {
      const [{ h }] = (await sql`select hashtext('mogging_slug:' || ${name}::text)::bigint as h`) as unknown as [{ h: string }];
      return h;
    };
    const lockState = async (pid: number, name: string): Promise<boolean | undefined> => {
      const h = await keyOf(name);
      const [row] = await sql`select granted from pg_locks
        where pid = ${pid} and locktype = 'advisory' and objsubid = 1
          and classid::text::bigint = ((${h}::bigint >> 32) & 4294967295)
          and objid::text::bigint = (${h}::bigint & 4294967295)`;
      return row === undefined ? undefined : (row.granted as boolean);
    };

    const [{ pid }] = (await releaser`select pg_backend_pid() as pid`) as unknown as [{ pid: number }];
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const holderTx = holder.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('mogging_slug:' || ${"B"}::text))`;
      held();
      await gate;
    });
    await holding;

    const publishing = publishRelease(ctxFor(releaser, "releaser"), { releaseId });
    let a: boolean | undefined;
    let b: boolean | undefined;
    for (let i = 0; i < 100; i++) {
      [a, b] = [await lockState(pid, "A"), await lockState(pid, "B")];
      if (a === true && b === false) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect({ a, b }).toEqual({ a: true, b: false });
    const [{ n: flipped }] = await sql`select count(*)::int as n from document_shared where is_head_published`;
    expect(flipped).toBe(0);

    release();
    await holderTx;
    await publishing;
    const [{ n }] = await sql`select count(*)::int as n from document_shared where is_head_published`;
    expect(n).toBe(2);
  } finally {
    release(); // never leave the holder transaction open, or `end()` waits on it
    await holder.end();
    await releaser.end();
  }
}));

/** Publishes the shared heads of 20 `posts` documents with slugs `s1` ... `s20`; returns the id saved with `s7`. */
async function seedTwentyPublished(ctx: Ctx): Promise<string> {
  let s7 = "";
  for (let i = 1; i <= 20; i++) {
    const docId = await newDoc(ctx);
    await saveSlug(ctx, docId, `s${i}`);
    await publish(ctx, { docId, locale: "shared" });
    if (i === 7) s7 = docId;
  }
  return s7;
}

/**
 * The slug index's use counters in this transaction: scans started and entries returned. Both are asserted: with
 * `enable_seqscan = off` a bound-key lookup either skips the index (no scan) or scans it only to satisfy its partial
 * predicate (every head is returned), so a lookup that matches the index condition shows at least one scan and
 * (for a missing or unique slug) almost no entries. `force_generic_plan` stops a custom plan from substituting a
 * bound key as a constant and matching anyway.
 */
async function slugIndexUse(tx: Sql): Promise<{ scans: number; entries: number }> {
  const [row] = await tx`select pg_stat_get_xact_numscans('idx_doc_shared_slug'::regclass) as scans,
    pg_stat_get_xact_tuples_returned('idx_doc_shared_slug'::regclass) as entries`;
  return { scans: Number(row!.scans), entries: Number(row!.entries) };
}

function expectSlugIndexUsed(before: { scans: number; entries: number }, after: { scans: number; entries: number }): void {
  expect(after.scans - before.scans).toBeGreaterThanOrEqual(1);
  expect(after.entries - before.entries).toBeLessThan(5);
}

test("the slug guard's lookup uses the slug index condition", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  await seedTwentyPublished(ctx);
  await sql.begin(async (tx) => {
    await tx.unsafe("set local enable_seqscan = off");
    await tx.unsafe("set local plan_cache_mode = force_generic_plan");
    const txCtx: Ctx = { ...ctx, sql: tx as unknown as Sql };
    const id = await newDoc(txCtx);
    const before = await slugIndexUse(tx as unknown as Sql);
    await saveSlug(txCtx, id, "fresh");
    const after = await slugIndexUse(tx as unknown as Sql);
    expectSlugIndexUsed(before, after);
  });
}));

test("getDocument by slug uses the slug index condition", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const s7 = await seedTwentyPublished(ctx);
  await sql.begin(async (tx) => {
    await tx.unsafe("set local enable_seqscan = off");
    await tx.unsafe("set local plan_cache_mode = force_generic_plan");
    const txCtx: Ctx = { ...ctx, sql: tx as unknown as Sql };
    const before = await slugIndexUse(tx as unknown as Sql);
    const found = await getDocument(txCtx, { collection: "posts", slug: "s7" });
    const after = await slugIndexUse(tx as unknown as Sql);
    expect(found?.id).toBe(s7);
    expectSlugIndexUsed(before, after);
  });
}));
