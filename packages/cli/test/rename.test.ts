import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getDocument, migrate } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { testDeps } from "./fixtures.js";
import { page, starlightConfig, starlightDeps, starlightProject } from "./starlightFixtures.js";

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

const D = "src/content/docs";

/** Runs the CLI over a Starlight project and returns the exit code and both streams. */
async function go(sql: Sql, root: string, args: string[]) {
  const t = starlightDeps(sql, root);
  const code = await run(args, t);
  return { code, out: t.stdout(), err: t.stderr() };
}

const lines = (out: string): string[] => out.split("\n").filter((l) => l !== "");
const ctxOf = (sql: Sql) => ({ sql, config: starlightConfig, actor: "test" });

const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("mogging rename", () => {
  test("rename moves the English and German files and the slug", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({
        [`${D}/guides/a.md`]: page("Intro"),
        [`${D}/de/guides/a.md`]: page("Einleitung"),
      });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      const r = await go(sql, root, ["rename", "guides/a", "guides/b"]);
      expect(r.code).toBe(0);
      expect(existsSync(join(root, D, "guides/b.md"))).toBe(true);
      expect(existsSync(join(root, D, "de/guides/b.md"))).toBe(true);
      expect(existsSync(join(root, D, "guides/a.md"))).toBe(false);
      expect(existsSync(join(root, D, "de/guides/a.md"))).toBe(false);
      expect(lines(r.out)).toContain(`move ${D}/guides/a.md -> ${D}/guides/b.md`);
      expect(await getDocument(ctxOf(sql), { collection: "docs", slug: "guides/b" })).not.toBeNull();
    });
  });

  test("references in astro.config and in Markdown under the docs folder are listed", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({
        [`${D}/guides/a.md`]: page("Intro"),
        [`${D}/other.md`]: page("Other", "", "See [the guide](/guides/a/) for more."),
        "astro.config.mjs": "export default { sidebar: [{ slug: 'guides/a' }] };\n",
      });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      const r = await go(sql, root, ["rename", "guides/a", "guides/b"]);
      expect(r.code).toBe(0);
      const out = lines(r.out);
      expect(out.some((l) => l.startsWith("reference astro.config.mjs:"))).toBe(true);
      expect(out.some((l) => l.startsWith(`reference ${D}/other.md:`))).toBe(true);
      expect(out[out.length - 1]).toContain("redirect");
    });
  });

  test("--dry-run moves nothing and saves nothing", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({
        [`${D}/guides/a.md`]: page("Intro"),
        [`${D}/de/guides/a.md`]: page("Einleitung"),
      });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      const r = await go(sql, root, ["rename", "guides/a", "guides/b", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(lines(r.out)[0]).toBe("dry run: nothing was written");
      expect(r.out).toContain(`move ${D}/guides/a.md -> ${D}/guides/b.md`);
      expect(existsSync(join(root, D, "guides/a.md"))).toBe(true);
      expect(existsSync(join(root, D, "de/guides/a.md"))).toBe(true);
      expect(existsSync(join(root, D, "guides/b.md"))).toBe(false);
      expect(existsSync(join(root, D, "de/guides/b.md"))).toBe(false);
      expect(await getDocument(ctxOf(sql), { collection: "docs", slug: "guides/b" })).toBeNull();
      expect(await getDocument(ctxOf(sql), { collection: "docs", slug: "guides/a" })).not.toBeNull();
    });
  });

  test("a differing target is exit 1 naming both files", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/guides/a.md`]: page("Intro") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      write(root, `${D}/guides/b.md`, page("Something else", "", "Different"));
      const r = await go(sql, root, ["rename", "guides/a", "guides/b"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${D}/guides/a.md`);
      expect(r.err).toContain(`${D}/guides/b.md`);
      expect(readFileSync(join(root, D, "guides/a.md"), "utf8")).toBe(page("Intro"));
    });
  });

  test("a generic project is exit 2", async () => {
    await withDb(async (sql) => {
      const t = testDeps(sql);
      expect(await run(["rename", "a", "b"], t)).toBe(2);
      expect(t.stderr()).toContain("rename needs a Starlight project");
      expect(t.stderr()).not.toContain("unknown command");
    });
  });

  test("a wrong number of arguments is exit 2", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("Intro") });
      const r = await go(sql, root, ["rename", "a"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("rename: missing argument");
    });
  });

  test("help lists rename", async () => {
    const t = testDeps(undefined as unknown as Sql);
    expect(await run(["help"], t)).toBe(0);
    expect(t.stdout()).toContain("rename");
  });
});

