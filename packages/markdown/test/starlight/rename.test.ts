import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Sql } from "postgres";
import { ConflictError, ValidationError, createDocument, getDocument, migrate, publish, saveDraft } from "@mogging/core";
import type { Ctx } from "@mogging/core";
import { exportFolder } from "../../src/export.js";
import { importFolder } from "../../src/import.js";
import { markdownToTree } from "../../src/parse.js";
import type { StarlightLayout } from "../../src/starlight/layout.js";
import { renamePage } from "../../src/starlight/rename.js";
import { withTestDb } from "../db.js";
import { ctxFor, layout, layoutOwn, project, readTree } from "./fixtures.js";

const D = "src/content/docs";
const MANIFEST = ".mogging/manifest.json";

afterEach(() => {
  vi.restoreAllMocks();
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

const imp = (ctx: Ctx, root: string, l: StarlightLayout = layout) =>
  importFolder(ctx, { dir: root, starlight: { layout: l } });
const exp = (ctx: Ctx, root: string, l: StarlightLayout = layout) =>
  exportFolder(ctx, { dir: root, starlight: { layout: l } });
const ren = (ctx: Ctx, root: string, from: string, to: string, extra: { dryRun?: boolean; layout?: StarlightLayout } = {}) =>
  renamePage(ctx, { dir: root, layout: extra.layout ?? layout, from, to, ...(extra.dryRun === undefined ? {} : { dryRun: extra.dryRun }) });

type Entry = { path: string; slug: string; locale: string; version: number; sha256: string };
const manifestOf = (root: string): Entry[] => (JSON.parse(read(root, MANIFEST)) as { files: Entry[] }).files;
const docOf = async (ctx: Ctx, slug: string) => (await getDocument(ctx, { collection: "docs", slug }))!;

/** English `guides/old`, German and Chinese day-one files, an unrelated page; imported and exported once. */
async function twoLocales(ctx: Ctx, l: StarlightLayout = layout): Promise<string> {
  const own = l.sourceDir !== null;
  const en = own ? "en/" : "";
  const root = docsProject({
    [`${en}guides/old.md`]: page("Old", "sidebar:\n  order: 4\ncustom: 1\n", "Body"),
    "de/guides/old.md": page("Alt", "", "Text"),
    "zh-cn/guides/old.md": page("Jiu", "", "Wen"),
    [`${en}other.md`]: page("Other", "", "See [old](/guides/old/)."),
  });
  await imp(ctx, root, l);
  await exp(ctx, root, l);
  expect(manifestOf(root).map((e) => e.path)).toEqual([`${D}/de/guides/old.md`, `${D}/zh-cn/guides/old.md`]);
  return root;
}

describe("renamePage (spec 5.6)", () => {
  test("saves and publishes the whole shared head with only the slug changed, moves English and every locale file, follows in the manifest", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      const before = await docOf(ctx, "guides/old");
      const deBefore = before.locales["de"]!.published!.version;
      const german = read(root, `${D}/de/guides/old.md`);

      const r = await ren(ctx, root, "guides/old", "guides/new");
      expect(r.dryRun).toBe(false);
      expect(r.actions).toEqual([
        { action: "move", path: `${D}/guides/old.md`, to: `${D}/guides/new.md`, reason: "rename" },
        { action: "move", path: `${D}/de/guides/old.md`, to: `${D}/de/guides/new.md`, reason: "rename" },
        { action: "move", path: `${D}/zh-cn/guides/old.md`, to: `${D}/zh-cn/guides/new.md`, reason: "rename" },
      ]);

      const after = await docOf(ctx, "guides/new");
      expect(after.id).toBe(before.id);
      expect(after.shared.published!.version).toBe(before.shared.published!.version + 1);
      expect(after.shared.published!.data).toEqual({ ...before.shared.published!.data, slug: "guides/new" });
      expect(after.shared.published!.data["sidebarOrder"]).toBe(4);
      expect(after.shared.published!.data["extra"]).toEqual({ custom: 1 });
      expect(after.locales["de"]!.published!.version).toBe(deBefore);
      expect(await getDocument(ctx, { collection: "docs", slug: "guides/old" })).toBeNull();

      expect(Object.keys(readTree(root)).filter((f) => f.startsWith(D)).sort()).toEqual([
        `${D}/de/guides/new.md`, `${D}/guides/new.md`, `${D}/other.md`, `${D}/zh-cn/guides/new.md`,
      ]);
      expect(read(root, `${D}/de/guides/new.md`)).toBe(german);
      expect(manifestOf(root)).toEqual([
        { path: `${D}/de/guides/new.md`, slug: "guides/new", locale: "de", version: 1, sha256: sha(german) },
        { path: `${D}/zh-cn/guides/new.md`, slug: "guides/new", locale: "zh-CN", version: 1, sha256: sha(read(root, `${D}/zh-cn/guides/new.md`)) },
      ]);
      // The next export agrees with the result: nothing is rewritten.
      const e = await exp(ctx, root);
      expect(e.starlight!.actions.filter((a) => a.action === "write" || a.action === "remove")).toEqual([]);
    });
  });

  test("a git mv of the English file first is fine and the manifest entries are still renamed", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      fs.renameSync(abs(root, `${D}/guides/old.md`), abs(root, `${D}/guides/new.md`));
      const r = await ren(ctx, root, "guides/old", "guides/new");
      expect(r.actions.map((a) => a.path)).toEqual([`${D}/de/guides/old.md`, `${D}/zh-cn/guides/old.md`]);
      expect(exists(root, `${D}/guides/new.md`)).toBe(true);
      expect(manifestOf(root).map((e) => [e.path, e.slug])).toEqual([
        [`${D}/de/guides/new.md`, "guides/new"], [`${D}/zh-cn/guides/new.md`, "guides/new"],
      ]);
      expect((await docOf(ctx, "guides/new")).shared.published!.data["slug"]).toBe("guides/new");
    });
  });

  test("a locale file the user moved with git mv is kept where it is and its manifest entry follows it", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      fs.renameSync(abs(root, `${D}/de/guides/old.md`), abs(root, `${D}/de/guides/new.md`));
      const r = await ren(ctx, root, "guides/old", "guides/new");
      expect(r.actions.map((a) => a.path)).toEqual([`${D}/guides/old.md`, `${D}/zh-cn/guides/old.md`]);
      expect(manifestOf(root).map((e) => e.path)).toEqual([`${D}/de/guides/new.md`, `${D}/zh-cn/guides/new.md`]);
    });
  });

  test("an interrupted rename (database done, files not) completes on re-run, found by the new slug; a re-run after that is a no-op", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      const doc = await docOf(ctx, "guides/old");
      await saveDraft(ctx, { docId: doc.id, locale: "shared", data: { ...doc.shared.published!.data, slug: "guides/new" } });
      await publish(ctx, { docId: doc.id, locale: "shared" });
      const version = (await docOf(ctx, "guides/new")).shared.published!.version;

      const r = await ren(ctx, root, "guides/old", "guides/new");
      expect(r.actions).toHaveLength(3);
      expect((await docOf(ctx, "guides/new")).shared.published!.version).toBe(version);
      expect(exists(root, `${D}/guides/new.md`)).toBe(true);
      expect(exists(root, `${D}/guides/old.md`)).toBe(false);
      expect(manifestOf(root).map((e) => e.slug)).toEqual(["guides/new", "guides/new"]);

      const again = readTree(root);
      const r2 = await ren(ctx, root, "guides/old", "guides/new");
      expect(r2.actions).toEqual([]);
      expect(readTree(root)).toEqual(again);
      expect((await docOf(ctx, "guides/new")).shared.published!.version).toBe(version);
    });
  });

  test("an interrupted run whose shared draft holds the new slug unpublished is completed by publishing it", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      const doc = await docOf(ctx, "guides/old");
      const { version } = await saveDraft(ctx, { docId: doc.id, locale: "shared", data: { ...doc.shared.published!.data, slug: "guides/new" } });
      const r = await ren(ctx, root, "guides/old", "guides/new");
      expect(r.actions).toHaveLength(3);
      const after = await docOf(ctx, "guides/new");
      expect(after.shared.published!.version).toBe(version);
      expect(after.shared.published!.data["slug"]).toBe("guides/new");
      expect(after.shared.draft).toBeNull();
    });
  });

  test("a move target with different parsed content is a ConflictError naming both files and nothing is moved or saved", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      put(root, `${D}/de/guides/new.md`, page("Anders", "", "Text"));
      const before = readTree(root);
      const err = await ren(ctx, root, "guides/old", "guides/new").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as Error).message).toContain(`${D}/de/guides/old.md`);
      expect((err as Error).message).toContain(`${D}/de/guides/new.md`);
      expect(readTree(root)).toEqual(before);
      expect((await docOf(ctx, "guides/old")).shared.published!.data["slug"]).toBe("guides/old");

    });
  });

  test("a target with the same parsed content is replaced by the move", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      const german = read(root, `${D}/de/guides/old.md`);
      put(root, `${D}/de/guides/new.md`, page("Alt", "", "Text"));
      const r = await ren(ctx, root, "guides/old", "guides/new");
      expect(r.actions).toHaveLength(3);
      expect(exists(root, `${D}/de/guides/old.md`)).toBe(false);
      expect(read(root, `${D}/de/guides/new.md`)).toBe(german);
    });
  });

  test("a differing English target is a ConflictError before any database write", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      put(root, `${D}/guides/new.md`, page("Different"));
      const before = readTree(root);
      await expect(ren(ctx, root, "guides/old", "guides/new")).rejects.toBeInstanceOf(ConflictError);
      expect(readTree(root)).toEqual(before);
      expect((await docOf(ctx, "guides/old")).shared.published!.data["slug"]).toBe("guides/old");
    });
  });

  test("a duplicate slug is refused (a plain read in a dry run, core's guard otherwise) and changes nothing", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      const before = readTree(root);
      const version = (await docOf(ctx, "guides/old")).shared.published!.version;
      await expect(ren(ctx, root, "guides/old", "other", { dryRun: true })).rejects.toThrow(/already used/);
      expect(await docOf(ctx, "guides/old")).toMatchObject({ shared: { draft: null, published: { version } } });
      await expect(ren(ctx, root, "guides/old", "other")).rejects.toBeInstanceOf(ValidationError);
      expect(readTree(root)).toEqual(before);
      expect(await docOf(ctx, "guides/old")).toMatchObject({ shared: { draft: null, published: { version } } });
    });
  });

  test("a dry run reports the planned moves and changes nothing", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      const before = readTree(root);
      const version = (await docOf(ctx, "guides/old")).shared.published!.version;
      const r = await ren(ctx, root, "guides/old", "guides/new", { dryRun: true });
      expect(r.dryRun).toBe(true);
      expect(r.actions.map((a) => [a.action, a.path, a.to, a.reason])).toEqual([
        ["move", `${D}/guides/old.md`, `${D}/guides/new.md`, "rename"],
        ["move", `${D}/de/guides/old.md`, `${D}/de/guides/new.md`, "rename"],
        ["move", `${D}/zh-cn/guides/old.md`, `${D}/zh-cn/guides/new.md`, "rename"],
      ]);
      expect(readTree(root)).toEqual(before);
      expect((await docOf(ctx, "guides/old")).shared.published!.version).toBe(version);
    });
  });

  test("a project root without the docs folder (or with a symlinked one) is refused, dry run included, and the database is unchanged", async () => {
    await setup(async (_sql, ctx) => {
      await twoLocales(ctx);
      const version = (await docOf(ctx, "guides/old")).shared.published!.version;
      const wrong = project({ "README.md": "nothing here\n" });
      for (const dryRun of [true, false]) {
        await expect(ren(ctx, wrong, "guides/old", "guides/new", { dryRun })).rejects.toMatchObject({
          name: "ValidationError", message: expect.stringContaining(`no source file found under ${D}`),
        });
      }
      // The docs folder is a link: the warning of the scan is carried into the message.
      const linked = project({ "real/a.md": page("A") });
      fs.mkdirSync(path.join(linked, "src/content"), { recursive: true });
      fs.symlinkSync(path.join(linked, "real"), path.join(linked, D));
      await expect(ren(ctx, linked, "guides/old", "guides/new")).rejects.toMatchObject({
        name: "ValidationError", message: expect.stringContaining("symbolic link"),
      });
      expect(await getDocument(ctx, { collection: "docs", slug: "guides/new" })).toBeNull();
      const doc = await docOf(ctx, "guides/old");
      expect(doc.shared.published!.version).toBe(version);
      expect(doc.shared.draft).toBeNull();
    });
  });

  test("the report carries the scan's warnings, in a dry run as well", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      put(root, `${D}/fr/x.md`, page("Fr"));
      const dry = await ren(ctx, root, "guides/old", "guides/new", { dryRun: true });
      expect(dry.warnings).toEqual([expect.objectContaining({ file: `${D}/fr` })]);
      const r = await ren(ctx, root, "guides/old", "guides/new");
      expect(r.warnings).toEqual(dry.warnings);
    });
  });

  test("references lists each line of astro.config and of Markdown under docsDir that holds the old slug; the reminder mentions redirects", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      put(root, "astro.config.mjs", "export default {\n  sidebar: [\n    { slug: 'guides/old' },\n    { slug: 'other' },\n  ],\n};\n");
      put(root, "notes.txt", "guides/old\n");
      put(root, `${D}/deep/more.mdx`, "x\n\nsee guides/old and guides/old again\n");
      const r = await ren(ctx, root, "guides/old", "guides/new");
      expect(r.references).toEqual([
        { file: "astro.config.mjs", line: 3, text: "    { slug: 'guides/old' }," },
        { file: `${D}/deep/more.mdx`, line: 3, text: "see guides/old and guides/old again" },
        { file: `${D}/other.md`, line: 4, text: "See [old](/guides/old/)." },
      ]);
      expect(r.reminder).toMatch(/redirect/i);
    });
  });

  test("a change of the English file's folder is refused when the page or a translation holds a relative file reference, and nothing changes", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "guides/old.md": page("Old", "", "![x](./img.png)"), "de/guides/old.md": page("Alt", "", "Text"),
        "guides/two.md": page("Two", "", "Plain"), "de/guides/two.md": page("Zwei", "", "![y](../pic.png)"),
        "guides/three.md": page("Three", "", "![z](/abs.png) and [l](./x.md)"),
      });
      await imp(ctx, root);
      await exp(ctx, root);
      const before = readTree(root);
      await expect(ren(ctx, root, "guides/old", "old")).rejects.toThrow(ValidationError);
      await expect(ren(ctx, root, "guides/two", "two")).rejects.toThrow(/relative/);
      await expect(ren(ctx, root, "guides/old", "old", { dryRun: true })).rejects.toThrow(ValidationError);
      expect(readTree(root)).toEqual(before);
      expect((await docOf(ctx, "guides/old")).shared.published!.data["slug"]).toBe("guides/old");

      // Absolute references and links are not file references.
      await ren(ctx, root, "guides/three", "three");
      expect(exists(root, `${D}/three.md`)).toBe(true);
      // The same depth in another folder is refused too; the same folder is unaffected.
      await expect(ren(ctx, root, "guides/old", "docs/old")).rejects.toThrow(/relative file references/);
      await expect(ren(ctx, root, "guides/old", "docs/old", { dryRun: true })).rejects.toBeInstanceOf(ValidationError);
      expect(exists(root, `${D}/guides/old.md`)).toBe(true);
      expect((await docOf(ctx, "guides/old")).shared.published!.data["slug"]).toBe("guides/old");
      await ren(ctx, root, "guides/old", "guides/older");
      expect(exists(root, `${D}/guides/older.md`)).toBe(true);
      // A translation's reference counts as well.
      await expect(ren(ctx, root, "guides/two", "docs/two")).rejects.toThrow(/relative/);
    });
  });

  test("a case-only rename of the English file moves it with one rename (and the locale file too)", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "Foo.md": page("Foo"), "de/Foo.md": page("Fuu", "", "Text") });
      await imp(ctx, root);
      await exp(ctx, root);
      const version = (await docOf(ctx, "foo")).shared.published!.version;
      const rename = vi.spyOn(fs, "renameSync");
      const r = await ren(ctx, root, "foo", "foo");
      for (const name of ["Foo.md", "de/Foo.md"]) {
        const moves = rename.mock.calls.filter(([from]) => String(from) === abs(root, `${D}/${name}`));
        expect(moves).toHaveLength(1);
        expect(String(moves[0]![1])).toBe(abs(root, `${D}/${name.replace("Foo", "foo")}`));
      }
      expect(r.actions.map((a) => a.to)).toEqual([`${D}/foo.md`, `${D}/de/foo.md`]);
      expect(Object.keys(readTree(root)).filter((f) => f.startsWith(D)).sort()).toEqual([`${D}/de/foo.md`, `${D}/foo.md`]);
      expect(manifestOf(root).map((e) => e.path)).toEqual([`${D}/de/foo.md`]);
      expect((await docOf(ctx, "foo")).shared.published!.version).toBe(version);
    });
  });

  test("a new slug that is not the derived form, starts its last segment with an underscore or leaves the page tree is refused", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      const before = readTree(root);
      for (const to of [
        "guides/_old", "Guides/New", "a b", "guides/new.md", "../x", "/x", "", "guides//x", "guides/new/", "x\0y",
        "de/foo", "fr/foo",
      ]) {
        await expect(ren(ctx, root, "guides/old", to), to).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(ren(ctx, root, "nope", "guides/new")).rejects.toThrow(/nope/);
      await expect(ren(ctx, root, "nope", "guides/new", { dryRun: true })).rejects.toBeInstanceOf(ValidationError);
      expect(readTree(root)).toEqual(before);
      expect((await docOf(ctx, "guides/old")).shared.published!.data["slug"]).toBe("guides/old");
    });
  });

  test("a page without a relative reference may change folder, at the same depth too", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      await ren(ctx, root, "guides/old", "docs/old");
      expect(exists(root, `${D}/docs/old.md`)).toBe(true);
      expect(exists(root, `${D}/de/docs/old.md`)).toBe(true);
    });
  });

  test("a folder is created as needed inside the docs folder", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      await ren(ctx, root, "guides/old", "guides/a/b");
      expect(exists(root, `${D}/guides/a/b.md`)).toBe(true);
      expect(exists(root, `${D}/de/guides/a/b.md`)).toBe(true);
    });
  });

  test("the own-folder layout: English under en/ and the locale folders move", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx, layoutOwn);
      const r = await ren(ctx, root, "guides/old", "guides/new", { layout: layoutOwn });
      expect(r.actions.map((a) => a.to)).toEqual([`${D}/en/guides/new.md`, `${D}/de/guides/new.md`, `${D}/zh-cn/guides/new.md`]);
      expect(exists(root, `${D}/en/guides/new.md`)).toBe(true);
      expect(exists(root, `${D}/en/guides/old.md`)).toBe(false);
      expect(manifestOf(root).map((e) => e.slug)).toEqual(["guides/new", "guides/new"]);
      // A top-level slug folder named like a locale is fine here: English sits in en/.
      await ren(ctx, root, "other", "de/other", { layout: layoutOwn });
      expect(exists(root, `${D}/en/de/other.md`)).toBe(true);
    });
  });

  test("a document with no files on disk is renamed in the database alone", async () => {
    await setup(async (_sql, ctx) => {
      const { id } = await createDocument(ctx, { collection: "docs" });
      await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "lonely" } });
      await publish(ctx, { docId: id, locale: "shared" });
      const root = project({ [`${D}/x.md`]: page("X") });
      const r = await ren(ctx, root, "lonely", "alone");
      expect(r.actions).toEqual([]);
      expect((await docOf(ctx, "alone")).id).toBe(id);
    });
  });

  test("the depth rule sees a fileRefs leaf, an MDX import specifier and a reference held only by a translation's draft head", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "guides/hero.md": page("Hero", "hero:\n  image:\n    file: ./x.png\n", "Body"),
        "guides/m.mdx": page("M", "", "import X from './X.astro'\n\n<X />"),
        "guides/d.md": page("D"), "de/guides/d.md": page("Dee", "", "Text"),
        "guides/ok.mdx": page("Ok", "", "import X from 'pkg'\n\n<X />"),
      });
      await imp(ctx, root);
      await exp(ctx, root);
      const d = await docOf(ctx, "guides/d");
      await saveDraft(ctx, { docId: d.id, locale: "de", data: { ...d.locales["de"]!.published!.data, body: markdownToTree("![i](./x.png)", { mode: "md" }) } });
      expect((await docOf(ctx, "guides/d")).locales["de"]!.draft).not.toBeNull();
      await expect(ren(ctx, root, "guides/hero", "hero")).rejects.toThrow(/relative file references/);
      await expect(ren(ctx, root, "guides/m", "m")).rejects.toThrow(/relative file references/);
      await expect(ren(ctx, root, "guides/d", "d")).rejects.toThrow(/de draft head/);
      // A bare package import is not a file reference.
      await ren(ctx, root, "guides/ok", "ok");
      expect(exists(root, `${D}/ok.mdx`)).toBe(true);
    });
  });

  test("a pending shared draft that is not an interrupted rename refuses the rename before any write, dry run included", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      const doc = await docOf(ctx, "guides/old");
      const { version } = await saveDraft(ctx, { docId: doc.id, locale: "shared", data: { ...doc.shared.published!.data, sidebarOrder: 9 } });
      const before = readTree(root);
      for (const dryRun of [true, false]) {
        await expect(ren(ctx, root, "guides/old", "guides/new", { dryRun })).rejects.toThrow(
          'guides/old: the shared scope has an unpublished draft; publish or discard it before renaming',
        );
      }
      await expect(ren(ctx, root, "guides/old", "guides/new")).rejects.toBeInstanceOf(ValidationError);
      expect(readTree(root)).toEqual(before);
      const after = await docOf(ctx, "guides/old");
      expect(after.shared.published!.version).toBe(doc.shared.published!.version);
      expect(after.shared.draft!.version).toBe(version);
      expect(after.shared.draft!.data["sidebarOrder"]).toBe(9);
    });
  });

  test("a manifest entry whose locale file is gone gets the new slug and the path export would write", async () => {
    await setup(async (_sql, ctx) => {
      const root = await twoLocales(ctx);
      fs.rmSync(abs(root, `${D}/de/guides/old.md`));
      await ren(ctx, root, "guides/old", "guides/new");
      expect(manifestOf(root).map((e) => [e.locale, e.slug, e.path])).toEqual([
        ["de", "guides/new", `${D}/de/guides/new.md`], ["zh-CN", "guides/new", `${D}/zh-cn/guides/new.md`],
      ]);
      const e = await exp(ctx, root);
      expect(e.warnings.filter((w) => /does not know/.test(w.message))).toEqual([]);
    });
  });
});
