import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { migrate } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { testDeps } from "./fixtures.js";
import { ASTRO_ROOT_DE_ZH, page, starlightDeps, starlightProject } from "./starlightFixtures.js";

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

const D = "src/content/docs";

/** Runs the CLI over a Starlight project and returns the exit code and both streams. */
async function go(sql: Sql, root: string, args: string[], cwd: string = root) {
  const t = starlightDeps(sql, root, { cwd });
  const code = await run(args, t);
  return { code, out: t.stdout(), err: t.stderr() };
}

const lines = (out: string): string[] => out.split("\n").filter((l) => l !== "");

const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("mogging export in a Starlight project", () => {
  test("a re-export after day one keeps every file", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("Intro"), [`${D}/de/a.md`]: page("Einleitung") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      const r = await go(sql, root, ["export"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("kept 1 unchanged locale file(s)");
      expect(lines(r.out).filter((l) => l.startsWith("keep "))).toEqual([]);
    });
  });

  test("--dry-run lists every action, keep included, and writes nothing", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("Intro"), [`${D}/de/a.md`]: page("Einleitung") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      const r = await go(sql, root, ["export", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(lines(r.out)[0]).toBe("dry run: nothing was written");
      expect(r.out).toContain(`keep ${D}/de/a.md (`);
      expect(existsSync(join(root, ".mogging/manifest.json"))).toBe(false);
      const json = await go(sql, root, ["export", "--dry-run", "--json"]);
      expect(JSON.parse(json.out).data.starlight.dryRun).toBe(true);
      expect(existsSync(join(root, ".mogging/manifest.json"))).toBe(false);
    });
  });

  test("a hand edit puts the run in attention: exit 4, ok and partial in json", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("Intro"), [`${D}/de/a.md`]: page("Einleitung") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      expect((await go(sql, root, ["export"])).code).toBe(0);
      write(root, `${D}/de/a.md`, page("Einleitung von Hand", "", "Von Hand geaendert"));
      const json = await go(sql, root, ["export", "--json"]);
      expect(json.code).toBe(4);
      const doc = JSON.parse(json.out);
      expect(doc.ok).toBe(true);
      expect(doc.partial).toBe(true);
      expect(doc.data.starlight.attention[0].file).toBe(`${D}/de/a.md`);
      const text = await go(sql, root, ["export"]);
      expect(text.code).toBe(4);
      expect(lines(text.out).some((l) => l.startsWith(`attention: ${D}/de/a.md:`))).toBe(true);
    });
  });

  test("a Mogging locale missing from Starlight's locales is skipped and the run exits 4", async () => {
    await withDb(async (sql) => {
      const drifted = ASTRO_ROOT_DE_ZH.replace(/\s*"zh-cn": \{[^}]*\},/, "");
      expect(drifted).not.toContain("zh-cn");
      const root = starlightProject({
        [`${D}/a.md`]: page("Intro"),
        [`${D}/zh-cn/a.md`]: page("简介"),
        "astro.config.mjs": drifted,
      });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      rmSync(join(root, D, "zh-cn/a.md")); // the published translation stays in the database
      const r = await go(sql, root, ["export"]);
      expect(r.code).toBe(4);
      expect(existsSync(join(root, D, "zh-cn/a.md"))).toBe(false); // the emptied folder may remain
      expect(lines(r.out).some((l) => l.includes("zh-CN"))).toBe(true);
      expect(lines(r.out).some((l) => l.startsWith("warning: ") && l.includes("zh-CN"))).toBe(true);
    });
  });

  test("an unreadable astro.config writes as configured with one warning", async () => {
    await withDb(async (sql) => {
      const unreadable = `import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
const L = { root: { label: "English", lang: "en" } };
export default defineConfig({ integrations: [starlight({ title: "Docs", locales: L })] });
`;
      const root = starlightProject({
        [`${D}/a.md`]: page("Intro"),
        [`${D}/zh-cn/a.md`]: page("简介"),
        "astro.config.mjs": unreadable,
      });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      rmSync(join(root, D, "zh-cn/a.md")); // the published translation stays in the database
      const r = await go(sql, root, ["export"]);
      expect(r.code).toBe(0);
      expect(existsSync(join(root, D, "zh-cn/a.md"))).toBe(true);
      expect(lines(r.out).filter((l) => l.includes("could not be read statically"))).toHaveLength(1);
    });
  });

  test("a directory argument and --collection are exit 2 in a Starlight project", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("Intro") });
      const dir = await go(sql, root, ["export", D]);
      expect(dir.code).toBe(2);
      expect(dir.err).toContain(`export: a Starlight project exports its docs folder (${D}); drop the directory argument`);
      const col = await go(sql, root, ["export", "--collection", "docs"]);
      expect(col.code).toBe(2);
      expect(col.err).toContain("export: a Starlight project has one docs collection; drop --collection");
    });
  });

  test("--dry-run in a generic project is exit 2", async () => {
    await withDb(async (sql) => {
      const dir = mkdtempSync(join(tmpdir(), "mogging-cli-generic-"));
      dirs.push(dir);
      const t = testDeps(sql);
      expect(await run(["export", dir, "--dry-run"], t)).toBe(2);
      expect(t.stderr()).toContain("export: --dry-run needs a Starlight project");
    });
  });

  test("--locale zh-cn selects zh-CN", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({
        [`${D}/a.md`]: page("Intro"),
        [`${D}/de/a.md`]: page("Einleitung"),
        [`${D}/zh-cn/a.md`]: page("简介"),
        "astro.config.mjs": ASTRO_ROOT_DE_ZH,
      });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      rmSync(join(root, D, "zh-cn/a.md"));
      rmSync(join(root, D, "de/a.md"));
      const r = await go(sql, root, ["export", "--locale", "zh-cn"]);
      expect(r.code).toBe(0);
      expect(readFileSync(join(root, D, "zh-cn/a.md"), "utf8")).toContain("简介");
      expect(existsSync(join(root, D, "de/a.md"))).toBe(false);
      const bad = await go(sql, root, ["export", "--locale", "en_US"]);
      expect(bad.code).toBe(2);
      expect(bad.err).toContain('unknown locale "en_US"');
    });
  });

  test("run from a subfolder with --config, export writes under the config's folder, not the working directory", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("Intro"), [`${D}/de/a.md`]: page("Einleitung") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      rmSync(join(root, D, "de", "a.md"));
      const cwd = join(root, D);
      const r = await go(sql, root, ["export", "--config", join(root, "mogging.config.ts")], cwd);
      expect(r.code).toBe(0);
      expect(readFileSync(join(root, D, "de", "a.md"), "utf8")).toContain("Einleitung");
      expect(existsSync(join(cwd, D))).toBe(false);
      expect(existsSync(join(root, ".mogging", "manifest.json"))).toBe(true);
    });
  });
});
