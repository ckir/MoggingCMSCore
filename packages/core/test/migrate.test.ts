import { expect, test } from "vitest";
import { migrate } from "../src/migrate.js";
import { withTestDb } from "./db.js";

test("migrate applies 0001 once and is idempotent", async () => withTestDb(async (sql) => {
  expect(await migrate(sql)).toEqual(["0001_engine.sql"]);
  expect(await migrate(sql)).toEqual([]);
  const tables = await sql`select tablename from pg_tables where schemaname = current_schema() order by 1`;
  expect(tables.map(t => t.tablename)).toEqual(["ai_budgets","ai_jobs","content_provenance","document_localized","document_shared","documents","glossary","migrations","release_items","releases"]);
}));

test("second published head for a (doc, locale) is rejected by the index", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const [d] = await sql`insert into documents (collection, created_by) values ('posts', 't') returning id`;
  await sql`insert into document_localized (doc_id, locale, version, state, is_head_published, created_by)
            values (${d!.id}, 'en', 1, 'PUBLISHED', true, 't')`;
  await expect(sql`insert into document_localized (doc_id, locale, version, state, is_head_published, created_by)
            values (${d!.id}, 'en', 2, 'PUBLISHED', true, 't')`).rejects.toMatchObject({ code: "23505" });
}));

test("second draft head per (doc, locale) and per shared doc is rejected", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const [d] = await sql`insert into documents (collection, created_by) values ('posts', 't') returning id`;
  await sql`insert into document_localized (doc_id, locale, version, state, is_head_draft, created_by)
            values (${d!.id}, 'de', 1, 'DRAFT_HUMAN', true, 't')`;
  await expect(sql`insert into document_localized (doc_id, locale, version, state, is_head_draft, created_by)
            values (${d!.id}, 'de', 2, 'DRAFT_HUMAN', true, 't')`).rejects.toMatchObject({ code: "23505" });
  await sql`insert into document_shared (doc_id, version, state, is_head_published, created_by)
            values (${d!.id}, 1, 'PUBLISHED', true, 't')`;
  await expect(sql`insert into document_shared (doc_id, version, state, is_head_published, created_by)
            values (${d!.id}, 2, 'PUBLISHED', true, 't')`).rejects.toMatchObject({ code: "23505" });
}));

test("document_localized state accepts APPROVED and rejects unknown states", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const [d] = await sql`insert into documents (collection, created_by) values ('posts', 't') returning id`;
  await sql`insert into document_localized (doc_id, locale, version, state, created_by) values (${d!.id}, 'de', 1, 'APPROVED', 't')`;
  await expect(sql`insert into document_localized (doc_id, locale, version, state, created_by) values (${d!.id}, 'de', 2, 'BOGUS', 't')`)
    .rejects.toMatchObject({ code: "23514" });
}));
