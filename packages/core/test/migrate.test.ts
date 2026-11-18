import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { migrate } from "../src/migrate.js";
import { withTestDb } from "./db.js";

// Migration 0001 is FROZEN (v0.1 ship step 3, 2026-11-18). Any in-place edit fails this test; a schema change is a new
// migration (0002_*.sql). Line endings are normalized so a CRLF checkout of identical content passes (`.gitattributes`
// also forces LF for *.sql). The history gate scripts/check-0001-frozen.mjs closes the loophole of updating this hash in
// the same commit as the edit. Never "fix" a failure here by changing the hash: add 0002 instead.
const FROZEN_0001_SHA256 = "a77665b74dd46a6663ca87f96bff3eebd85ba5daae02d655b9db0d1c921fd338";

test("migration 0001 is frozen: its content never changes, schema changes go in a new migration", async () => {
  const body = (await readFile(new URL("../migrations/0001_engine.sql", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const actual = createHash("sha256").update(body).digest("hex");
  expect(
    actual,
    `0001_engine.sql is frozen (v0.1) but its content changed (sha256 ${actual}). Revert the edit and put the schema change in a new migration 0002_*.sql. Do not update the pinned hash.`,
  ).toBe(FROZEN_0001_SHA256);
});

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
