import { expect, test } from "vitest";
import type { Sql } from "postgres";
import {
  NotFoundError, NotPublishableError, StaleReleaseError, ValidationError, addToRelease, createDocument, createRelease,
  getSyncState, migrate, publish, publishRelease, saveDraft,
} from "../src/index.js";
import { ctxFor, extraConnection, insertAiDraftLocalized } from "./fixtures.js";
import { withTestDb } from "./db.js";

type Ctx = ReturnType<typeof ctxFor>;

async function setup(sql: Sql) {
  await migrate(sql);
  return ctxFor(sql, "releaser");
}

/** A document with a published en head (title "T", body "B") and, optionally, an unpublished de draft. */
async function docWithSource(ctx: Ctx, withDe: boolean): Promise<{ docId: string; deVersion: number }> {
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "T", body: "B" } });
  await publish(ctx, { docId, locale: "en" });
  let deVersion = 0;
  if (withDe) ({ version: deVersion } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T de", body: "B de" } }));
  return { docId, deVersion };
}

async function republishSource(ctx: Ctx, docId: string, data: Record<string, unknown>) {
  await saveDraft(ctx, { docId, locale: "en", data });
  await publish(ctx, { docId, locale: "en" });
}

test("createRelease returns a string id; addToRelease validates release, doc, locale", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { id } = await createRelease(ctx, { name: "r1" });
  expect(typeof id).toBe("string");
  const [row] = await sql`select name, created_by, published_at, allow_stale from releases where id = ${id}`;
  expect(row).toMatchObject({ name: "r1", created_by: "releaser", published_at: null, allow_stale: false });
  const { docId, deVersion } = await docWithSource(ctx, true);
  await expect(addToRelease(ctx, { releaseId: "999999", docId, locale: "de", version: deVersion })).rejects.toThrow(NotFoundError);
  await expect(addToRelease(ctx, { releaseId: "abc", docId, locale: "de", version: deVersion })).rejects.toThrow(NotFoundError);
  await expect(addToRelease(ctx, { releaseId: id, docId: "00000000-0000-0000-0000-000000000000", locale: "de", version: 1 })).rejects.toThrow(NotFoundError);
  await expect(addToRelease(ctx, { releaseId: id, docId: "nope", locale: "de", version: 1 })).rejects.toThrow(NotFoundError);
  await expect(addToRelease(ctx, { releaseId: id, docId, locale: "fr", version: 1 })).rejects.toThrow(ValidationError);
  await addToRelease(ctx, { releaseId: id, docId, locale: "DE", version: deVersion });
  const items = await sql`select locale, draft_version from release_items where release_id = ${id}`;
  expect(items.map((r) => [r.locale, r.draft_version])).toEqual([["de", deVersion]]);
}));

test("addToRelease rejects DRAFT_AI, historical drafts, published heads, duplicates and published releases", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { id } = await createRelease(ctx, { name: "r" });
  const { docId, deVersion } = await docWithSource(ctx, true);
  // historical draft
  const { version: v2 } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T de 2", body: "B de" } });
  await expect(addToRelease(ctx, { releaseId: id, docId, locale: "de", version: deVersion })).rejects.toThrow(NotPublishableError);
  // already published en head
  await expect(addToRelease(ctx, { releaseId: id, docId, locale: "en", version: 1 })).rejects.toThrow(NotPublishableError);
  // nonexistent version
  await expect(addToRelease(ctx, { releaseId: id, docId, locale: "de", version: 99 })).rejects.toThrow(NotFoundError);
  // DRAFT_AI
  const ai = await docWithSource(ctx, false);
  await insertAiDraftLocalized(sql, ai.docId, "de", 1, { title: "KI" });
  await expect(addToRelease(ctx, { releaseId: id, docId: ai.docId, locale: "de", version: 1 })).rejects.toThrow(NotPublishableError);
  // duplicate
  await addToRelease(ctx, { releaseId: id, docId, locale: "de", version: v2 });
  const dup = addToRelease(ctx, { releaseId: id, docId, locale: "de", version: v2 });
  await expect(dup).rejects.toThrow(ValidationError);
  await expect(dup).rejects.toThrow(/already/);
  // published release
  await publishRelease(ctx, { releaseId: id });
  const next = await docWithSource(ctx, true);
  await expect(addToRelease(ctx, { releaseId: id, docId: next.docId, locale: "de", version: next.deVersion }))
    .rejects.toThrow(/release already published/);
}));

