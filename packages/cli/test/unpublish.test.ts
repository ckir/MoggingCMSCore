import { describe, expect, test } from "vitest";
import { migrate } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { DAY, publishedDoc, setFirstMigration, testDeps } from "./fixtures.js";

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

async function cli(sql: Sql, ...args: string[]) {
  const t = testDeps(sql);
  const code = await run(args, t);
  return { code, out: t.stdout(), err: t.stderr() };
}

const publishedLocales = async (sql: Sql) =>
  (await sql`select locale from document_localized where is_head_published order by locale`).map((r) => r.locale);

describe("mogging unpublish", () => {
  test("clears the published head of the locale and leaves the others", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      const r = await cli(sql, "unpublish", "docs/intro", "--locale", "en");
      expect(r).toMatchObject({ code: 0, out: "unpublished docs/intro en\n" });
      expect(await publishedLocales(sql)).toEqual([]);
      const [shared] = await sql`select is_head_published from document_shared`;
      expect(shared!.is_head_published).toBe(true);
    });
  });

  test("shared is allowed", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      const r = await cli(sql, "unpublish", "docs/intro", "--locale", "shared");
      expect(r).toMatchObject({ code: 0, out: "unpublished docs/intro shared\n" });
      const [shared] = await sql`select is_head_published from document_shared`;
      expect(shared!.is_head_published).toBe(false);
      expect(await publishedLocales(sql)).toEqual(["en"]);
    });
  });

  test("unpublishing what is not published says so and exits 0", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      expect((await cli(sql, "unpublish", "docs/intro", "--locale", "de")).out).toBe("not published docs/intro de\n");
      expect((await cli(sql, "unpublish", "docs/intro", "--locale", "en")).code).toBe(0);
      const again = await cli(sql, "unpublish", "docs/intro", "--locale", "en");
      expect(again).toMatchObject({ code: 0, out: "not published docs/intro en\n" });
    });
  });

  test("--json data is { items } with the outcome word", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      const r = await cli(sql, "unpublish", "docs/intro", "--locale", "en", "--json");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({
        ok: true,
        partial: false,
        data: { items: [{ target: "docs/intro", locale: "en", outcome: "unpublished" }] },
      });
    });
  });

  test("is not licence-guarded: it works after the evaluation window", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      await setFirstMigration(sql, new Date(Date.now() - 31 * DAY));
      const r = await cli(sql, "unpublish", "docs/intro", "--locale", "en");
      expect(r.code).toBe(0);
      expect(await publishedLocales(sql)).toEqual([]);
    });
  });

  test("a missing --locale or target is a usage error and nothing is unpublished", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      const noLocale = await cli(sql, "unpublish", "docs/intro");
      expect(noLocale.code).toBe(2);
      expect(noLocale.err).toContain("--locale");
      expect(noLocale.err).not.toContain("unknown command");
      const noTarget = await cli(sql, "unpublish", "--locale", "en");
      expect(noTarget.code).toBe(2);
      expect(noTarget.err).toContain("missing argument");
      expect(await publishedLocales(sql)).toEqual(["en"]);
    });
  });

  test("an undeclared locale and an unknown document are exit 1", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      const locale = await cli(sql, "unpublish", "docs/intro", "--locale", "xx");
      expect(locale.code).toBe(1);
      expect(locale.err).toContain('Locale "xx" is not declared in the config');
      const missing = await cli(sql, "unpublish", "docs/nope", "--locale", "en");
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("not found");
    });
  });
});
