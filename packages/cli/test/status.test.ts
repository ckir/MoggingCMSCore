import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defineCollection, defineConfig, migrate, richText, slug, text } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { ai, docs, testDeps } from "./fixtures.js";

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

const posts = defineCollection("posts", {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
});
const twoCollections = defineConfig({
  collections: [docs, posts],
  locales: { source: "en", chains: { de: ["en"], fr: ["en"] } },
});

const EN = "---\ntitle: Intro\n---\nHello\n";
const DE = "---\ntitle: Einleitung\n---\nHallo\n";

async function importTree(sql: Sql, dir: string, ...args: string[]): Promise<void> {
  const t = testDeps(sql, { loadModule: async () => ({ config: twoCollections, ai }) });
  expect(await run(["import", dir, ...args], t)).toBe(0);
}

async function status(sql: Sql, ...args: string[]) {
  const t = testDeps(sql, { loadModule: async () => ({ config: twoCollections, ai }) });
  const code = await run(["status", ...args], t);
  return { code, out: t.stdout(), err: t.stderr() };
}

describe("mogging status", () => {
  test("after importing en only, de shows missing for the translated fields", async () => {
    await withDb(async (sql) => {
      await importTree(sql, tree({ "en/docs/intro.md": EN }), "--publish");
      const r = await status(sql, "--locale", "de");
      expect(r.code).toBe(0);
      expect(r.out).toBe(["de: 2 missing", "docs/intro body missing", "docs/intro title missing", ""].join("\n"));
    });
  });

  test("a published de draft, then an edited English source: exactly one stale row", async () => {
    await withDb(async (sql) => {
      await importTree(sql, tree({ "en/docs/intro.md": EN, "de/docs/intro.md": DE }), "--publish");
      const before = await status(sql, "--locale", "de");
      expect(before.out).toBe("de: 2 current\n");

      await importTree(sql, tree({ "en/docs/intro.md": "---\ntitle: Intro, revised\n---\nHello\n" }), "--publish");
      const after = await status(sql, "--locale", "de");
      expect(after.code).toBe(0);
      expect(after.out).toBe(["de: 1 current", "de: 1 stale", "docs/intro title stale", ""].join("\n"));
      expect(after.out).not.toContain("run:");
    });
  });

  test("every declared target locale is reported, one count line per state present", async () => {
    await withDb(async (sql) => {
      await importTree(sql, tree({ "en/docs/intro.md": EN, "de/docs/intro.md": DE }), "--publish");
      const r = await status(sql);
      expect(r.out).toBe(
        ["de: 2 current", "fr: 2 missing", "docs/intro body missing", "docs/intro title missing", ""].join("\n"),
      );
    });
  });

  test("untracked fields end the output with one run: mogging track line per document and locale", async () => {
    await withDb(async (sql) => {
      const dir = tree({ "en/docs/intro.md": EN, "de/docs/intro.md": DE });
      // de is saved while en is still a draft, so it records no source hashes; publishing then leaves it untracked.
      await importTree(sql, dir);
      await importTree(sql, dir, "--publish");
      const r = await status(sql, "--locale", "de");
      expect(r.out).toBe(
        [
          "de: 2 untracked",
          "docs/intro body untracked",
          "docs/intro title untracked",
          "run: mogging track docs/intro --locale de --fields body,title",
          "",
        ].join("\n"),
      );
    });
  });

  test("the positional collection limits the report and an unknown one is a usage error", async () => {
    await withDb(async (sql) => {
      await importTree(
        sql,
        tree({ "en/docs/intro.md": EN, "en/posts/hello.md": "---\ntitle: Hello\n---\nBody\n" }),
        "--publish",
      );
      const all = await status(sql, "--locale", "de");
      expect(all.out).toBe(
        [
          "de: 4 missing",
          "docs/intro body missing",
          "docs/intro title missing",
          "posts/hello body missing",
          "posts/hello title missing",
          "",
        ].join("\n"),
      );
      const only = await status(sql, "posts", "--locale", "de");
      expect(only.out).toBe(
        ["de: 2 missing", "posts/hello body missing", "posts/hello title missing", ""].join("\n"),
      );

      const bad = await status(sql, "nope");
      expect(bad.code).toBe(2);
      expect(bad.err).toContain('unknown collection "nope"');
      expect(bad.out).toBe("");
    });
  });

  test("--json data is { rows } sorted by collection, document, locale and field, with the slug", async () => {
    await withDb(async (sql) => {
      await importTree(
        sql,
        tree({
          "en/posts/hello.md": "---\ntitle: Hello\n---\nBody\n",
          "en/docs/b.md": EN,
          "en/docs/a.md": EN,
        }),
        "--publish",
      );
      const r = await status(sql, "--json");
      const doc = JSON.parse(r.out) as {
        ok: boolean; data: { rows: Array<{ collection: string; slug: string | null; docId: string; locale: string; field: string; state: string; sourceVersion: number }> };
      };
      expect(doc.ok).toBe(true);
      expect(Object.keys(doc.data)).toEqual(["rows"]);
      expect(doc.data.rows.map((x) => `${x.collection}/${x.slug} ${x.locale} ${x.field} ${x.state}`)).toEqual([
        "docs/a de body missing",
        "docs/a de title missing",
        "docs/a fr body missing",
        "docs/a fr title missing",
        "docs/b de body missing",
        "docs/b de title missing",
        "docs/b fr body missing",
        "docs/b fr title missing",
        "posts/hello de body missing",
        "posts/hello de title missing",
        "posts/hello fr body missing",
        "posts/hello fr title missing",
      ]);
      const first = doc.data.rows[0]!;
      expect(Object.keys(first).sort()).toEqual(["collection", "docId", "field", "locale", "slug", "sourceVersion", "state"]);
      expect(first.docId).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.sourceVersion).toBeGreaterThan(0);
    });
  });

  test("the slug labels survive more than one page of documents", async () => {
    await withDb(async (sql) => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 205; i++) files[`en/posts/p${String(i).padStart(3, "0")}.md`] = "---\ntitle: T\n---\nB\n";
      await importTree(sql, tree(files), "--publish");
      const r = await status(sql, "posts", "--locale", "de", "--json");
      const rows = (JSON.parse(r.out) as { data: { rows: Array<{ slug: string | null }> } }).data.rows;
      expect(rows).toHaveLength(410); // body and title per document
      expect(rows.filter((x) => x.slug === null)).toEqual([]);
      expect(new Set(rows.map((x) => x.slug)).size).toBe(205);
    });
  }, 60_000);

  test("an undeclared or source --locale is refused", async () => {
    await withDb(async (sql) => {
      await importTree(sql, tree({ "en/docs/intro.md": EN }), "--publish");
      expect((await status(sql, "--locale", "en")).code).toBe(1);
      expect((await status(sql, "--locale", "xx")).code).toBe(1);
    });
  });

  test("more than one positional is a usage error", async () => {
    await withDb(async (sql) => {
      expect((await status(sql, "docs", "posts")).code).toBe(2);
    });
  });
});
