import { describe, expect, test } from "vitest";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { testDeps } from "./fixtures.js";

describe("mogging migrate", () => {
  test("migrate applies 0001 once and reports [] the second time", async () => {
    await withTestDb(async (sql) => {
      const first = testDeps(sql);
      expect(await run(["migrate"], first)).toBe(0);
      const names = (await sql`select name from migrations order by name`).map((r) => r.name as string);
      expect(names[0]).toMatch(/^0001/);
      for (const name of names) expect(first.stdout()).toContain(name);

      const second = testDeps(sql);
      expect(await run(["migrate"], second)).toBe(0);
      expect(second.stdout()).toBe("database is up to date\n");
      expect((await sql`select count(*)::int as n from migrations`)[0]!.n).toBe(names.length);
    });
  });

  test("migrate --json data is { applied }", async () => {
    await withTestDb(async (sql) => {
      const first = testDeps(sql);
      expect(await run(["migrate", "--json"], first)).toBe(0);
      const names = (await sql`select name from migrations order by name`).map((r) => r.name as string);
      const doc = JSON.parse(first.stdout()) as { ok: boolean; data: unknown; licence: { state: string } };
      expect(doc.ok).toBe(true);
      expect(doc.data).toEqual({ applied: names });
      expect(doc.licence.state).toBe("evaluation");

      const second = testDeps(sql);
      expect(await run(["migrate", "--json"], second)).toBe(0);
      expect((JSON.parse(second.stdout()) as { data: unknown }).data).toEqual({ applied: [] });
    });
  });
});
