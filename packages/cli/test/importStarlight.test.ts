import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getDocument, migrate, publish, saveDraft } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { testDeps } from "./fixtures.js";
import { ASTRO_ROOT_DE_ZH, page, starlightConfig, starlightDeps, starlightProject } from "./starlightFixtures.js";

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

const D = "src/content/docs";
const ctxOf = (sql: Sql) => ({ sql, config: starlightConfig, actor: "test" });

/** Runs the CLI over a Starlight project and returns the exit code and both streams. */
async function go(sql: Sql, root: string, args: string[], cwd: string = root) {
  const t = starlightDeps(sql, root, { cwd });
  const code = await run(args, t);
  return { code, out: t.stdout(), err: t.stderr() };
}

/** `getDocument` also returns a soft-deleted document (with `deletedAt` set); `null` means it never existed. */
async function state(sql: Sql, slug: string): Promise<"live" | "deleted" | "absent"> {
  const doc = await getDocument(ctxOf(sql), { collection: "docs", slug });
  if (doc === null) return "absent";
  return doc.deletedAt === null ? "live" : "deleted";
}

const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const lines = (out: string): string[] => out.split("\n").filter((l) => l !== "");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("mogging import in a Starlight project", () => {
  test("a plain import imports the docs folder and publishes English", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({
        [`${D}/a.md`]: page("Intro"),
        [`${D}/de/a.md`]: page("Einleitung"),
        "astro.config.mjs": ASTRO_ROOT_DE_ZH,
      });
      const r = await go(sql, root, ["import"]);
      expect(r.code).toBe(0);
      expect(lines(r.out)).toContain(`created ${D}/a.md`);
      // the brief says `created` for the locale file too; the SDK reports a locale file as `updated` (importStarlight.ts, planLocales)
      expect(lines(r.out)).toContain(`updated ${D}/de/a.md`);
      expect(lines(r.out).filter((l) => l.startsWith("warning:"))).toEqual([]);
      const doc = (await getDocument(ctxOf(sql), { collection: "docs", slug: "a" }))!;
      expect(doc.locales["en"]?.published).not.toBeNull();
      expect(doc.locales["de"]?.published).not.toBeNull();
    });
  });

  test("a directory argument in a Starlight project is exit 2", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("Intro") });
      const r = await go(sql, root, ["import", D]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("imports from its docs folder");
      expect(r.err).toContain(`(${D})`);
    });
  });

  test("Starlight flags in a generic project are exit 2 naming the export", async () => {
    await withDb(async (sql) => {
      const dir = mkdtempSync(join(tmpdir(), "mogging-cli-generic-"));
      dirs.push(dir);
      for (const args of [
        ["import", dir, "--prune"],
        ["import", dir, "--dry-run"],
        ["import", dir, "--accept-new-and-gone"],
        ["import", dir, "--restore", "x"],
      ]) {
        const t = testDeps(sql);
        expect(await run(args, t)).toBe(2);
        expect(t.stderr()).toContain("needs a Starlight project");
        expect(t.stderr()).toContain(`--${args[2]!.replace(/^--/, "")}`);
      }
      const none = testDeps(sql);
      expect(await run(["import"], none)).toBe(2);
      expect(none.stderr()).toContain("import: missing argument");
    });
  });

  test("a plain --prune deletes a gone page", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/b.md`]: page("B") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      rmSync(join(root, D, "b.md"));
      const r = await go(sql, root, ["import", "--prune"]);
      expect(r.code).toBe(0);
      expect(lines(r.out)).toContain("pruned b");
      expect(await state(sql, "b")).toBe("deleted");
      expect(await state(sql, "a")).toBe("live");
    });
  });

  test("an ambiguous stop lists both sides without a command", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/c.md`]: page("C") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      rmSync(join(root, D, "a.md"));
      rmSync(join(root, D, "c.md"));
      write(root, `${D}/b.md`, page("B"));
      const r = await go(sql, root, ["import"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("stopped: 2 page(s) gone and 1 new file(s); nothing was created or pruned");
      expect(lines(r.out)).toContain('  gone a "A"');
      expect(lines(r.out)).toContain('  gone c "C"');
      expect(lines(r.out)).toContain(`  new ${D}/b.md "B"`);
      expect(r.out).toContain("pair them with mogging rename <old> <new>, or pass --accept-new-and-gone");
      expect(r.out).not.toContain("run:");
    });
  });

  test("a dry run predicts the stop's exit 4 and changes nothing", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/c.md`]: page("C") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      renameSync(join(root, D, "a.md"), join(root, D, "b.md"));
      write(root, `${D}/c.md`, page("C edited"));
      const r = await go(sql, root, ["import", "--dry-run"]);
      expect(r.code).toBe(4);
      expect(lines(r.out)[0]).toBe("dry run: nothing was written");
      expect(lines(r.out)).toContain(`updated ${D}/c.md`);
      expect(r.out).toContain("run: mogging rename a b");
      const c = (await getDocument(ctxOf(sql), { collection: "docs", slug: "c" }))!;
      expect(c.locales["en"]?.published?.data["title"]).toBe("C");
    });
  });

  test("a dry run predicts the ambiguous stop's exit 1 and changes nothing", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/c.md`]: page("C") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      rmSync(join(root, D, "a.md"));
      rmSync(join(root, D, "c.md"));
      write(root, `${D}/b.md`, page("B"));
      const r = await go(sql, root, ["import", "--dry-run"]);
      expect(r.code).toBe(1);
      expect(lines(r.out)).toContain(`skipped ${D}/b.md`);
      expect(await state(sql, "b")).toBe("absent");
      expect(await state(sql, "a")).toBe("live");
      expect(await state(sql, "c")).toBe("live");
    });
  });

  test("--dry-run writes nothing and says so", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/de/a.md`]: page("A de") });
      const r = await go(sql, root, ["import", "--dry-run"]);
      expect(r.code).toBe(0);
      expect(lines(r.out)[0]).toBe("dry run: nothing was written");
      expect(lines(r.out)).toContain(`created ${D}/a.md`);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from documents`;
      expect(n).toBe(0);
    });
  });

  test("the safety stop with other files imported exits 4 and prints the command", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/c.md`]: page("C") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      renameSync(join(root, D, "a.md"), join(root, D, "b.md"));
      write(root, `${D}/c.md`, page("C edited"));
      const text = await go(sql, root, ["import"]);
      expect(text.code).toBe(4);
      expect(lines(text.out)).toContain("run: mogging rename a b");
      expect(lines(text.out)).toContain(`updated ${D}/c.md`);
      expect(lines(text.out)).toContain(`skipped ${D}/b.md`);
      // a stop changes nothing else: the gone page is still there
      expect(await state(sql, "a")).toBe("live");
      expect(await state(sql, "b")).toBe("absent");

      write(root, `${D}/c.md`, page("C edited again"));
      const json = await go(sql, root, ["import", "--json"]);
      expect(json.code).toBe(4);
      const doc = JSON.parse(json.out);
      expect(doc.ok).toBe(true);
      expect(doc.partial).toBe(true);
      expect(doc.data.starlight.stop.command).toBe("mogging rename a b");
    });
  });

  test("a safety stop with nothing else exits 1 with ImportStopped", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      renameSync(join(root, D, "a.md"), join(root, D, "b.md"));
      const text = await go(sql, root, ["import"]);
      expect(text.code).toBe(1);
      expect(text.err).toContain("rename safety stop: nothing was imported");
      const json = await go(sql, root, ["import", "--json"]);
      expect(json.code).toBe(1);
      const doc = JSON.parse(json.out);
      expect(doc.ok).toBe(false);
      expect(doc.error.code).toBe("ImportStopped");
    });
  });

  test("a safety stop where every other file is unchanged exits 1", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/c.md`]: page("C") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      renameSync(join(root, D, "a.md"), join(root, D, "b.md"));
      const r = await go(sql, root, ["import"]);
      expect(lines(r.out)).toContain(`unchanged ${D}/c.md`);
      expect(r.code).toBe(1);
      expect(r.err).toContain("rename safety stop: nothing was imported");
    });
  });

  test("a behind locale file is reported", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/de/a.md`]: page("Eins") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      const doc = (await getDocument(ctxOf(sql), { collection: "docs", slug: "a" }))!;
      await saveDraft(ctxOf(sql), { docId: doc.id, locale: "de", data: { title: "Zwei" } });
      await publish(ctxOf(sql), { docId: doc.id, locale: "de" });
      const r = await go(sql, root, ["import"]);
      expect(r.code).toBe(0);
      expect(lines(r.out)).toContain(`behind ${D}/de/a.md`);
    });
  });

  test("an unsupported extension is reported once", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/b.markdown`]: page("B") });
      const r = await go(sql, root, ["import"]);
      expect(r.code).toBe(0);
      expect(lines(r.out).filter((l) => l.includes("does not import"))).toHaveLength(1);
    });
  });

  test("astro warnings reach --json", async () => {
    await withDb(async (sql) => {
      const drifted = ASTRO_ROOT_DE_ZH.replace(/\s*"zh-cn": \{[^}]*\},/, "");
      expect(drifted).not.toContain("zh-cn");
      const root = starlightProject({ [`${D}/a.md`]: page("A"), "astro.config.mjs": drifted });
      const r = await go(sql, root, ["import", "--json"]);
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out);
      expect(doc.data.warnings[0].file).toBe("astro.config.mjs");
    });
  });

  test("--accept-new-and-gone creates the new page", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/c.md`]: page("C") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      rmSync(join(root, D, "a.md"));
      write(root, `${D}/b.md`, page("B"));
      const r = await go(sql, root, ["import", "--accept-new-and-gone"]);
      expect(r.code).toBe(0);
      expect(lines(r.out)).toContain(`created ${D}/b.md`);
      expect(r.out).not.toContain("pruned");
      expect(await state(sql, "b")).toBe("live");
      expect(await state(sql, "a")).toBe("live");
    });
  });

  test("--accept-new-and-gone with --prune also deletes the gone page", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/d.md`]: page("D"), [`${D}/e.md`]: page("E") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      rmSync(join(root, D, "d.md"));
      write(root, `${D}/f.md`, page("F"));
      const r = await go(sql, root, ["import", "--accept-new-and-gone", "--prune"]);
      expect(r.code).toBe(0);
      expect(lines(r.out)).toContain(`created ${D}/f.md`);
      expect(lines(r.out)).toContain("pruned d");
      expect(await state(sql, "d")).toBe("deleted");
      expect(await state(sql, "f")).toBe("live");
    });
  });

  test("--restore takes a path relative to the working directory", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), [`${D}/de/a.md`]: page("Eins") });
      expect((await go(sql, root, ["import"])).code).toBe(0);
      const doc = (await getDocument(ctxOf(sql), { collection: "docs", slug: "a" }))!;
      await saveDraft(ctxOf(sql), { docId: doc.id, locale: "de", data: { title: "Zwei" } });
      await publish(ctxOf(sql), { docId: doc.id, locale: "de" });
      const cwd = join(root, D);
      const config = join(root, "mogging.config.ts");

      const bad = await go(sql, root, ["import", "--config", config, "--restore", "../../../../elsewhere.md"], cwd);
      expect(bad.code).toBe(2);
      expect(bad.err).toContain("--restore ../../../../elsewhere.md is outside the project");

      const r = await go(sql, root, ["import", "--config", config, "--restore", "de/a.md"], cwd);
      expect(r.err).not.toContain("no locale file");
      expect(r.out).not.toContain("no locale file");
      expect(r.code).toBe(0);
      const after = (await getDocument(ctxOf(sql), { collection: "docs", slug: "a" }))!;
      expect(after.locales["de"]?.draft?.state).toBe("DRAFT_HUMAN");
      expect(after.locales["de"]?.draft?.data["title"]).toBe("Eins");
    });
  });

  /** Imports pages `a` and `b` (each with a German file), then publishes a different German title for both. */
  async function restoreSetup(sql: Sql) {
    const root = starlightProject({
      [`${D}/a.md`]: page("A"), [`${D}/de/a.md`]: page("Eins"),
      [`${D}/b.md`]: page("B"), [`${D}/de/b.md`]: page("Zwei"),
    });
    expect((await go(sql, root, ["import"])).code).toBe(0);
    for (const slug of ["a", "b"]) {
      const doc = (await getDocument(ctxOf(sql), { collection: "docs", slug }))!;
      await saveDraft(ctxOf(sql), { docId: doc.id, locale: "de", data: { title: "Geaendert" } });
      await publish(ctxOf(sql), { docId: doc.id, locale: "de" });
    }
    return root;
  }
  const germanTitle = async (sql: Sql, slug: string): Promise<unknown> =>
    (await getDocument(ctxOf(sql), { collection: "docs", slug }))!.locales["de"]?.draft?.data["title"];

  test("--restore ./de/a.md reaches the SDK as src/content/docs/de/a.md", async () => {
    await withDb(async (sql) => {
      const root = await restoreSetup(sql);
      const cwd = join(root, D);
      const r = await go(sql, root, ["import", "--config", join(root, "mogging.config.ts"), "--restore", "./de/a.md"], cwd);
      expect(r.code).toBe(0);
      expect(r.err + r.out).not.toContain("no locale file");
      expect(await germanTitle(sql, "a")).toBe("Eins");
      expect(await germanTitle(sql, "b")).toBeUndefined(); // b was not named, so it was not restored
    });
  });

  test("--restore with an absolute path inside the project reaches the SDK project-relative", async () => {
    await withDb(async (sql) => {
      const root = await restoreSetup(sql);
      const config = join(root, "mogging.config.ts");
      const r = await go(sql, root, ["import", "--config", config, "--restore", join(root, D, "de", "a.md")], join(root, D, "de"));
      expect(r.code).toBe(0);
      expect(r.err + r.out).not.toContain("no locale file");
      expect(await germanTitle(sql, "a")).toBe("Eins");
    });
  });

  test("two --restore values are both passed", async () => {
    await withDb(async (sql) => {
      const root = await restoreSetup(sql);
      const r = await go(sql, root, ["import", "--restore", `${D}/de/a.md`, "--restore", `./${D}/de/b.md`]);
      expect(r.code).toBe(0);
      expect(r.err + r.out).not.toContain("no locale file");
      expect(await germanTitle(sql, "a")).toBe("Eins");
      expect(await germanTitle(sql, "b")).toBe("Zwei");
    });
  });

  test("a file named ..x.md inside the project is accepted by --restore", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A"), "..x.md": "x" });
      const r = await go(sql, root, ["import", "--restore", "..x.md"]);
      expect(r.err).not.toContain("is outside the project");
      expect(r.code).not.toBe(2);
    });
  });

  test("--restore . (the project root itself) is exit 2", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A") });
      const r = await go(sql, root, ["import", "--restore", "."]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`--restore . is outside the project ${root}`);
    });
  });

  test("an empty docs folder is exit 1", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/.keep`]: "" });
      const r = await go(sql, root, ["import"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("no source file found");
    });
  });

  test("locale drift is warned, an unreadable config once", async () => {
    await withDb(async (sql) => {
      const drifted = ASTRO_ROOT_DE_ZH.replace(/\s*"zh-cn": \{[^}]*\},/, "");
      const a = starlightProject({ [`${D}/a.md`]: page("A"), "astro.config.mjs": drifted });
      const r1 = await go(sql, a, ["import"]);
      expect(lines(r1.out)).toContain(
        `warning: astro.config.mjs: locale "zh-CN" (folder zh-cn) is not in Starlight's locales`,
      );

      const unreadable = `import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
const L = { root: { label: "English", lang: "en" } };
export default defineConfig({ integrations: [starlight({ title: "Docs", locales: L })] });
`;
      const b = starlightProject({ [`${D}/a.md`]: page("A"), "astro.config.mjs": unreadable });
      const r2 = await go(sql, b, ["import"]);
      expect(r2.code).toBe(0);
      expect(lines(r2.out).filter((l) => l.startsWith("warning: astro.config: could not be read statically"))).toHaveLength(1);
    });
  });

  test("the project root is the config's folder", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({ [`${D}/a.md`]: page("A") });
      const r = await go(sql, root, ["import", "--config", join(root, "mogging.config.ts")], join(root, "src"));
      expect(r.code).toBe(0);
      expect(lines(r.out)).toContain(`created ${D}/a.md`);
    });
  });
});
