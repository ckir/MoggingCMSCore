import { expect, test } from "vitest";
import type { LanguageModel } from "ai";
import { migrate } from "@mogging/core";
import { listGlossary, upsertGlossary } from "../src/glossary.js";
import { ctxFor } from "./fixtures.js";
import { withTestDb } from "./db.js";

const model = {} as unknown as LanguageModel;

const entry = (over: Record<string, unknown> = {}) => ({
  sourceLocale: "en", targetLocale: "de", term: "widget", translation: "Gerät" as string | null,
  acceptedForms: [] as string[], doNotTranslate: false, note: null as string | null, ...over,
});

test("upsert twice updates the translation and records the actor", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, model);
  expect(await upsertGlossary({ ...ctx, actor: "alice" }, [entry()])).toEqual({ upserted: 1 });
  const [first] = await sql`select updated_by from glossary`;
  expect(first!.updated_by).toBe("alice");
  expect(await upsertGlossary({ ...ctx, actor: "bob" }, [entry({ translation: "Widget", acceptedForms: ["Widgets"], note: "n" })]))
    .toEqual({ upserted: 1 });
  const rows = await sql`select * from glossary`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ term: "widget", translation: "Widget", accepted_forms: ["Widgets"], note: "n", updated_by: "bob" });
}));

test("updated_at moves forward on update", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, model);
  await upsertGlossary(ctx, [entry()]);
  // Compared in SQL at microsecond precision: a JS Date truncates to milliseconds, and both writes can share one.
  const [a] = await sql`select updated_at::text as t from glossary`;
  await upsertGlossary(ctx, [entry({ translation: "X" })]);
  const [b] = await sql`select updated_at > ${a!.t as string}::timestamptz as moved from glossary`;
  expect(b!.moved).toBe(true);
}));

test("listGlossary filters by locale pair and normalizes DE to de", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, model);
  await upsertGlossary(ctx, [
    entry({ term: "a" }),
    entry({ term: "b", targetLocale: "fr" }),
    entry({ term: "c", sourceLocale: "de", targetLocale: "en" }),
    entry({ term: "d", targetLocale: "DE", doNotTranslate: true, translation: null }),
  ]);
  const stored = await sql`select source_locale, target_locale from glossary where term = 'd'`;
  expect(stored[0]).toMatchObject({ source_locale: "en", target_locale: "de" });
  const got = await listGlossary(ctx, { sourceLocale: "EN", targetLocale: "DE" });
  expect(got.map((g) => g.term)).toEqual(["a", "d"]);
  expect(got[1]).toEqual({
    sourceLocale: "en", targetLocale: "de", term: "d", translation: null, acceptedForms: [], doNotTranslate: true, note: null,
  });
}));

test("an empty list upserts nothing", async () => withTestDb(async (sql) => {
  await migrate(sql);
  expect(await upsertGlossary(ctxFor(sql, model), [])).toEqual({ upserted: 0 });
}));