test("publishRelease flips all items atomically", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { id } = await createRelease(ctx, { name: "atomic" });
  const docs: Array<{ docId: string; deVersion: number }> = [];
  for (let i = 0; i < 5; i++) {
    const d = await docWithSource(ctx, true);
    docs.push(d);
    await addToRelease(ctx, { releaseId: id, docId: d.docId, locale: "de", version: d.deVersion });
  }
  // One item stops being the draft head after it was added.
  const victim = docs[2]!;
  await saveDraft(ctx, { docId: victim.docId, locale: "de", data: { title: "newer", body: "B de" } });
  const snapshot = async () => sql`select doc_id, version, state, is_head_draft, is_head_published, published_at, published_by
    from document_localized order by doc_id, locale, version`;
  const before = await snapshot();
  await expect(publishRelease(ctx, { releaseId: id })).rejects.toThrow(NotPublishableError);
  expect(await snapshot()).toEqual(before);
  const [rel] = await sql`select published_at, published_by, allow_stale from releases where id = ${id}`;
  expect(rel).toMatchObject({ published_at: null, published_by: null, allow_stale: false });
  for (const d of docs.filter((x) => x !== victim)) {
    const [row] = await sql`select state, is_head_draft, is_head_published from document_localized where doc_id = ${d.docId} and locale = 'de'`;
    expect(row).toMatchObject({ state: "DRAFT_HUMAN", is_head_draft: true, is_head_published: false });
  }
}));

test("publishRelease publishes localized and shared items with one stamp and marks the release", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const other = ctxFor(sql, "someone-else");
  const { id } = await createRelease(ctx, { name: "ok" });
  const a = await docWithSource(ctx, true);
  const b = await docWithSource(ctx, true);
  const { version: sv } = await saveDraft(ctx, { docId: a.docId, locale: "shared", data: { slug: "a-slug" } });
  await addToRelease(ctx, { releaseId: id, docId: a.docId, locale: "de", version: a.deVersion });
  await addToRelease(ctx, { releaseId: id, docId: a.docId, locale: "shared", version: sv });
  await addToRelease(other, { releaseId: id, docId: b.docId, locale: "de", version: b.deVersion });
  await publishRelease(ctx, { releaseId: id });
  const loc = await sql`select state, is_head_published, is_head_draft, published_by, published_at from document_localized where locale = 'de' order by doc_id`;
  expect(loc).toHaveLength(2);
  expect(loc.every((r) => r.state === "PUBLISHED" && r.is_head_published && !r.is_head_draft && r.published_by === "releaser")).toBe(true);
  const [sh] = await sql`select state, is_head_published, published_by, published_at from document_shared where doc_id = ${a.docId}`;
  expect(sh).toMatchObject({ state: "PUBLISHED", is_head_published: true, published_by: "releaser" });
  const [rel] = await sql`select published_at, published_by, allow_stale from releases where id = ${id}`;
  expect(rel).toMatchObject({ published_by: "releaser", allow_stale: false });
  const stamps = new Set([...loc.map((r) => (r.published_at as Date).getTime()), (sh!.published_at as Date).getTime(), (rel!.published_at as Date).getTime()]);
  expect(stamps.size).toBe(1);
  // second publish and empty release
  await expect(publishRelease(ctx, { releaseId: id })).rejects.toThrow(/already published/);
  const { id: empty } = await createRelease(ctx, { name: "empty" });
  await expect(publishRelease(ctx, { releaseId: empty })).rejects.toThrow(ValidationError);
  await expect(publishRelease(ctx, { releaseId: "424242" })).rejects.toThrow(NotFoundError);
}));

test("stale APPROVED item refuses the whole release and names it", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { id } = await createRelease(ctx, { name: "stale" });
  const fresh = await docWithSource(ctx, true);
  const stale = await docWithSource(ctx, true);
  // Make stale's de draft APPROVED, as approve would leave it.
  await sql`update document_localized set state = 'APPROVED' where doc_id = ${stale.docId} and locale = 'de'`;
  await addToRelease(ctx, { releaseId: id, docId: fresh.docId, locale: "de", version: fresh.deVersion });
  await addToRelease(ctx, { releaseId: id, docId: stale.docId, locale: "de", version: stale.deVersion });
  // Source moves on after the draft was written: title changes, body does not.
  await republishSource(ctx, stale.docId, { title: "T2", body: "B" });
  const before = await sql`select doc_id, locale, version, state, is_head_draft, is_head_published from document_localized order by doc_id, locale, version`;
  const err = await publishRelease(ctx, { releaseId: id }).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(StaleReleaseError);
  const e = err as StaleReleaseError & { items: Array<{ docId: string; locale: string; fields: string[] }> };
  expect(e.items).toEqual([{ docId: stale.docId, locale: "de", fields: ["title"] }]);
  expect(e.message).toContain(stale.docId);
  expect(e.message).toContain("de");
  expect(e.message).toContain("title");
  expect(e.message).not.toContain(fresh.docId);
  expect(await sql`select doc_id, locale, version, state, is_head_draft, is_head_published from document_localized order by doc_id, locale, version`).toEqual(before);
  const [rel] = await sql`select published_at, allow_stale from releases where id = ${id}`;
  expect(rel).toMatchObject({ published_at: null, allow_stale: false });
}));

