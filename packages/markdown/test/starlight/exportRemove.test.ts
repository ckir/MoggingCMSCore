import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Sql } from "postgres";
import { createDocument, deleteDocument, getDocument, migrate, publish, saveDraft, unpublish } from "@mogging/core";
import type { Ctx } from "@mogging/core";
import { exportFolder } from "../../src/export.js";
import type { ExportReport } from "../../src/export.js";
import { importFolder } from "../../src/import.js";
import type { StarlightLayout } from "../../src/starlight/layout.js";
import { withTestDb } from "../db.js";
import { ctxFor, layout, layoutOwn, project, readTree } from "./fixtures.js";

const D = "src/content/docs";
const MANIFEST = ".mogging/manifest.json";
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function setup(fn: (sql: Sql, ctx: Ctx) => Promise<void>): Promise<void> {
  await withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql, ctxFor(sql));
  });
}

const page = (title: string, extra = "", body = "Hello"): string => `---\ntitle: ${title}\n${extra}---\n${body}\n`;
const docsProject = (files: Record<string, string>): string =>
  project(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${D}/${k}`, v])));
const abs = (root: string, rel: string): string => path.join(root, ...rel.split("/"));
const put = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(abs(root, rel)), { recursive: true });
  fs.writeFileSync(abs(root, rel), text);
};
const read = (root: string, rel: string): string => fs.readFileSync(abs(root, rel), "utf8");
const exists = (root: string, rel: string): boolean => fs.existsSync(abs(root, rel));
const sha = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

const imp = (ctx: Ctx, root: string, extra: Record<string, unknown> = {}, l: StarlightLayout = layout) =>
  importFolder(ctx, { dir: root, starlight: { layout: l, ...extra } });
const run = (ctx: Ctx, root: string, opts: Record<string, unknown> = {}, l: StarlightLayout = layout): Promise<ExportReport> => {
  const { locales, ...starlight } = opts;
  return exportFolder(ctx, { dir: root, ...(locales === undefined ? {} : { locales: locales as string[] }), starlight: { layout: l, ...starlight } });
};

type Entry = { path: string; slug: string; locale: string; version: number; sha256: string };
const manifestOf = (root: string): Entry[] => (JSON.parse(read(root, MANIFEST)) as { files: Entry[] }).files;
const manifestPaths = (root: string): string[] => manifestOf(root).map((e) => e.path);
const writeManifestFile = (root: string, files: Entry[]): void =>
  put(root, MANIFEST, `{"version":1,"files":[\n${files.map((f) => JSON.stringify(f)).join(",\n")}\n]}\n`);
const entry = (p: string, slug: string, text: string, locale = "de"): Entry => ({ path: p, slug, locale, version: 1, sha256: sha(text) });
const actionsOf = (r: ExportReport, action: string) => r.starlight!.actions.filter((a) => a.action === action);
const warned = (r: ExportReport, file: string, re: RegExp): boolean => r.warnings.some((w) => w.file === file && re.test(w.message));
const docOf = async (ctx: Ctx, slug: string) => (await getDocument(ctx, { collection: "docs", slug }))!;

/** English `a` and `b`, German day-one files for both, imported and exported once: the manifest lists both German files. */
async function exportedTwo(ctx: Ctx): Promise<string> {
  const root = docsProject({
    "a.md": page("A"), "b.md": page("B"), "de/a.md": page("Hallo", "", "Welt"), "de/b.md": page("Bee", "", "Welt"),
  });
  await imp(ctx, root);
  await run(ctx, root);
  expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
  return root;
}

describe("exportFolder, Starlight removals (spec 5.5)", () => {
  test("a listed, unchanged file of a soft-deleted document is removed with its manifest entry; English stays", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const r = await run(ctx, root);
      expect(exists(root, `${D}/de/a.md`)).toBe(false);
      expect(exists(root, `${D}/a.md`)).toBe(true);
      expect(exists(root, `${D}/de/b.md`)).toBe(true);
      expect(actionsOf(r, "remove")).toEqual([{ action: "remove", path: `${D}/de/a.md`, reason: "its document is deleted" }]);
      expect(manifestPaths(root)).toEqual([`${D}/de/b.md`]);
      expect(r.starlight!.attention).toEqual([]);
      // A second run has nothing left to do.
      const r2 = await run(ctx, root);
      expect(actionsOf(r2, "remove")).toEqual([]);
      expect(manifestPaths(root)).toEqual([`${D}/de/b.md`]);
    });
  });

  test("a dry run lists the removal and changes nothing", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const before = readTree(root);
      const r = await run(ctx, root, { dryRun: true });
      expect(actionsOf(r, "remove")).toEqual([{ action: "remove", path: `${D}/de/a.md`, reason: "its document is deleted" }]);
      expect(readTree(root)).toEqual(before);
    });
  });

  test("a listed, unchanged file whose German translation is unpublished is removed", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      await unpublish(ctx, { docId: (await docOf(ctx, "a")).id, locale: "de" });
      const r = await run(ctx, root);
      expect(exists(root, `${D}/de/a.md`)).toBe(false);
      expect(exists(root, `${D}/de/b.md`)).toBe(true);
      expect(actionsOf(r, "remove")).toEqual([{ action: "remove", path: `${D}/de/a.md`, reason: "its translation is unpublished" }]);
      expect(manifestPaths(root)).toEqual([`${D}/de/b.md`]);
      expect(r.starlight!.attention).toEqual([]);
    });
  });

  test("removal does not need the English file: prune, then export", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      fs.rmSync(abs(root, `${D}/a.md`));
      const pruned = await imp(ctx, root, { prune: true });
      expect(pruned.starlight!.pruned).toEqual(["a"]);
      const r = await run(ctx, root);
      expect(exists(root, `${D}/de/a.md`)).toBe(false);
      expect(exists(root, `${D}/de/b.md`)).toBe(true);
      expect(actionsOf(r, "remove").map((a) => a.path)).toEqual([`${D}/de/a.md`]);
      expect(manifestPaths(root)).toEqual([`${D}/de/b.md`]);
    });
  });

  test("an unpublished locale whose English file is gone is still removed, with no English-missing action for it", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      await unpublish(ctx, { docId: (await docOf(ctx, "a")).id, locale: "de" });
      fs.rmSync(abs(root, `${D}/a.md`));
      const r = await run(ctx, root);
      expect(exists(root, `${D}/de/a.md`)).toBe(false);
      expect(actionsOf(r, "remove").map((a) => a.path)).toEqual([`${D}/de/a.md`]);
      expect(actionsOf(r, "skip").filter((a) => a.path === `${D}/de/a.md`)).toEqual([]);
    });
  });

  test("a listed file whose bytes changed is left, reported as a warning and stays listed", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      const edited = `${page("Hallo", "", "Welt")}\n`;
      put(root, `${D}/de/a.md`, edited);
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const r = await run(ctx, root);
      expect(read(root, `${D}/de/a.md`)).toBe(edited);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(warned(r, `${D}/de/a.md`, /changed/)).toBe(true);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
      expect(manifestOf(root)[0]!.sha256).toBe(sha(page("Hallo", "", "Welt")));
    });
  });

  test("an unpublished locale's listed file whose bytes changed is left, warned about and stays listed", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      const edited = `${page("Hallo", "", "Welt")}\n`;
      put(root, `${D}/de/a.md`, edited);
      await unpublish(ctx, { docId: (await docOf(ctx, "a")).id, locale: "de" });
      const r = await run(ctx, root);
      expect(read(root, `${D}/de/a.md`)).toBe(edited);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(warned(r, `${D}/de/a.md`, /changed/)).toBe(true);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
    });
  });

  test("an unlisted file is never removed, deleted document or not", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "b.md": page("B"), "de/a.md": page("Hallo", "", "Welt"), "de/b.md": page("Bee", "", "Welt") });
      await imp(ctx, root);
      // No export yet: there is no manifest, so nothing is listed.
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const r = await run(ctx, root);
      expect(exists(root, `${D}/de/a.md`)).toBe(true);
      expect(actionsOf(r, "remove")).toEqual([]);
      // Listed b only: a stays, even with a manifest that exists.
      expect(manifestPaths(root)).toEqual([`${D}/de/b.md`]);
      const r2 = await run(ctx, root);
      expect(exists(root, `${D}/de/a.md`)).toBe(true);
      expect(actionsOf(r2, "remove")).toEqual([]);
    });
  });

  test("an entry whose slug no document has (a fresh database) removes nothing and is reported", async () => {
    await setup(async (_sql, ctx) => {
      const text = page("Geist", "", "Welt");
      const root = docsProject({ "other.md": page("O"), "de/ghost.md": text });
      writeManifestFile(root, [entry(`${D}/de/ghost.md`, "ghost", text)]);
      const r = await run(ctx, root);
      expect(read(root, `${D}/de/ghost.md`)).toBe(text);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(warned(r, `${D}/de/ghost.md`, /database does not know/)).toBe(true);
      expect(manifestPaths(root)).toEqual([`${D}/de/ghost.md`]);
      expect(r.starlight!.attention.filter((a) => a.file === `${D}/de/ghost.md`)).toEqual([]);
    });
  });

  test("entries that fail path validation are ignored with a warning and never removed, even for a deleted slug", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "a.md": page("A"), "b.md": page("B"), "de/a.md": page("Hallo", "", "Welt"), "zh-CN/a.md": page("Ni", "", "Hao"),
        "de/c.md": page("Cee", "", "Welt"),
      });
      await imp(ctx, root);
      const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "mog-victim-"));
      tmpDirs.push(victimDir);
      const outsideText = "outside\n";
      fs.writeFileSync(path.join(victimDir, "victim.txt"), outsideText);
      const rel = path.relative(root, path.join(victimDir, "victim.txt")).split(path.sep).join("/");
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const bad: Entry[] = [
        entry(rel, "a", outsideText),
        entry("../../etc/passwd", "a", "x"),
        entry(`${D}/zh-CN/a.md`, "a", page("Ni", "", "Hao")),
        entry(`${D}/de/c.md`, "a", page("Cee", "", "Welt")),
        entry(`${D}/a.md`, "a", page("A"), "en"),
        entry(`${D}/de/a.md`, "a", page("Hallo", "", "Welt"), "__proto__"),
      ];
      writeManifestFile(root, bad);
      const before = readTree(root);
      const r = await run(ctx, root);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(readTree(root)).toEqual({ ...before, [MANIFEST]: read(root, MANIFEST) });
      expect(fs.readFileSync(path.join(victimDir, "victim.txt"), "utf8")).toBe(outsideText);
      for (const e of bad) expect(warned(r, e.path, /manifest entry ignored/)).toBe(true);
      expect(manifestOf(root).map((e) => e.path).sort()).toEqual(bad.map((e) => e.path).sort());
    });
  });

  test("a slug held by a live and a deleted document: the live document decides", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const again = await imp(ctx, root); // English a.md is still on disk: a new live document takes the slug
      expect(again.errors).toEqual([]);
      const live = await docOf(ctx, "a");
      const r = await run(ctx, root);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(exists(root, `${D}/de/a.md`)).toBe(true);
      expect(manifestPaths(root)).toContain(`${D}/de/a.md`);
      // The live document's translation is then withdrawn: the file goes.
      await unpublish(ctx, { docId: live.id, locale: "de" });
      const r2 = await run(ctx, root);
      expect(exists(root, `${D}/de/a.md`)).toBe(false);
      expect(actionsOf(r2, "remove").map((a) => a.reason)).toEqual(["its translation is unpublished"]);
    });
  });

  test("unpublishing the shared scope never removes a published translation", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      // A shared draft that keeps the slug visible, then the shared scope is unpublished; German stays published.
      const a = await getDocument(ctx, { collection: "docs", slug: "a" });
      await saveDraft(ctx, { docId: a!.id, locale: "shared", data: { ...a!.shared.published!.data } });
      await unpublish(ctx, { docId: a!.id, locale: "shared" });
      const r = await run(ctx, root);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(exists(root, `${D}/de/a.md`)).toBe(true);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
    });
  });

  test("a live document whose only shared head is a draft slug: its own locale heads decide", async () => {
    await setup(async (_sql, ctx) => {
      const { id } = await createDocument(ctx, { collection: "docs" });
      await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "drafty" } });
      await saveDraft(ctx, { docId: id, locale: "de", data: { title: "Entwurf" } });
      await publish(ctx, { docId: id, locale: "de" });
      const text = page("Entwurf");
      const root = docsProject({ "other.md": page("O"), "de/drafty.md": text });
      writeManifestFile(root, [entry(`${D}/de/drafty.md`, "drafty", text)]);
      const r = await run(ctx, root);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(read(root, `${D}/de/drafty.md`)).toBe(text);
      expect(manifestPaths(root)).toContain(`${D}/de/drafty.md`);
      await unpublish(ctx, { docId: id, locale: "de" });
      const r2 = await run(ctx, root);
      expect(actionsOf(r2, "remove")).toEqual([{ action: "remove", path: `${D}/de/drafty.md`, reason: "its translation is unpublished" }]);
      expect(exists(root, `${D}/de/drafty.md`)).toBe(false);
      expect(manifestPaths(root)).not.toContain(`${D}/de/drafty.md`);
    });
  });

  test("a file never becomes removable because English changed", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      put(root, `${D}/a.md`, page("A changed", "", "Different body"));
      const r = await run(ctx, root);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(exists(root, `${D}/de/a.md`)).toBe(true);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
      // The English file deleted without a prune: the document is live, so nothing is removed either.
      fs.rmSync(abs(root, `${D}/a.md`));
      const r2 = await run(ctx, root);
      expect(actionsOf(r2, "remove")).toEqual([]);
      expect(exists(root, `${D}/de/a.md`)).toBe(true);
    });
  });

  test("a hand-deleted listed file of a live published translation is recreated with a warning", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      fs.rmSync(abs(root, `${D}/de/a.md`));
      const r = await run(ctx, root);
      expect(read(root, `${D}/de/a.md`)).toBe(page("Hallo", "", "Welt"));
      expect(warned(r, `${D}/de/a.md`, /recreated/)).toBe(true);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
    });
  });

  test("a hand-deleted listed file whose English extension changed is recreated under the new name with a warning", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      fs.rmSync(abs(root, `${D}/de/a.md`));
      fs.renameSync(abs(root, `${D}/a.md`), abs(root, `${D}/a.mdx`));
      const r = await run(ctx, root);
      expect(read(root, `${D}/de/a.mdx`)).toBe(page("Hallo", "", "Welt"));
      expect(warned(r, `${D}/de/a.mdx`, /recreated/)).toBe(true);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.mdx`, `${D}/de/b.md`]);
    });
  });

  test("a deleted document's listed file that is already gone just loses its entry", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      fs.rmSync(abs(root, `${D}/de/a.md`));
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const r = await run(ctx, root);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(manifestPaths(root)).toEqual([`${D}/de/b.md`]);
    });
  });

  test("a locale the run does not evaluate keeps its files and entries", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const r = await run(ctx, root, { locales: ["zh-CN"] });
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(exists(root, `${D}/de/a.md`)).toBe(true);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
    });
  });

  test("a symbolic link in the way is refused, never followed", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const target = abs(root, `${D}/de/b.md`);
      fs.rmSync(abs(root, `${D}/de/a.md`));
      fs.symlinkSync(target, abs(root, `${D}/de/a.md`));
      const r = await run(ctx, root);
      expect(fs.lstatSync(abs(root, `${D}/de/a.md`)).isSymbolicLink()).toBe(true);
      expect(exists(root, `${D}/de/b.md`)).toBe(true);
      expect(actionsOf(r, "remove")).toEqual([]);
      expect(actionsOf(r, "refuse").map((a) => a.path)).toEqual([`${D}/de/a.md`]);
      expect(r.starlight!.attention.map((a) => a.file)).toEqual([`${D}/de/a.md`]);
    });
  });

  test("the own-folder layout removes from its locale folder too", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "en/a.md": page("A"), "en/b.md": page("B"), "de/a.md": page("Hallo", "", "Welt"), "de/b.md": page("Bee", "", "Welt"),
      });
      await imp(ctx, root, {}, layoutOwn);
      await run(ctx, root, {}, layoutOwn);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
      await deleteDocument(ctx, { docId: (await docOf(ctx, "a")).id });
      const r = await run(ctx, root, {}, layoutOwn);
      expect(exists(root, `${D}/de/a.md`)).toBe(false);
      expect(exists(root, `${D}/en/a.md`)).toBe(true);
      expect(actionsOf(r, "remove").map((a) => a.path)).toEqual([`${D}/de/a.md`]);
    });
  });

  test("deleted documents are found past the first page of 200", async () => {
    await setup(async (_sql, ctx) => {
      const root = await exportedTwo(ctx);
      // 205 deleted documents created after a and b, each with a published slug; the last one's German file is listed.
      const slugs: string[] = [];
      for (let i = 0; i < 205; i++) {
        const { id } = await createDocument(ctx, { collection: "docs" });
        const slug = `gone-${String(i).padStart(3, "0")}`;
        slugs.push(slug);
        await saveDraft(ctx, { docId: id, locale: "shared", data: { slug } });
        await publish(ctx, { docId: id, locale: "shared" });
        await deleteDocument(ctx, { docId: id });
      }
      const last = slugs[slugs.length - 1]!;
      const text = page("Weg", "", "Welt");
      put(root, `${D}/de/${last}.md`, text);
      writeManifestFile(root, [...manifestOf(root), entry(`${D}/de/${last}.md`, last, text)]);
      const r = await run(ctx, root);
      expect(exists(root, `${D}/de/${last}.md`)).toBe(false);
      expect(actionsOf(r, "remove").map((a) => a.path)).toEqual([`${D}/de/${last}.md`]);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
    });
  }, 60_000);
});
