import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Sql } from "postgres";
import { getDocument, migrate, publish, saveDraft } from "@mogging/core";
import type { Ctx } from "@mogging/core";
import { exportFolder } from "../../src/export.js";
import type { ExportReport } from "../../src/export.js";
import { importFolder } from "../../src/import.js";
import { markdownToTree } from "../../src/parse.js";
import type { StarlightLayout } from "../../src/starlight/layout.js";
import { withTestDb } from "../db.js";
import { ctxFor, layout, layoutOwn, project, readTree } from "./fixtures.js";

// The self-check test breaks the real renderer on demand; every other test runs the real one.
const hooks = vi.hoisted(() => ({ fault: false, renders: 0 }));
vi.mock("../../src/starlight/render.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/starlight/render.js")>();
  return {
    ...real,
    renderLocaleFile: (args: Parameters<typeof real.renderLocaleFile>[0]) => {
      hooks.renders++;
      const r = real.renderLocaleFile(args);
      return hooks.fault ? { ...r, text: r.text.replace(/^description:.*\n/m, "") } : r;
    },
  };
});

const D = "src/content/docs";
const MANIFEST = ".mogging/manifest.json";
const tmpDirs: string[] = [];

afterEach(() => {
  hooks.fault = false;
  vi.restoreAllMocks();
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
const outside = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mog-out-"));
  tmpDirs.push(d);
  return d;
};
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
const run = (
  ctx: Ctx, root: string, opts: Record<string, unknown> = {}, l: StarlightLayout = layout,
): Promise<ExportReport> => {
  const { locales, ...starlight } = opts;
  return exportFolder(ctx, { dir: root, ...(locales === undefined ? {} : { locales: locales as string[] }), starlight: { layout: l, ...starlight } });
};

/** Saves and publishes a translation through the SDK. */
async function translate(ctx: Ctx, slug: string, locale: string, data: Record<string, unknown>): Promise<void> {
  const doc = (await getDocument(ctx, { collection: "docs", slug }))!;
  await saveDraft(ctx, { docId: doc.id, locale, data });
  await publish(ctx, { docId: doc.id, locale });
}
const md = (s: string, mode: "md" | "mdx" = "md") => markdownToTree(s, { mode });

const manifestOf = (root: string): Array<{ path: string; slug: string; locale: string; version: number; sha256: string }> =>
  (JSON.parse(read(root, MANIFEST)) as { files: never[] }).files;
const manifestPaths = (root: string): string[] => manifestOf(root).map((e) => e.path);
const actionsOf = (r: ExportReport, action: string) => r.starlight!.actions.filter((a) => a.action === action);
const actionFor = (r: ExportReport, action: string, p: string) =>
  r.starlight!.actions.find((a) => a.action === action && a.path === p);
const attentionFiles = (r: ExportReport): string[] => r.starlight!.attention.map((a) => a.file);

describe("exportFolder, Starlight mode", () => {
  test("completeness: a head without title is skipped as incomplete, a splash page needs no body, a hero must be there", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "a.md": page("A"),
        "s.md": "---\ntitle: S\ntemplate: splash\n---\n",
        "h.md": page("H", "hero:\n  title: Welcome\n", "Body"),
      });
      await imp(ctx, root);
      await translate(ctx, "a", "de", { description: "nur Beschreibung" });
      await translate(ctx, "s", "de", { title: "Start" });
      await translate(ctx, "h", "de", { title: "H-de", body: md("Inhalt") });
      const r = await run(ctx, root);
      expect(actionFor(r, "skip", `${D}/de/a.md`)).toMatchObject({ reason: "incomplete" });
      expect(actionFor(r, "skip", `${D}/de/h.md`)).toMatchObject({ reason: "incomplete" });
      expect(exists(root, `${D}/de/a.md`)).toBe(false);
      expect(exists(root, `${D}/de/h.md`)).toBe(false);
      expect(read(root, `${D}/de/s.md`)).toBe("---\ntitle: Start\ntemplate: splash\n---\n");
      expect(r.starlight!.attention).toEqual([]);
      expect(r.files).toEqual([`${D}/de/s.md`]);

      await translate(ctx, "h", "de", { title: "H-de", body: md("Inhalt"), hero: { title: "Willkommen" } });
      const r2 = await run(ctx, root);
      expect(read(root, `${D}/de/h.md`)).toBe("---\ntitle: H-de\nhero:\n  title: Willkommen\n---\nInhalt\n");
      expect(r2.files).toEqual([`${D}/de/h.md`]);
    });
  });

  test("writes a new locale file under the English name; files and manifest list it; a second run keeps everything", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "guides/B Page.mdx": page("B", "", "Text") });
      await imp(ctx, root);
      await translate(ctx, "a", "de", { title: "Hallo", body: md("Welt") });
      await translate(ctx, "guides/b-page", "de", { title: "Seite", body: md("Text de", "mdx") });
      const r = await run(ctx, root);
      expect(read(root, `${D}/de/a.md`)).toBe("---\ntitle: Hallo\n---\nWelt\n");
      expect(read(root, `${D}/de/guides/B Page.mdx`)).toBe("---\ntitle: Seite\n---\nText de\n");
      expect(r.files).toEqual([`${D}/de/a.md`, `${D}/de/guides/B Page.mdx`]);
      expect(actionFor(r, "write", `${D}/de/a.md`)).toBeDefined();
      expect(r.starlight).toMatchObject({ dryRun: false, attention: [] });
      expect(manifestOf(root)).toEqual([
        { path: `${D}/de/a.md`, slug: "a", locale: "de", version: 1, sha256: sha("---\ntitle: Hallo\n---\nWelt\n") },
        { path: `${D}/de/guides/B Page.mdx`, slug: "guides/b-page", locale: "de", version: 1, sha256: sha("---\ntitle: Seite\n---\nText de\n") },
      ]);
      expect(read(root, MANIFEST)).toMatch(/^\{"version":1,"files":\[\n\{"path":.*\},\n\{"path":.*\}\n\]\}\n$/);

      // Idempotent: the second run keeps both written files and changes no byte.
      const before = readTree(root);
      const manifestMtime = fs.statSync(abs(root, MANIFEST)).mtimeMs;
      const r2 = await run(ctx, root);
      expect(actionsOf(r2, "keep").map((a) => a.path)).toEqual([`${D}/de/a.md`, `${D}/de/guides/B Page.mdx`]);
      expect(actionsOf(r2, "write")).toEqual([]);
      expect(r2.files).toEqual([]);
      expect(readTree(root)).toEqual(before);
      expect(fs.statSync(abs(root, MANIFEST)).mtimeMs).toBe(manifestMtime);
    });
  });

  test("a locale-only key is kept while the file is kept and lost when the file is rewritten", async () => {
    await setup(async (_sql, ctx) => {
      const german = "---\ntitle: Hallo\nfoo: bar\n---\nWelt\n";
      const root = docsProject({ "a.md": page("A"), "de/a.md": german });
      await imp(ctx, root);
      const r = await run(ctx, root);
      expect(actionFor(r, "keep", `${D}/de/a.md`)).toBeDefined();
      expect(read(root, `${D}/de/a.md`)).toBe(german);

      put(root, `${D}/a.md`, page("A", "sidebar:\n  order: 3\n"));
      const r2 = await run(ctx, root);
      expect(actionFor(r2, "write", `${D}/de/a.md`)).toBeDefined();
      expect(read(root, `${D}/de/a.md`)).toBe("---\ntitle: Hallo\nsidebar:\n  order: 3\n---\nWelt\n");
    });
  });

  test("keep: a day-one file with its own formatting is kept byte for byte, rewritten when English changes, text unchanged", async () => {
    await setup(async (_sql, ctx) => {
      const german = '---\ntitle:   "Hallo"\n---\n\nWelt\n';
      const root = docsProject({ "a.md": page("A"), "de/a.md": german });
      await imp(ctx, root);
      const r1 = await run(ctx, root);
      expect(read(root, `${D}/de/a.md`)).toBe(german);
      expect(r1.files).toEqual([]);
      expect(manifestOf(root)).toEqual([
        { path: `${D}/de/a.md`, slug: "a", locale: "de", version: 1, sha256: sha(german) },
      ]);
      const manifestBytes = read(root, MANIFEST);
      await run(ctx, root);
      expect(read(root, MANIFEST)).toBe(manifestBytes);

      put(root, `${D}/a.md`, page("A", "sidebar:\n  order: 2\n"));
      const r2 = await run(ctx, root);
      expect(r2.files).toEqual([`${D}/de/a.md`]);
      expect(read(root, `${D}/de/a.md`)).toBe("---\ntitle: Hallo\nsidebar:\n  order: 2\n---\nWelt\n");
      expect(manifestOf(root)[0]!.sha256).toBe(sha(read(root, `${D}/de/a.md`)));
      const r3 = await run(ctx, root);
      expect(actionsOf(r3, "keep")).toHaveLength(1);
      expect(r3.files).toEqual([]);
    });
  });

  test("behind is rewritten and reported; pending and hand work are untouched and in attention; a pending locale draft is not", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "a.md": page("A"), "b.md": page("B"), "c.md": page("C"), "d.md": page("D"), "e.md": page("E"),
        "de/a.md": page("A1", "", "Eins"), "de/b.md": page("B1", "", "Eins"),
        "de/c.md": page("C1", "", "Eins"), "de/d.md": page("D1", "", "Eins"),
      });
      await imp(ctx, root);
      await run(ctx, root);
      expect(manifestPaths(root)).toHaveLength(4);

      await translate(ctx, "a", "de", { title: "A neu", body: md("Neu") });
      put(root, `${D}/de/b.md`, page("B zwei", "", "Eins"));
      await imp(ctx, root); // b becomes a human draft: pending
      put(root, `${D}/de/c.md`, page("C zwei", "", "Eins")); // never imported: hand work
      put(root, `${D}/de/d.md`, page("D zwei", "draft: true\n", "Eins"));
      await imp(ctx, root); // a locale draft: pending, unpublished
      const bytes = { b: read(root, `${D}/de/b.md`), c: read(root, `${D}/de/c.md`), d: read(root, `${D}/de/d.md`) };

      const r = await run(ctx, root);
      expect(read(root, `${D}/de/a.md`)).toBe("---\ntitle: A neu\n---\nNeu\n");
      expect(actionFor(r, "write", `${D}/de/a.md`)).toMatchObject({ reason: "behind" });
      expect(r.warnings.some((w) => w.file === `${D}/de/a.md` && /behind/.test(w.message))).toBe(true);
      expect(read(root, `${D}/de/b.md`)).toBe(bytes.b);
      expect(read(root, `${D}/de/c.md`)).toBe(bytes.c);
      expect(read(root, `${D}/de/d.md`)).toBe(bytes.d);
      for (const f of ["b", "c", "d"]) expect(actionFor(r, "skip", `${D}/de/${f}.md`)).toBeDefined();
      expect(attentionFiles(r).sort()).toEqual([`${D}/de/b.md`, `${D}/de/c.md`]);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`]);
    });
  });

  test("the self-check throws the internal error before any write and leaves the target unchanged", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A", "description: Eng\n"), "de/a.md": page("Eins", "", "Eins") });
      await imp(ctx, root);
      await translate(ctx, "a", "de", { title: "Zwei", description: "Beschreibung", body: md("Zwei") });
      const before = readTree(root);
      hooks.fault = true;
      await expect(run(ctx, root)).rejects.toThrow(`internal: export self-check failed for ${D}/de/a.md: description`);
      expect(readTree(root)).toEqual(before);
      hooks.fault = false;
      await run(ctx, root);
      expect(read(root, `${D}/de/a.md`)).toContain("description: Beschreibung");
    });
  });

  test("English files are never written: bytes and mtimes are unchanged", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "b.mdx": page("B") });
      await imp(ctx, root);
      await translate(ctx, "a", "de", { title: "Hallo", body: md("Welt") });
      const stat = (f: string) => { const s = fs.statSync(abs(root, `${D}/${f}`)); return [s.mtimeMs, s.size, read(root, `${D}/${f}`)]; };
      const before = [stat("a.md"), stat("b.mdx")];
      await run(ctx, root);
      await run(ctx, root, { dryRun: true });
      expect([stat("a.md"), stat("b.mdx")]).toEqual(before);
    });
  });

  test("a live document whose English file is gone: its locale files are skipped, reported, not recreated", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "a.md": page("A"), "b.md": page("B"), "de/a.md": page("A1", "", "Eins"), "de/b.md": page("B1", "", "Eins"),
      });
      await imp(ctx, root);
      await run(ctx, root);
      fs.rmSync(abs(root, `${D}/a.md`));
      await translate(ctx, "a", "de", { title: "A neu", body: md("Neu") });
      await translate(ctx, "a", "zh-CN", { title: "A zh", body: md("Zh") });
      const before = readTree(root);
      const r = await run(ctx, root);
      expect(readTree(root)).toEqual(before);
      expect(r.starlight!.attention).toHaveLength(1);
      expect(r.starlight!.attention[0]!.message).toMatch(/English file/);
      expect(r.starlight!.attention[0]!.file).toContain("a");
      expect(actionsOf(r, "write")).toEqual([]);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
    });
  });

  test("an English file that cannot be read is reported like a missing one", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("A1", "", "Eins") });
      await imp(ctx, root);
      await run(ctx, root);
      put(root, `${D}/a.md`, "---\ntitle: A\nslug: other\n---\nHello\n");
      await translate(ctx, "a", "de", { title: "A neu", body: md("Neu") });
      const before = readTree(root);
      const r = await run(ctx, root);
      expect(readTree(root)).toEqual(before);
      expect(r.starlight!.attention).toHaveLength(1);
      expect(r.starlight!.attention[0]!.message).toMatch(/cannot be read.*slug/s);
    });
  });

  test("extension change: a manifest-listed published file is replaced under the new extension; an unlisted one is left with both reported", async () => {
    await setup(async (_sql, ctx) => {
      const listed = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt") });
      await imp(ctx, listed);
      await run(ctx, listed);
      fs.renameSync(abs(listed, `${D}/a.md`), abs(listed, `${D}/a.mdx`));
      const r = await run(ctx, listed);
      expect(read(listed, `${D}/de/a.mdx`)).toBe("---\ntitle: Hallo\n---\nWelt\n");
      expect(exists(listed, `${D}/de/a.md`)).toBe(false);
      expect(actionFor(r, "remove", `${D}/de/a.md`)).toBeDefined();
      expect(actionFor(r, "write", `${D}/de/a.mdx`)).toBeDefined();
      expect(manifestPaths(listed)).toEqual([`${D}/de/a.mdx`]);
      expect(r.starlight!.attention).toEqual([]);

      const unlisted = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt") });
      await imp(ctx, unlisted);
      fs.renameSync(abs(unlisted, `${D}/a.md`), abs(unlisted, `${D}/a.mdx`));
      const r2 = await run(ctx, unlisted);
      expect(read(unlisted, `${D}/de/a.md`)).toBe(page("Hallo", "", "Welt"));
      expect(exists(unlisted, `${D}/de/a.mdx`)).toBe(false);
      expect(actionFor(r2, "skip", `${D}/de/a.md`)).toBeDefined();
      expect(actionFor(r2, "skip", `${D}/de/a.mdx`)).toBeDefined();
      expect(r2.warnings.some((w) => /de\/a\.md/.test(w.message) && /de\/a\.mdx/.test(w.message))).toBe(true);
    });
  });

  test("day-one name: a case-only difference is one rename; a name that differs beyond case is written and the old file removed", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "Getting-Started.md": page("GS"), "de/getting-started.md": page("Los geht's", "", "Text") });
      await imp(ctx, root);
      const rename = vi.spyOn(fs, "renameSync");
      const r = await run(ctx, root);
      const moves = rename.mock.calls.filter(([from]) => String(from).endsWith(`${D}/de/getting-started.md`));
      expect(moves).toHaveLength(1);
      expect(String(moves[0]![1])).toBe(abs(root, `${D}/de/Getting-Started.md`));
      expect(actionFor(r, "move", `${D}/de/getting-started.md`)).toMatchObject({ to: `${D}/de/Getting-Started.md` });
      expect(exists(root, `${D}/de/getting-started.md`)).toBe(false);
      expect(manifestOf(root)).toEqual([
        { path: `${D}/de/Getting-Started.md`, slug: "getting-started", locale: "de", version: 1, sha256: sha(read(root, `${D}/de/Getting-Started.md`)) },
      ]);
      expect(read(root, `${D}/de/Getting-Started.md`)).toContain("Los geht's");

      const spaced = docsProject({ "Getting-Started.md": page("GS"), "de/Getting Started.md": page("Los geht's", "", "Text") });
      await imp(ctx, spaced);
      const r2 = await run(ctx, spaced);
      expect(Object.keys(readTree(spaced)).filter((f) => f.includes("/de/")).sort()).toEqual([`${D}/de/Getting-Started.md`]);
      expect(read(spaced, `${D}/de/Getting-Started.md`)).toBe("---\ntitle: Los geht's\n---\nText\n");
      expect(actionFor(r2, "write", `${D}/de/Getting-Started.md`)).toBeDefined();
      expect(actionFor(r2, "remove", `${D}/de/Getting Started.md`)).toBeDefined();
      expect(manifestPaths(spaced)).toEqual([`${D}/de/Getting-Started.md`]);

      const hand = docsProject({ "Getting-Started.md": page("GS"), "de/Getting Started.md": page("Los geht's", "", "Text") });
      await imp(ctx, hand);
      put(hand, `${D}/de/Getting Started.md`, page("Anders", "", "Text"));
      const r3 = await run(ctx, hand);
      expect(Object.keys(readTree(hand)).filter((f) => f.includes("/de/"))).toEqual([`${D}/de/Getting Started.md`]);
      expect(attentionFiles(r3)).toEqual([`${D}/de/Getting Started.md`]);
    });
  });

  test("a case-only rename of the English file moves the locale file with one rename", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "Foo.md": page("Foo"), "de/Foo.md": page("Fuu", "", "Text") });
      await imp(ctx, root);
      await run(ctx, root);
      fs.renameSync(abs(root, `${D}/Foo.md`), abs(root, `${D}/foo.md`));
      put(root, `${D}/foo.md`, page("Foo", "sidebar:\n  order: 4\n"));
      const rename = vi.spyOn(fs, "renameSync");
      await run(ctx, root);
      const moves = rename.mock.calls.filter(([from]) => String(from) === abs(root, `${D}/de/Foo.md`));
      expect(moves).toHaveLength(1);
      expect(String(moves[0]![1])).toBe(abs(root, `${D}/de/foo.md`));
      expect(Object.keys(readTree(root)).filter((f) => f.includes("/de/"))).toEqual([`${D}/de/foo.md`]);
      expect(read(root, `${D}/de/foo.md`)).toContain("order: 4");
      expect(manifestPaths(root)).toEqual([`${D}/de/foo.md`]);
    });
  });

  test("a toggle of true in English and none in the file is the same: kept on every export; a symlinked leftover is unlinked only", async () => {
    await setup(async (_sql, ctx) => {
      const german = page("Hallo", "", "Welt");
      const root = docsProject({ "a.md": page("A", "prev: true\n"), "de/a.md": german });
      const out = outside();
      fs.writeFileSync(path.join(out, "secret.txt"), "keep");
      await imp(ctx, root);
      fs.symlinkSync(path.join(out, "secret.txt"), abs(root, `${D}/de/a.md.0a1b.mogging-tmp`));
      const r1 = await run(ctx, root);
      expect(read(root, `${D}/de/a.md`)).toBe(german);
      expect(actionFor(r1, "keep", `${D}/de/a.md`)).toBeDefined();
      expect(actionFor(r1, "remove", `${D}/de/a.md.0a1b.mogging-tmp`)).toBeDefined();
      expect(exists(root, `${D}/de/a.md.0a1b.mogging-tmp`)).toBe(false);
      expect(fs.existsSync(path.join(out, "secret.txt"))).toBe(true);
      expect(r1.warnings.some((w) => w.file === `${D}/de/a.md.0a1b.mogging-tmp`)).toBe(true);
      const r2 = await run(ctx, root);
      expect(actionFor(r2, "keep", `${D}/de/a.md`)).toBeDefined();
      expect(read(root, `${D}/de/a.md`)).toBe(german);
    });
  });

  test("keep rule edges: a plain date that English quotes rewrites the file; a kept file is never rendered", async () => {
    await setup(async (_sql, ctx) => {
      const german = page("Hallo", "lastUpdated: 2026-01-01\n", "Welt");
      const root = docsProject({ "a.md": page("A", "lastUpdated: 2026-01-01\n"), "de/a.md": german });
      await imp(ctx, root);
      hooks.renders = 0;
      const r1 = await run(ctx, root);
      expect(actionFor(r1, "keep", `${D}/de/a.md`)).toBeDefined();
      expect(hooks.renders).toBe(0);
      expect(read(root, `${D}/de/a.md`)).toBe(german);

      put(root, `${D}/a.md`, page("A", 'lastUpdated: "2026-01-01"\n'));
      const r2 = await run(ctx, root);
      expect(actionFor(r2, "write", `${D}/de/a.md`)).toBeDefined();
      expect(read(root, `${D}/de/a.md`)).toBe('---\ntitle: Hallo\nlastUpdated: "2026-01-01"\n---\nWelt\n');
    });
  });

  test("a toggle English turns back on rewrites the file with the stored per-locale value", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A", "prev: false\n"), "de/a.md": page("Hallo", "prev: false\n", "Welt") });
      await imp(ctx, root);
      await translate(ctx, "a", "de", { title: "Hallo", body: md("Welt"), prev: { label: "Zurueck" } });
      put(root, `${D}/de/a.md`, page("Hallo", "prev: false\n", "Welt"));
      const r1 = await run(ctx, root);
      expect(actionFor(r1, "keep", `${D}/de/a.md`)).toBeDefined();
      put(root, `${D}/a.md`, page("A"));
      const r2 = await run(ctx, root);
      expect(actionFor(r2, "write", `${D}/de/a.md`)).toBeDefined();
      expect(read(root, `${D}/de/a.md`)).toBe("---\ntitle: Hallo\nprev: Zurueck\n---\nWelt\n");
    });
  });

  test("symlinks: a linked locale folder, target file, docs folder or .mogging folder is refused and never written through", async () => {
    await setup(async (_sql, ctx) => {
      // a linked locale folder
      const a = docsProject({ "a.md": page("A") });
      await imp(ctx, a);
      await translate(ctx, "a", "de", { title: "Hallo", body: md("Welt") });
      const outA = outside();
      fs.symlinkSync(outA, abs(a, `${D}/de`));
      const ra = await run(ctx, a);
      expect(actionFor(ra, "refuse", `${D}/de/a.md`)).toBeDefined();
      expect(attentionFiles(ra)).toContain(`${D}/de/a.md`);
      expect(fs.readdirSync(outA)).toEqual([]);

      // a linked target file
      const b = docsProject({ "a.md": page("A") });
      await imp(ctx, b);
      const outB = outside();
      fs.writeFileSync(path.join(outB, "t.md"), "keep");
      fs.mkdirSync(abs(b, `${D}/de`));
      fs.symlinkSync(path.join(outB, "t.md"), abs(b, `${D}/de/a.md`));
      const rb = await run(ctx, b);
      expect(actionFor(rb, "refuse", `${D}/de/a.md`)).toBeDefined();
      expect(attentionFiles(rb)).toContain(`${D}/de/a.md`);
      expect(fs.readFileSync(path.join(outB, "t.md"), "utf8")).toBe("keep");
      expect(fs.readdirSync(outB)).toEqual(["t.md"]);

      // a linked docs folder
      const real = docsProject({ "a.md": page("A") });
      await imp(ctx, real);
      const linked = project({ "src/content/keep.txt": "x" });
      fs.symlinkSync(abs(real, D), abs(linked, D));
      const before = readTree(real);
      const rc = await run(ctx, linked);
      expect(actionFor(rc, "refuse", D)).toBeDefined();
      expect(attentionFiles(rc)).toContain(D);
      expect(readTree(real)).toEqual(before);
      expect(exists(linked, ".mogging")).toBe(false);

      // a linked .mogging folder: the file is written, the manifest is refused
      const d = docsProject({ "a.md": page("A") });
      await imp(ctx, d);
      const outD = outside();
      fs.symlinkSync(outD, abs(d, ".mogging"));
      const rd = await run(ctx, d);
      expect(read(d, `${D}/de/a.md`)).toBe("---\ntitle: Hallo\n---\nWelt\n");
      expect(actionFor(rd, "refuse", MANIFEST)).toBeDefined();
      expect(attentionFiles(rd)).toContain(MANIFEST);
      expect(fs.readdirSync(outD)).toEqual([]);
    });
  });

  test("own-folder mode: a new locale file and a day-one name adoption", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "en/a.md": page("A"), "en/Getting-Started.md": page("GS"), "de/getting-started.md": page("Los", "", "Text"),
      });
      await imp(ctx, root, layoutOwn);
      await translate(ctx, "a", "de", { title: "Hallo", body: md("Welt") });
      const r = await run(ctx, root, {}, layoutOwn);
      expect(read(root, `${D}/de/a.md`)).toBe("---\ntitle: Hallo\n---\nWelt\n");
      expect(exists(root, `${D}/de/getting-started.md`)).toBe(false);
      expect(exists(root, `${D}/de/Getting-Started.md`)).toBe(true);
      expect(actionFor(r, "move", `${D}/de/getting-started.md`)).toBeDefined();
      expect(manifestPaths(root)).toEqual([`${D}/de/Getting-Started.md`, `${D}/de/a.md`]);
      expect(r.starlight!.attention).toEqual([]);
    });
  });

  test("locale skip: starlightLocaleDirs names the folders Starlight knows; null writes as configured", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A") });
      await imp(ctx, root);
      await translate(ctx, "a", "de", { title: "Hallo", body: md("Welt") });
      await translate(ctx, "a", "zh-CN", { title: "Ni hao", body: md("Shijie") });
      const r = await run(ctx, root, { starlightLocaleDirs: ["de"] });
      expect(exists(root, `${D}/de/a.md`)).toBe(true);
      expect(exists(root, `${D}/zh-cn/a.md`)).toBe(false);
      expect(attentionFiles(r)).toEqual([`${D}/zh-cn`]);
      expect(actionFor(r, "skip", `${D}/zh-cn`)).toBeDefined();
      const r2 = await run(ctx, root, { starlightLocaleDirs: null });
      expect(exists(root, `${D}/zh-cn/a.md`)).toBe(true);
      expect(r2.starlight!.attention).toEqual([]);
    });
  });

  for (const [name, l, base] of [["root-locale", layout, D], ["own-folder", layoutOwn, `${D}/en`]] as const) {
    test(`an MDX block that does not parse skips only that page (${name})`, async () => {
      await setup(async (_sql, ctx) => {
        const root = project({
          [`${base}/a.mdx`]: page("A"), [`${base}/b.mdx`]: page("B"), [`${D}/de/a.mdx`]: page("Eins", "", "Eins"),
        });
        await imp(ctx, root, l);
        await run(ctx, root, {}, l);
        const old = read(root, `${D}/de/a.mdx`);
        const entryBefore = manifestOf(root).find((e) => e.path === `${D}/de/a.mdx`);
        const broken = { type: "root", version: 1, mode: "mdx", children: [{ type: "opaqueBlock", node: "mdxjsEsm", source: "import X from" }] };
        await translate(ctx, "a", "de", { title: "Zwei", body: broken });
        await translate(ctx, "b", "de", { title: "B de", body: md("Text", "mdx") });
        const r = await run(ctx, root, {}, l);
        expect(read(root, `${D}/de/a.mdx`)).toBe(old);
        expect(manifestOf(root).find((e) => e.path === `${D}/de/a.mdx`)).toEqual(entryBefore);
        expect(attentionFiles(r)).toEqual([`${D}/de/a.mdx`]);
        expect(actionFor(r, "skip", `${D}/de/a.mdx`)).toBeDefined();
        expect(read(root, `${D}/de/b.mdx`)).toBe("---\ntitle: B de\n---\nText\n");
      });
    });
  }

  test("mode change: a body valid in both modes is written; one that cannot change mode is skipped into attention", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "a.md": page("A"), "c.md": page("C"), "b.mdx": page("B"), "d.md": page("D"), "e.md": page("E"),
        "de/a.md": page("Hallo", "", "Welt"),
        "de/c.md": page("C-de", "", "a <b>x</b> c"), "de/d.md": page("D-de", "", "braces {x} here"), "de/e.md": page("E-de", "", "{x}"),
        "de/b.mdx": page("B-de", "", 'import X from "./x.astro"\n\nWelt'),
      });
      await imp(ctx, root);
      await run(ctx, root);
      fs.renameSync(abs(root, `${D}/a.md`), abs(root, `${D}/a.mdx`));
      fs.renameSync(abs(root, `${D}/c.md`), abs(root, `${D}/c.mdx`));
      fs.renameSync(abs(root, `${D}/d.md`), abs(root, `${D}/d.mdx`));
      fs.renameSync(abs(root, `${D}/e.md`), abs(root, `${D}/e.mdx`));
      fs.renameSync(abs(root, `${D}/b.mdx`), abs(root, `${D}/b.md`));
      const deC = read(root, `${D}/de/c.md`);
      const deB = read(root, `${D}/de/b.mdx`);
      const r = await run(ctx, root);
      expect(read(root, `${D}/de/a.mdx`)).toBe("---\ntitle: Hallo\n---\nWelt\n");
      expect(exists(root, `${D}/de/a.md`)).toBe(false);
      expect(read(root, `${D}/de/c.md`)).toBe(deC);
      expect(exists(root, `${D}/de/c.mdx`)).toBe(false);
      expect(read(root, `${D}/de/b.mdx`)).toBe(deB);
      expect(exists(root, `${D}/de/b.md`)).toBe(false);
      expect(attentionFiles(r).sort()).toEqual([`${D}/de/b.md`, `${D}/de/c.mdx`]);
      // A brace in an md body is escaped when written as mdx and re-parses to the same tree, so that page is written
      // (the plan's example of a skip, `{x}`, is not one: measured, the MDX serializer writes `\\{x}`).
      expect(read(root, `${D}/de/d.mdx`)).toBe("---\ntitle: D-de\n---\nbraces \\{x} here\n");
      expect(exists(root, `${D}/de/d.md`)).toBe(false);
      // A body that is only `{x}` behaves the same way.
      expect(read(root, `${D}/de/e.mdx`)).toBe("---\ntitle: E-de\n---\n\\{x}\n");
      expect(exists(root, `${D}/de/e.md`)).toBe(false);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.mdx`, `${D}/de/b.mdx`, `${D}/de/c.md`, `${D}/de/d.mdx`, `${D}/de/e.mdx`]);
    });
  });

  test("manifest carry-over: a locale filter keeps the other locales' entries", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt"), "zh-cn/a.md": page("Nihao", "", "Shijie") });
      await imp(ctx, root);
      await run(ctx, root);
      const zh = manifestOf(root).find((e) => e.locale === "zh-CN")!;
      expect(zh.path).toBe(`${D}/zh-cn/a.md`);
      put(root, `${D}/a.md`, page("A", "sidebar:\n  order: 1\n"));
      const r = await run(ctx, root, { locales: ["de"] });
      expect(r.files).toEqual([`${D}/de/a.md`]);
      expect(manifestOf(root).find((e) => e.locale === "zh-CN")).toEqual(zh);
      expect(read(root, `${D}/zh-cn/a.md`)).toBe(page("Nihao", "", "Shijie"));
      expect(manifestOf(root).find((e) => e.locale === "de")!.sha256).toBe(sha(read(root, `${D}/de/a.md`)));
    });
  });

  test("leftovers of an interrupted run are removed and reported; a dry run lists them and leaves them", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt") });
      await imp(ctx, root);
      put(root, `${D}/de/a.md.0a1b.mogging-tmp`, "half");
      put(root, ".mogging/manifest.json.00ff.mogging-tmp", "half");
      const dry = await run(ctx, root, { dryRun: true });
      expect(actionsOf(dry, "remove").map((a) => a.path)).toEqual([`${D}/de/a.md.0a1b.mogging-tmp`, ".mogging/manifest.json.00ff.mogging-tmp"]);
      expect(exists(root, `${D}/de/a.md.0a1b.mogging-tmp`)).toBe(true);
      expect(exists(root, ".mogging/manifest.json.00ff.mogging-tmp")).toBe(true);
      const real = await run(ctx, root);
      expect(real.starlight!.actions).toEqual(dry.starlight!.actions);
      expect(exists(root, `${D}/de/a.md.0a1b.mogging-tmp`)).toBe(false);
      expect(exists(root, ".mogging/manifest.json.00ff.mogging-tmp")).toBe(false);
      expect(real.warnings.map((w) => w.file)).toEqual(expect.arrayContaining([`${D}/de/a.md.0a1b.mogging-tmp`]));
    });
  });

  test("a crash between two files leaves whole files; the next run keeps the first and finishes the second", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "b.md": page("B"), "de/b.md": page("B1", "", "Eins") });
      await imp(ctx, root);
      await translate(ctx, "a", "de", { title: "A de", body: md("Text") });
      await translate(ctx, "b", "de", { title: "B zwei", body: md("Zwei") });
      const oldB = read(root, `${D}/de/b.md`);
      const real = fs.renameSync;
      let n = 0;
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        n++;
        if (n === 2) throw new Error("disk full");
        return real(from, to);
      });
      await expect(run(ctx, root)).rejects.toThrow("disk full");
      vi.restoreAllMocks();
      expect(read(root, `${D}/de/a.md`)).toBe("---\ntitle: A de\n---\nText\n");
      expect(read(root, `${D}/de/b.md`)).toBe(oldB);
      expect(Object.keys(readTree(root)).filter((f) => f.endsWith(".mogging-tmp"))).toEqual([]);
      const r = await run(ctx, root);
      expect(actionFor(r, "keep", `${D}/de/a.md`)).toBeDefined();
      expect(actionFor(r, "write", `${D}/de/b.md`)).toMatchObject({ reason: "behind" });
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
    });
  });

  test("a dry run plans the same actions as the real run and writes nothing", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "a.md": page("A"), "b.md": page("B"), "Getting-Started.md": page("GS"),
        "de/b.md": page("B1", "", "Eins"), "de/getting-started.md": page("Los", "", "Text"),
      });
      await imp(ctx, root);
      await translate(ctx, "a", "de", { title: "Hallo", body: md("Welt") });
      await translate(ctx, "b", "de", { title: "B neu", body: md("Neu") });
      const before = readTree(root);
      const dry = await run(ctx, root, { dryRun: true });
      expect(readTree(root)).toEqual(before);
      expect(dry.starlight!.dryRun).toBe(true);
      expect(dry.files).toEqual([]);
      const real = await run(ctx, root);
      expect(real.starlight!.dryRun).toBe(false);
      expect(real.starlight!.actions).toEqual(dry.starlight!.actions);
      expect(real.starlight!.attention).toEqual(dry.starlight!.attention);
      expect(actionsOf(real, "write").length).toBeGreaterThanOrEqual(2);
    });
  });

  test("a corrupt manifest gives one warning, is treated as empty and is rewritten", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt") });
      await imp(ctx, root);
      put(root, MANIFEST, "{ not json");
      const r = await run(ctx, root);
      expect(r.warnings.filter((w) => w.file === MANIFEST)).toHaveLength(1);
      expect(manifestPaths(root)).toEqual([`${D}/de/a.md`]);
      expect(r.starlight!.attention).toEqual([]);
    });
  });

  test("a manifest-listed file deleted by hand is recreated with a warning", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt") });
      await imp(ctx, root);
      await run(ctx, root);
      fs.rmSync(abs(root, `${D}/de/a.md`));
      const r = await run(ctx, root);
      expect(read(root, `${D}/de/a.md`)).toBe("---\ntitle: Hallo\n---\nWelt\n");
      expect(r.warnings.some((w) => w.file === `${D}/de/a.md` && /recreated/.test(w.message))).toBe(true);
    });
  });
  test("keep rule: a mapped parent that only held localized keys is pruned on both sides", async () => {
    await setup(async (_sql, ctx) => {
      const german = page("Hallo", "sidebar:\n  label: Hilfe\n", "Welt");
      const root = docsProject({ "a.md": page("A", "sidebar:\n  label: Help\n"), "de/a.md": german });
      await imp(ctx, root);
      const r = await run(ctx, root);
      expect(actionFor(r, "keep", `${D}/de/a.md`)).toBeDefined();
      expect(read(root, `${D}/de/a.md`)).toBe(german);
    });
  });

  test("a manifest entry the layout does not accept is warned about and carried over unchanged", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt") });
      await imp(ctx, root);
      const stray = { path: "elsewhere/x.md", slug: "x", locale: "de", version: 3, sha256: "b".repeat(64) };
      put(root, MANIFEST, `{"version":1,"files":[\n${JSON.stringify(stray)}\n]}\n`);
      const r = await run(ctx, root);
      expect(r.warnings.some((w) => w.file === "elsewhere/x.md" && /ignored/.test(w.message))).toBe(true);
      expect(manifestOf(root).map((e) => e.path)).toEqual(["elsewhere/x.md", `${D}/de/a.md`]);
      expect(manifestOf(root)[0]).toEqual(stray);
    });
  });
});