test("a draft whose published head exists is judged by the draft, not the published head", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { docId, deVersion } = await docWithSource(ctx, true);
  await publish(ctx, { docId, locale: "de" }); // de published, current
  await republishSource(ctx, docId, { title: "T2", body: "B" }); // published de head is now stale on title
  // A fresh de draft written against the new source is current, so the release must go through.
  const { version } = await saveDraft(ctx, { docId, locale: "de", data: { title: "T2 de", body: "B de" } });
  expect(version).toBeGreaterThan(deVersion);
  const { id } = await createRelease(ctx, { name: "d" });
  await addToRelease(ctx, { releaseId: id, docId, locale: "de", version });
  await publishRelease(ctx, { releaseId: id });
  const [row] = await sql`select version, state from document_localized where doc_id = ${docId} and locale = 'de' and is_head_published`;
  expect(row).toMatchObject({ version, state: "PUBLISHED" });
}));

test("allowStale publishes and records allow_stale = true, including the non-stale items", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { id } = await createRelease(ctx, { name: "allow" });
  const fresh = await docWithSource(ctx, true);
  const stale = await docWithSource(ctx, true);
  await addToRelease(ctx, { releaseId: id, docId: fresh.docId, locale: "de", version: fresh.deVersion });
  await addToRelease(ctx, { releaseId: id, docId: stale.docId, locale: "de", version: stale.deVersion });
  await republishSource(ctx, stale.docId, { title: "T2", body: "B2" });
  await expect(publishRelease(ctx, { releaseId: id })).rejects.toThrow(StaleReleaseError);
  await publishRelease(ctx, { releaseId: id, allowStale: true });
  const rows = await sql`select doc_id, state, is_head_published from document_localized where locale = 'de'`;
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.state === "PUBLISHED" && r.is_head_published)).toBe(true);
  const [rel] = await sql`select allow_stale, published_at from releases where id = ${id}`;
  expect(rel!.allow_stale).toBe(true);
  expect(rel!.published_at).toBeInstanceOf(Date);
}));

test("a stale item lists every stale field name, sorted, across several items", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { id } = await createRelease(ctx, { name: "names" });
  const a = await docWithSource(ctx, true);
  const b = await docWithSource(ctx, true);
  await addToRelease(ctx, { releaseId: id, docId: a.docId, locale: "de", version: a.deVersion });
  await addToRelease(ctx, { releaseId: id, docId: b.docId, locale: "de", version: b.deVersion });
  await republishSource(ctx, a.docId, { title: "T2", body: "B2" });
  await republishSource(ctx, b.docId, { title: "T3", body: "B" });
  const err = await publishRelease(ctx, { releaseId: id }).then(() => undefined, (e: unknown) => e) as
    StaleReleaseError & { items: Array<{ docId: string; locale: string; fields: string[] }> };
  expect(err).toBeInstanceOf(StaleReleaseError);
  const byDoc = Object.fromEntries(err.items.map((i) => [i.docId, i.fields]));
  expect(byDoc).toEqual({ [a.docId]: ["body", "title"], [b.docId]: ["title"] });
  expect(err.items.every((i) => i.locale === "de")).toBe(true);
}));

test("publishRelease atomicity with one non-draft-head item among five", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { id } = await createRelease(ctx, { name: "five" });
  const docs = [];
  for (let i = 0; i < 5; i++) {
    const d = await docWithSource(ctx, true);
    docs.push(d);
    await addToRelease(ctx, { releaseId: id, docId: d.docId, locale: "de", version: d.deVersion });
  }
  // Item 4 is published out-of-band after being added: its version is no longer a draft head.
  await publish(ctx, { docId: docs[4]!.docId, locale: "de" });
  const before = await sql`select doc_id, locale, version, state, is_head_draft, is_head_published, published_at from document_localized order by doc_id, locale, version`;
  await expect(publishRelease(ctx, { releaseId: id })).rejects.toThrow(NotPublishableError);
  expect(await sql`select doc_id, locale, version, state, is_head_draft, is_head_published, published_at from document_localized order by doc_id, locale, version`).toEqual(before);
  const [rel] = await sql`select published_at from releases where id = ${id}`;
  expect(rel!.published_at).toBeNull();
}));

