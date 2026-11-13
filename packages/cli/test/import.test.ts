import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getDocument, migrate } from "@mogging/core";
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
const ctxOf = (sql: Sql) => ({ sql, config, actor: "test" });

describe("mogging import", () => {
  test("imports a two-locale tree as drafts and prints one line per file", async () => {
    await withDb(async (sql) => {
      const dir = tree({ "en/docs/intro.md": EN, "de/docs/intro.md": DE });
      const t = testDeps(sql);
      expect(await run(["import", dir], t)).toBe(0);
      expect(t.stdout()).toBe("updated de/docs/intro.md\ncreated en/docs/intro.md\n");
      const doc = (await getDocument(ctxOf(sql), { collection: "docs", slug: "intro" }))!;
      expect(doc.shared.draft).not.toBeNull();
      expect(doc.shared.published).toBeNull();
      expect(doc.locales["de"]!.draft!.data["title"]).toBe("Einleitung");
      expect(doc.locales["en"]!.draft!.data["title"]).toBe("Intro");
    });
  });

  test("--publish publishes the heads and a second run reports unchanged", async () => {
    await withDb(async (sql) => {
      const dir = tree({ "en/docs/intro.md": EN, "de/docs/intro.md": DE });
      expect(await run(["import", dir, "--publish"], testDeps(sql))).toBe(0);
      const doc = (await getDocument(ctxOf(sql), { collection: "docs", slug: "intro" }))!;
      expect(doc.shared.published).not.toBeNull();
      expect(doc.locales["en"]!.published!.data["title"]).toBe("Intro");
      expect(doc.locales["de"]!.published!.data["title"]).toBe("Einleitung");

      const again = testDeps(sql);
      expect(await run(["import", dir, "--publish"], again)).toBe(0);
      expect(again.stdout()).toBe("unchanged de/docs/intro.md\nunchanged en/docs/intro.md\n");
    });
  });

  test("a file with an undeclared front-matter key exits 4 and the other files still import", async () => {
    await withDb(async (sql) => {
      const dir = tree({
        "en/docs/intro.md": EN,
        "en/docs/other.md": "---\ntitle: Other\n---\nx\n",
        "en/docs/bad.md": "---\ntitle: Bad\nbogus: 1\n---\nx\n",
      });
      const t = testDeps(sql);
      expect(await run(["import", dir], t)).toBe(4);
      expect(t.stdout()).toBe(
        [
          "error en/docs/bad.md",
          "created en/docs/intro.md",
          "created en/docs/other.md",
          "error: en/docs/bad.md: bogus: undeclared field",
          "",
        ].join("\n"),
      );
      const ctx = ctxOf(sql);
      expect(await getDocument(ctx, { collection: "docs", slug: "intro" })).not.toBeNull();
      expect(await getDocument(ctx, { collection: "docs", slug: "other" })).not.toBeNull();
      expect(await getDocument(ctx, { collection: "docs", slug: "bad" })).toBeNull();
    });
  });

  test("--json on a partial failure is ok with partial true and data is the report", async () => {
    await withDb(async (sql) => {
      const dir = tree({ "en/docs/intro.md": EN, "en/docs/bad.md": "---\nbogus: 1\n---\nx\n" });
      const t = testDeps(sql);
      expect(await run(["import", dir, "--json"], t)).toBe(4);
      const doc = JSON.parse(t.stdout()) as {
        ok: boolean; partial: boolean;
        data: { files: Array<{ file: string; outcome: string }>; warnings: unknown[]; errors: Array<{ file: string }> };
      };
      expect(doc.ok).toBe(true);
      expect(doc.partial).toBe(true);
      expect(doc.data.files.map((f) => `${f.outcome} ${f.file}`)).toEqual(["error en/docs/bad.md", "created en/docs/intro.md"]);
      expect(doc.data.errors.map((e) => e.file)).toEqual(["en/docs/bad.md"]);
      expect(doc.data.warnings).toEqual([]);
    });
  });

  test("when every file fails the exit code is 1 and the error is on stderr", async () => {
    await withDb(async (sql) => {
      const dir = tree({ "en/docs/bad.md": "---\nbogus: 1\n---\nx\n" });
      const t = testDeps(sql);
      expect(await run(["import", dir, "--json"], t)).toBe(1);
      const doc = JSON.parse(t.stdout()) as { ok: boolean; partial: boolean; error: { code: string; message: string } };
      expect(doc.ok).toBe(false);
      expect(doc.partial).toBe(false);
      expect(doc.error.message).not.toBe("");
      expect(t.stderr()).toMatch(/^error: .+/m);
    });
  });

  test("warnings are printed after the file lines", async () => {
    await withDb(async (sql) => {
      const dir = tree({ "en/docs/intro.md": EN, "notes.txt": "x" });
      const t = testDeps(sql);
      expect(await run(["import", dir], t)).toBe(0);
      expect(t.stdout()).toBe(
        "created en/docs/intro.md\nwarning: notes.txt: file outside a <locale>/<collection> directory; skipped\n",
      );
    });
  });

  test("a relative directory resolves against the working directory", async () => {
    await withDb(async (sql) => {
      const t = testDeps(sql);
      mkdirSync(join(t.cwd, "content/en/docs"), { recursive: true });
      writeFileSync(join(t.cwd, "content/en/docs/intro.md"), EN);
      expect(await run(["import", "content"], t)).toBe(0);
      expect(t.stdout()).toBe("created en/docs/intro.md\n");
    });
  });

  test("a missing <dir> argument is a usage error", async () => {
    await withDb(async (sql) => {
      const t = testDeps(sql);
      expect(await run(["import"], t)).toBe(2);
      expect(t.stderr()).toContain("import: missing argument");
      expect(t.stdout()).toBe("");
    });
  });
});
