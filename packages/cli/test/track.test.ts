import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getSyncState, migrate } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { config, testDeps } from "./fixtures.js";

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mogging-cli-content-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * en and de imported while en is still a draft (so de records no source hashes), then published:
 * every de field is `untracked`.
 */
async function seedUntracked(sql: Sql): Promise<void> {
  const dir = tree({
    "en/docs/intro.md": "---\ntitle: Intro\n---\nHello\n",
    "de/docs/intro.md": "---\ntitle: Einleitung\n---\nHallo\n",
  });
  expect(await run(["import", dir], testDeps(sql))).toBe(0);
  expect(await run(["import", dir, "--publish"], testDeps(sql))).toBe(0);
}

async function states(sql: Sql): Promise<Record<string, string>> {
  const rows = await getSyncState({ sql, config, actor: "test" }, { collection: "docs", locale: "de" });
  return Object.fromEntries(rows.map((r) => [r.field, r.state]));
}

describe("mogging track", () => {
  test("tracks every untracked field and reports them; a second call says nothing is untracked", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      expect(await states(sql)).toEqual({ body: "untracked", title: "untracked" });

      const first = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de"], first)).toBe(0);
      expect(first.stdout()).toBe("tracked docs/intro de body\ntracked docs/intro de title\n");
      expect(await states(sql)).toEqual({ body: "current", title: "current" });

      const second = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de"], second)).toBe(0);
      expect(second.stdout()).toBe("nothing untracked for docs/intro (de)\n");
    });
  });

  test("--fields tracks only the named fields (split on commas and trimmed)", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      const t = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de", "--fields", " title "], t)).toBe(0);
      expect(t.stdout()).toBe("tracked docs/intro de title\n");
      expect(await states(sql)).toEqual({ body: "untracked", title: "current" });

      const rest = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de", "--fields", "body, title"], rest)).toBe(0);
      expect(rest.stdout()).toBe("tracked docs/intro de body\ntracked docs/intro de title\n");
      expect(await states(sql)).toEqual({ body: "current", title: "current" });
    });
  });

  test("--json data is null", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      const t = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de", "--json"], t)).toBe(0);
      const doc = JSON.parse(t.stdout()) as { ok: boolean; partial: boolean; data: unknown };
      expect(doc.ok).toBe(true);
      expect(doc.partial).toBe(false);
      expect(doc.data).toBeNull();

      const again = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de", "--json"], again)).toBe(0);
      expect((JSON.parse(again.stdout()) as { data: unknown }).data).toBeNull();
    });
  });

  test("an empty entry in --fields is a usage error and nothing is tracked", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      for (const fields of ["title,,body", "title,", ""]) {
        const t = testDeps(sql);
        expect(await run(["track", "docs/intro", "--locale", "de", "--fields", fields], t)).toBe(2);
        expect(t.stderr()).toContain("--fields");
      }
      expect(await states(sql)).toEqual({ body: "untracked", title: "untracked" });
    });
  });

  test("a missing --locale or target is a usage error", async () => {
    await withDb(async (sql) => {
      const noLocale = testDeps(sql);
      expect(await run(["track", "docs/intro"], noLocale)).toBe(2);
      expect(noLocale.stderr()).toContain("--locale");
      expect(await run(["track", "--locale", "de"], testDeps(sql))).toBe(2);
    });
  });

  test("an unknown document is exit 1 and the source locale is refused", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      const missing = testDeps(sql);
      expect(await run(["track", "docs/nope", "--locale", "de"], missing)).toBe(1);
      expect(missing.stderr()).toContain("not found");
      expect(await run(["track", "docs/intro", "--locale", "en"], testDeps(sql))).toBe(1);
    });
  });
});