test("a DRAFT_AI item (superseded into DRAFT_AI after adding) makes the release fail", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { id } = await createRelease(ctx, { name: "ai" });
  const d = await docWithSource(ctx, true);
  await addToRelease(ctx, { releaseId: id, docId: d.docId, locale: "de", version: d.deVersion });
  await sql`update document_localized set state = 'DRAFT_AI' where doc_id = ${d.docId} and locale = 'de'`;
  await expect(publishRelease(ctx, { releaseId: id })).rejects.toThrow(NotPublishableError);
  const [row] = await sql`select state, is_head_draft, is_head_published from document_localized where doc_id = ${d.docId} and locale = 'de'`;
  expect(row).toMatchObject({ state: "DRAFT_AI", is_head_draft: true, is_head_published: false });
}));

const isDeadlock = (e: unknown) => (e as { code?: string })?.code === "40P01";

test("two overlapping releases published concurrently both complete without deadlock", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const sqlB = await extraConnection(sql);
  const ctxB = ctxFor(sqlB, "releaser-b");
  try {
    for (let round = 0; round < 20; round++) {
      const docs: Array<{ docId: string; deVersion: number }> = [];
      for (let i = 0; i < 6; i++) docs.push(await docWithSource(ctx, true));
      // Release A holds each doc's de draft; release B holds each doc's de-CH draft. Same documents, opposite order.
      const deCh: number[] = [];
      for (const d of docs) deCh.push((await saveDraft(ctx, { docId: d.docId, locale: "de-CH", data: { title: "T ch", body: "B ch" } })).version);
      const a = await createRelease(ctx, { name: `a${round}` });
      const b = await createRelease(ctx, { name: `b${round}` });
      for (const d of docs) await addToRelease(ctx, { releaseId: a.id, docId: d.docId, locale: "de", version: d.deVersion });
      for (let i = docs.length - 1; i >= 0; i--) await addToRelease(ctx, { releaseId: b.id, docId: docs[i]!.docId, locale: "de-CH", version: deCh[i]! });
      const results = await Promise.allSettled([
        publishRelease(ctx, { releaseId: a.id }),
        publishRelease(ctxB, { releaseId: b.id }),
      ]);
      for (const r of results) {
        if (r.status === "rejected") expect(isDeadlock(r.reason), String(r.reason)).toBe(false);
        expect(r.status).toBe("fulfilled");
      }
      const [{ n }] = (await sql`select count(*)::int as n from document_localized where is_head_published and locale in ('de', 'de-CH')`) as unknown as [{ n: number }];
      expect(n).toBe(12 * (round + 1));
    }
  } finally {
    await sqlB.end();
  }
}), 120_000);

