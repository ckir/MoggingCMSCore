import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { migrate } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { testDeps } from "./fixtures.js";

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mogging-cli-content-"));
  dirs.push(dir);
  return dir;
}
function tree(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const EN = "---\ntitle: Intro\n---\nHello **world**\n";
const DE = "---\ntitle: Einleitung\n---\nHallo\n";

/** Imports and publishes a two-locale tree. */
async function seed(sql: Sql): Promise<void> {
  const dir = tree({ "en/docs/intro.md": EN, "de/docs/intro.md": DE });
  expect(await run(["import", dir, "--publish"], testDeps(sql))).toBe(0);
}

describe("mogging export", () => {
  test("writes every published locale file and lists them", async () => {
    await withDb(async (sql) => {
      await seed(sql);
      const out = join(tempDir(), "out");
      const t = testDeps(sql);
      expect(await run(["export", out], t)).toBe(0);
      expect(t.stdout()).toBe("wrote de/docs/intro.md\nwrote en/docs/intro.md\n");
      expect(readFileSync(join(out, "en/docs/intro.md"), "utf8")).toContain("title: Intro");
      expect(readFileSync(join(out, "de/docs/intro.md"), "utf8")).toContain("title: Einleitung");
    });
  });

  test("--locale restricts the files written", async () => {
    await withDb(async (sql) => {
      await seed(sql);
      const out = tempDir();
      const t = testDeps(sql);
      expect(await run(["export", out, "--locale", "de"], t)).toBe(0);
      expect(t.stdout()).toBe("wrote de/docs/intro.md\n");
      expect(readdirSync(out)).toEqual(["de"]);
    });
  });

  test("--collection and a repeated --locale are accepted", async () => {
    await withDb(async (sql) => {
      await seed(sql);
      const out = tempDir();
      const t = testDeps(sql);
      expect(await run(["export", out, "--collection", "docs", "--locale", "de", "--locale", "en"], t)).toBe(0);
      expect(t.stdout()).toBe("wrote de/docs/intro.md\nwrote en/docs/intro.md\n");
    });
  });

  test("an undeclared collection is a usage error and nothing is written", async () => {
    await withDb(async (sql) => {
      await seed(sql);
      const out = tempDir();
      const t = testDeps(sql);
      expect(await run(["export", out, "--collection", "nope"], t)).toBe(2);
      expect(t.stderr()).toContain('unknown collection "nope"');
      expect(readdirSync(out)).toEqual([]);
    });
  });

  test("an undeclared locale is a usage error even when another one is declared", async () => {
    await withDb(async (sql) => {
      await seed(sql);
      const out = tempDir();
      const t = testDeps(sql);
      expect(await run(["export", out, "--locale", "de", "--locale", "xx"], t)).toBe(2);
      expect(t.stderr()).toContain('unknown locale "xx"');
      expect(readdirSync(out)).toEqual([]);
    });
  });

  test("the round trip export -> import reports unchanged for every file", async () => {
    await withDb(async (sql) => {
      await seed(sql);
      const out = tempDir();
      expect(await run(["export", out], testDeps(sql))).toBe(0);
      const again = testDeps(sql);
      expect(await run(["import", out], again)).toBe(0);
      expect(again.stdout()).toBe("unchanged de/docs/intro.md\nunchanged en/docs/intro.md\n");
    });
  });

  test("--json data is the report { files, warnings }", async () => {
    await withDb(async (sql) => {
      await seed(sql);
      const out = tempDir();
      const t = testDeps(sql);
      expect(await run(["export", out, "--json"], t)).toBe(0);
      const doc = JSON.parse(t.stdout()) as { ok: boolean; partial: boolean; data: unknown };
      expect(doc.ok).toBe(true);
      expect(doc.partial).toBe(false);
      expect(doc.data).toEqual({ files: ["de/docs/intro.md", "en/docs/intro.md"], warnings: [] });
    });
  });

  test("a document with no published slug is reported as a warning line", async () => {
    await withDb(async (sql) => {
      const dir = tree({ "en/docs/intro.md": EN });
      expect(await run(["import", dir], testDeps(sql))).toBe(0); // drafts only
      const out = tempDir();
      const t = testDeps(sql);
      expect(await run(["export", out], t)).toBe(0);
      expect(t.stdout()).toMatch(/^warning: docs\/[0-9a-f-]{36}: no published slug; skipped\n$/);
      expect(existsSync(join(out, "en"))).toBe(false);
    });
  });

  test("a relative directory resolves against the working directory", async () => {
    await withDb(async (sql) => {
      await seed(sql);
      const t = testDeps(sql);
      expect(await run(["export", "out"], t)).toBe(0);
      expect(existsSync(join(t.cwd, "out/en/docs/intro.md"))).toBe(true);
    });
  });

  test("a missing <dir> argument is a usage error", async () => {
    await withDb(async (sql) => {
      const t = testDeps(sql);
      expect(await run(["export"], t)).toBe(2);
      expect(t.stderr()).toContain("export: missing argument");
    });
  });
});
