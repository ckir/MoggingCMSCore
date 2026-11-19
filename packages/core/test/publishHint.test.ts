import { expect, test } from "vitest";
import type { Sql } from "postgres";
import postgres from "postgres";
import {
  ValidationError, createDocument, defineCollection, defineConfig, migrate, publish, richText, saveDraft, slug, text,
} from "../src/index.js";
import type { Ctx } from "../src/index.js";
import { publishWithinTx } from "../src/documents/publishCore.js";
import { withTestDb } from "./db.js";

const posts = defineCollection("posts", { slug: slug(), body: richText({ localized: true, body: true }) });
const pages = defineCollection("pages", { slug: slug(), body: richText({ localized: true, body: true }) });
// A collection whose shared `code` field is required: neither `posts` nor `pages` requires anything.
const strict = defineCollection("strict", { slug: slug(), code: text({ required: true }), body: richText({ localized: true, body: true }) });
const config = defineConfig({
  collections: [posts, pages, strict],
  locales: { source: "en", chains: { de: ["en"] } },
});
const ctxFor = (sql: Sql): Ctx => ({ sql, config, actor: "tester" });
const CLASH = (s: string, c: string) => `Slug "${s}" is already used by another document in collection "${c}"`;

/** Inserts a document and a shared DRAFT_HUMAN head with raw SQL, as if saved before the guard existed. */
async function rawDraft(sql: Sql, docId: string, collection: string, value: string): Promise<void> {
  await sql`insert into documents (id, collection, created_by) values (${docId}, ${collection}, 'fixture')`;
  await sql`insert into document_shared (doc_id, version, state, data, is_head_draft, created_by)
    values (${docId}, 1, 'DRAFT_HUMAN', ${sql.json({ slug: value })}, true, 'fixture')`;
}

const D2 = "00000001-0000-4000-8000-000000000002";
const D3 = "00000001-0000-4000-8000-000000000003";
const D4 = "00000001-0000-4000-8000-000000000004";

/** A connection on the test schema that records every statement text with its bound parameters. */
async function recordingConnection(sql: Sql, log: Array<{ text: string; params: unknown[] }>): Promise<Sql> {
  const [{ s }] = (await sql`select current_schema() as s`) as unknown as [{ s: string }];
  return postgres(process.env.DATABASE_URL!, {
    max: 1, onnotice: () => {}, connection: { search_path: s },
    debug: (_conn, text, params) => { log.push({ text, params: params as unknown[] }); },
  });
}

test("a hinted shared publish still refuses a slug another document of that collection holds", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const d1 = (await createDocument(ctx, { collection: "posts" })).id;
  await saveDraft(ctx, { docId: d1, locale: "shared", data: { slug: "taken" } });
  await publish(ctx, { docId: d1, locale: "shared" });
  await rawDraft(sql, D2, "posts", "taken");

  const err = await sql.begin(async (tx) => {
    await tx`select id from documents where id = ${D2} for update`;
    await publishWithinTx(tx, ctx, { docId: D2, locale: "shared" }, new Date().toISOString(), { collection: "posts" });
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).toMatch(/already used by another document/);
  expect((err as Error).message).toBe(CLASH("taken", "posts"));
  const [row] = await sql`select state, is_head_draft, is_head_published from document_shared where doc_id = ${D2}`;
  expect(row).toMatchObject({ state: "DRAFT_HUMAN", is_head_draft: true, is_head_published: false });
}));

test("the hint replaces the documents row's collection for the slug check", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const d1 = (await createDocument(ctx, { collection: "posts" })).id;
  await saveDraft(ctx, { docId: d1, locale: "shared", data: { slug: "taken" } });
  await publish(ctx, { docId: d1, locale: "shared" });
  // The row says "pages", where the slug is free; the hint names "posts", where it is held.
  await rawDraft(sql, D3, "pages", "taken");

  const err = await sql.begin(async (tx) => {
    await tx`select id from documents where id = ${D3} for update`;
    await publishWithinTx(tx, ctx, { docId: D3, locale: "shared" }, new Date().toISOString(), { collection: "posts" });
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).toBe(CLASH("taken", "posts"));

  // Without a hint the row's own collection decides, as before: the publish succeeds.
  await sql.begin(async (tx) => {
    await tx`select id from documents where id = ${D3} for update`;
    await publishWithinTx(tx, ctx, { docId: D3, locale: "shared" }, new Date().toISOString());
  });
  const [row] = await sql`select state, is_head_published from document_shared where doc_id = ${D3}`;
  expect(row).toMatchObject({ state: "PUBLISHED", is_head_published: true });
}));

test("a hinted shared publish takes the advisory slug lock on the hinted collection and skips the collection read", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  await rawDraft(sql, D2, "pages", "free");
  const log: Array<{ text: string; params: unknown[] }> = [];
  const rec = await recordingConnection(sql, log);
  try {
    await rec.begin(async (tx) => {
      await tx`select id from documents where id = ${D2} for update`;
      await publishWithinTx(tx, ctx, { docId: D2, locale: "shared" }, new Date().toISOString(), { collection: "posts" });
    });
  } finally {
    await rec.end();
  }
  const locks = log.filter((q) => q.text.includes("pg_advisory_xact_lock"));
  expect(locks).toHaveLength(1);
  expect(locks[0]!.params).toContain("posts");
  expect(log.some((q) => /select collection from documents/.test(q.text))).toBe(false);
}));

test("the required-field check is keyed on the hinted collection, not the documents row's", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const stamp = () => new Date().toISOString();

  // The row says "posts" (nothing required), the hint says "strict" (shared `code` required): the draft lacks `code`.
  await rawDraft(sql, D2, "posts", "no-code");
  const err = await sql.begin(async (tx) => {
    await tx`select id from documents where id = ${D2} for update`;
    await publishWithinTx(tx, ctx, { docId: D2, locale: "shared" }, stamp(), { collection: "strict" });
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).toMatch(/missing required field code/);
  const [kept] = await sql`select state, is_head_draft, is_head_published from document_shared where doc_id = ${D2}`;
  expect(kept).toMatchObject({ state: "DRAFT_HUMAN", is_head_draft: true, is_head_published: false });

  // The reverse: the row says "strict" (would refuse), the hint says "posts" (requires nothing): the publish succeeds.
  await rawDraft(sql, D4, "strict", "no-code-either");
  await sql.begin(async (tx) => {
    await tx`select id from documents where id = ${D4} for update`;
    await publishWithinTx(tx, ctx, { docId: D4, locale: "shared" }, stamp(), { collection: "posts" });
  });
  const [done] = await sql`select state, is_head_published from document_shared where doc_id = ${D4}`;
  expect(done).toMatchObject({ state: "PUBLISHED", is_head_published: true });
}));