test("overlapping releases on the same items: the loser sees the winner's committed state, never a deadlock", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const sqlB = await extraConnection(sql);
  const ctxB = ctxFor(sqlB, "releaser-b");
  try {
    for (let round = 0; round < 20; round++) {
      const docs: Array<{ docId: string; deVersion: number }> = [];
      for (let i = 0; i < 4; i++) docs.push(await docWithSource(ctx, true));
      const a = await createRelease(ctx, { name: `a${round}` });
      const b = await createRelease(ctx, { name: `b${round}` });
      for (const d of docs) await addToRelease(ctx, { releaseId: a.id, docId: d.docId, locale: "de", version: d.deVersion });
      for (const d of [...docs].reverse()) await addToRelease(ctx, { releaseId: b.id, docId: d.docId, locale: "de", version: d.deVersion });
      const results = await Promise.allSettled([
        publishRelease(ctx, { releaseId: a.id }),
        publishRelease(ctxB, { releaseId: b.id }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(isDeadlock(rejected[0]!.reason)).toBe(false);
      expect(rejected[0]!.reason).toBeInstanceOf(NotPublishableError);
      const published = await sql`select state, published_by from document_localized where locale = 'de' and doc_id = any(${docs.map((d) => d.docId)}::uuid[])`;
      expect(published).toHaveLength(4);
      expect(new Set(published.map((r) => r.published_by)).size).toBe(1);
      expect(published.every((r) => r.state === "PUBLISHED")).toBe(true);
    }
  } finally {
    await sqlB.end();
  }
}), 120_000);

test("the public API exposes the release and publish functions but not publishWithinTx", async () => {
  const api = await import("../src/index.js");
  expect("publishWithinTx" in api).toBe(false);
  expect("resolveLocale" in api).toBe(false);
  for (const name of ["publish", "unpublish", "createRelease", "addToRelease", "publishRelease"] as const) {
    expect(typeof api[name]).toBe("function");
  }
});

// ---- Stale check against the source as it WILL be after the flip (spec 8.1, ruling R14) ----

type StaleErr = StaleReleaseError & { items: Array<{ docId: string; locale: string; fields: string[] }> };
const stateOf = (rows: Awaited<ReturnType<typeof getSyncState>>) =>
  Object.fromEntries(rows.map((r) => [`${r.locale}.${r.field}`, r.state]));

/** docWithSource(de draft derived from en v1) + an en v2 DRAFT with `data`, both put in a new release. */
async function releaseWithNewSource(ctx: Ctx, data: Record<string, unknown>) {
  const { docId, deVersion } = await docWithSource(ctx, true);
  const { version: enVersion } = await saveDraft(ctx, { docId, locale: "en", data });
  const { id } = await createRelease(ctx, { name: "src+tgt" });
  await addToRelease(ctx, { releaseId: id, docId, locale: "en", version: enVersion });
  await addToRelease(ctx, { releaseId: id, docId, locale: "de", version: deVersion });
  return { docId, deVersion, enVersion, id };
}

test("a release with a new source item and a target derived from the old source is stale", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { docId, id } = await releaseWithNewSource(ctx, { title: "T2", body: "B" });
  const before = await sql`select doc_id, locale, version, state, is_head_draft, is_head_published from document_localized order by doc_id, locale, version`;
  const err = await publishRelease(ctx, { releaseId: id }).then(() => undefined, (e: unknown) => e) as StaleErr;
  expect(err).toBeInstanceOf(StaleReleaseError);
  expect(err.items).toEqual([{ docId, locale: "de", fields: ["title"] }]);
  expect(await sql`select doc_id, locale, version, state, is_head_draft, is_head_published from document_localized order by doc_id, locale, version`).toEqual(before);
  const [rel] = await sql`select published_at, allow_stale from releases where id = ${id}`;
  expect(rel).toMatchObject({ published_at: null, allow_stale: false });
}));

test("the same release publishes with allowStale and records allow_stale = true", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { docId, id } = await releaseWithNewSource(ctx, { title: "T2", body: "B" });
  await publishRelease(ctx, { releaseId: id, allowStale: true });
  const [rel] = await sql`select published_at, allow_stale from releases where id = ${id}`;
  expect(rel!.allow_stale).toBe(true);
  expect(rel!.published_at).toBeInstanceOf(Date);
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "stale", "de.body": "current" });
}));

test("a target carrying the new source's hashes publishes without StaleReleaseError and reads current", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { docId, deVersion, enVersion, id } = await releaseWithNewSource(ctx, { title: "T2", body: "B" });
  // Fixture: en v2 is only a draft here, so saveDraft(de) cannot stamp its hashes (it stamps the PUBLISHED
  // source). The de draft is made to be "translated against v2" by copying v2's self-hashes with direct SQL.
  await sql`update document_localized t set source_hashes = s.source_hashes
    from document_localized s
    where t.doc_id = ${docId} and t.locale = 'de' and t.version = ${deVersion}
      and s.doc_id = ${docId} and s.locale = 'en' and s.version = ${enVersion}`;
  await publishRelease(ctx, { releaseId: id });
  const [rel] = await sql`select allow_stale from releases where id = ${id}`;
  expect(rel!.allow_stale).toBe(false);
  expect(stateOf(await getSyncState(ctx, { docId, locale: "de" }))).toEqual({ "de.title": "current", "de.body": "current" });
}));

test("a release with only a target item is stale when the source moved after the target was drafted", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { docId, deVersion } = await docWithSource(ctx, true);
  const { id } = await createRelease(ctx, { name: "tgt-only" });
  await addToRelease(ctx, { releaseId: id, docId, locale: "de", version: deVersion });
  await republishSource(ctx, docId, { title: "T2", body: "B" });
  const err = await publishRelease(ctx, { releaseId: id }).then(() => undefined, (e: unknown) => e) as StaleErr;
  expect(err).toBeInstanceOf(StaleReleaseError);
  expect(err.items).toEqual([{ docId, locale: "de", fields: ["title"] }]);
}));

test("staleness against an in-release source item is per field: an untouched title is not reported", async () => withTestDb(async (sql) => {
  const ctx = await setup(sql);
  const { docId, id } = await releaseWithNewSource(ctx, { title: "T", body: "B2" });
  const err = await publishRelease(ctx, { releaseId: id }).then(() => undefined, (e: unknown) => e) as StaleErr;
  expect(err).toBeInstanceOf(StaleReleaseError);
  expect(err.items).toEqual([{ docId, locale: "de", fields: ["body"] }]);
}));
