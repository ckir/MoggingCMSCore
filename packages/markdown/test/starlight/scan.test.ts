import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { scanDocs } from "../../src/starlight/scan.js";
import type { Scan, ScannedFile } from "../../src/starlight/scan.js";
import { config, layout, layoutOwn, project } from "./fixtures.js";

const D = "src/content/docs";

/** A project holding `files` (paths relative to the docs folder). */
function docsProject(files: Record<string, string>): string {
  return project(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${D}/${k}`, v])));
}

/** Links `<root>/<D>/<name>` to `target` (absolute or relative to the link's folder). */
function linkIn(root: string, name: string, target: string): void {
  const full = path.join(root, D, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.symlinkSync(target, full);
}

const slugs = (files: ScannedFile[]): string[] => files.map((f) => `${f.locale}:${f.slug}`).sort();
const byPath = (s: Scan, p: string): ScannedFile => [...s.sources, ...s.locales].find((f) => f.path === `${D}/${p}`)!;

describe("scanDocs, root-locale mode", () => {
  const root = docsProject({
    "index.mdx": "", "Getting-Started.md": "", "guides/_draft.md": "", "_partials/x.md": "", "notes.txt": "",
    "old.markdown": "", "x.mdoc": "", "de/getting-started.md": "", "zh-cn/index.mdx": "", "fr/a.md": "",
    "a.md": "", "A.md": "", "es/c.md": "", "constructor/page.md": "", ".hidden/h.md": "",
    "guides/.dot.md": "",
  });
  linkIn(root, "linked", "guides");
  const scan = scanDocs(root, layout, config);

  test("source pages by slug, underscore files skipped, underscore folders walked, D12 folder", () => {
    expect(slugs(scan.sources)).toEqual([
      "en:a", "en:a", "en:constructor/page", "en:es/c", "en:getting-started", "en:index", "en:_partials/x",
    ].sort());
    expect(byPath(scan, "_partials/x.md").slug).toBe("_partials/x");
    expect(byPath(scan, "index.mdx")).toMatchObject({ ext: ".mdx", rel: "index.mdx", error: null, locale: "en" });
    expect(scan.sources.some((f) => f.path.includes("_draft") || f.path.includes("hidden") || f.path.includes(".dot"))).toBe(false);
  });

  test("locale files carry the BCP 47 tag", () => {
    expect(slugs(scan.locales)).toEqual(["de:getting-started", "zh-CN:index"]);
    expect(byPath(scan, "zh-cn/index.mdx")).toMatchObject({ locale: "zh-CN", rel: "index.mdx", slug: "index" });
  });

  test("DE/ alone is German (matched by its slugified name)", () => {
    const s = scanDocs(docsProject({ "DE/b.md": "" }), layout, config);
    expect(s.locales).toEqual([{ path: `${D}/DE/b.md`, locale: "de", rel: "b.md", slug: "b", ext: ".md", error: null }]);
  });

  test("notes.txt is ignored; other Starlight extensions are unsupported", () => {
    expect(scan.unsupported).toEqual([
      { path: `${D}/old.markdown`, locale: "en", slug: "old" },
      { path: `${D}/x.mdoc`, locale: "en", slug: "x" },
    ]);
  });

  test("fr/ is skipped with one warning; es/ is English with one warning", () => {
    expect(scan.sources.some((f) => f.path.includes("/fr/"))).toBe(false);
    const fr = scan.warnings.filter((w) => w.file === `${D}/fr`);
    expect(fr).toHaveLength(1);
    const es = scan.warnings.filter((w) => w.file === `${D}/es`);
    expect(es).toHaveLength(1);
    expect(es[0]!.message).toContain("imported as English pages; if it is a Starlight locale, list it in otherLocaleDirs");
    expect(scan.warnings.filter((w) => w.file.includes("constructor"))).toEqual([]);
  });

  test("a.md and A.md collide, both with an error", () => {
    expect(byPath(scan, "a.md").error).toBe(`slug collides with ${D}/A.md`);
    expect(byPath(scan, "A.md").error).toBe(`slug collides with ${D}/a.md`);
    expect(scan.sources.filter((f) => f.error !== null)).toHaveLength(2);
  });

  test("a symlinked folder is listed (not followed) and nothing under it is scanned", () => {
    expect(scan.symlinks).toEqual([{ path: `${D}/linked`, locale: "en", slug: "linked", kind: "folder" }]);
    expect(scan.sources.some((f) => f.path.includes("linked"))).toBe(false);
  });
});

describe("scanDocs, collisions and twins", () => {
  test(".md and .mdx twins keep the import message", () => {
    const s = scanDocs(docsProject({ "a.md": "", "a.mdx": "" }), layout, config);
    expect(s.sources.map((f) => f.error)).toEqual(["both .md and .mdx exist for this slug", "both .md and .mdx exist for this slug"]);
  });

  test("de/ and DE/ both map to German: every file under both is an error", () => {
    const s = scanDocs(docsProject({ "de/a.md": "", "DE/b.md": "" }), layout, config);
    expect(s.locales.map((f) => f.error).sort()).toEqual([`locale folder collides with ${D}/DE`, `locale folder collides with ${D}/de`]);
  });

  test("the same slug in different locales does not collide", () => {
    const s = scanDocs(docsProject({ "a.md": "", "de/a.md": "" }), layout, config);
    expect([...s.sources, ...s.locales].map((f) => f.error)).toEqual([null, null]);
  });

  test("a file whose name has no slug characters carries an error and an empty slug", () => {
    const s = scanDocs(docsProject({ "!!.md": "" }), layout, config);
    expect(s.sources[0]).toMatchObject({ slug: "", error: expect.stringContaining("empty slug segment") });
  });

  test("a top-level folder that looks like a locale warns only when no map names it", () => {
    const s = scanDocs(docsProject({ "pt-br/a.md": "", "guides/b.md": "", "api/c.md": "", "de/d.md": "" }), layout, config);
    expect(s.warnings.map((w) => w.file)).toEqual([`${D}/pt-br`]);
  });
});

describe("scanDocs, symbolic links", () => {
  test("v1.2/ linked has folder slug v12", () => {
    const root = docsProject({ "real/a.md": "" });
    linkIn(root, "v1.2", "real");
    expect(scanDocs(root, layout, config).symlinks).toEqual([{ path: `${D}/v1.2`, locale: "en", slug: "v12", kind: "folder" }]);
  });

  test("a dangling guides link is a listed folder", () => {
    const root = docsProject({ "x.md": "" });
    linkIn(root, "guides", "../../../vendor/missing-submodule");
    const s = scanDocs(root, layout, config);
    expect(s.symlinks).toEqual([{ path: `${D}/guides`, locale: "en", slug: "guides", kind: "folder" }]);
    expect(s.warnings).toEqual([]);
  });

  test("a linked file with a Starlight extension is a listed file, even dangling", () => {
    const root = docsProject({ "x.md": "" });
    linkIn(root, "guides/Intro.mdx", "/nonexistent/intro.mdx");
    expect(scanDocs(root, layout, config).symlinks).toEqual([
      { path: `${D}/guides/Intro.mdx`, locale: "en", slug: "guides/intro", kind: "file" },
    ]);
  });

  test("assets/logo.png linked is a listed folder (it may be a folder of pages), never followed", () => {
    const root = docsProject({ "assets/real.png": "" });
    linkIn(root, "assets/logo.png", "real.png");
    const s = scanDocs(root, layout, config);
    expect(s.symlinks).toEqual([{ path: `${D}/assets/logo.png`, locale: "en", slug: "assets/logopng", kind: "folder" }]);
    expect(s.warnings).toEqual([]);
  });

  test("a linked folder with a dot in its name (v1.x) is a folder whose slug v1x matches the pages under it", () => {
    const root = docsProject({ "real/a.md": "" });
    linkIn(root, "v1.x", "real");
    const s = scanDocs(root, layout, config);
    expect(s.symlinks).toEqual([{ path: `${D}/v1.x`, locale: "en", slug: "v1x", kind: "folder" }]);
    expect(s.warnings).toEqual([]);
    expect(slugs(s.sources)).toEqual(["en:real/a"]); // nothing under the link was scanned
  });

  test("a symlinked locale folder is a warning, not scanned", () => {
    const root = docsProject({ "other/a.md": "" });
    linkIn(root, "de", "other");
    const s = scanDocs(root, layout, config);
    expect(s.locales).toEqual([]);
    expect(s.symlinks).toEqual([]);
    expect(s.warnings.filter((w) => w.file === `${D}/de`)).toHaveLength(1);
  });

  test("a symlinked <docsDir> or parent is a warning and nothing is scanned", () => {
    const real = project({ "real/a.md": "" });
    fs.mkdirSync(path.join(real, "src/content"), { recursive: true });
    fs.symlinkSync(path.join(real, "real"), path.join(real, "src/content/docs"));
    const s = scanDocs(real, layout, config);
    expect(s.sources).toEqual([]);
    expect(s.warnings).toEqual([expect.objectContaining({ file: D })]);

    const parent = project({ "elsewhere/content/docs/a.md": "" });
    fs.symlinkSync(path.join(parent, "elsewhere"), path.join(parent, "src"));
    const p = scanDocs(parent, layout, config);
    expect(p.sources).toEqual([]);
    expect(p.warnings).toEqual([expect.objectContaining({ file: "src" })]);
  });

  test("a missing docs folder is an empty scan", () => {
    expect(scanDocs(project({ "x.txt": "" }), layout, config)).toEqual({
      sources: [], locales: [], unsupported: [], symlinks: [], warnings: [],
    });
  });

  test("a non-regular file is a warning", () => {
    const root = docsProject({ "a.md": "" });
    const fifo = path.join(root, D, "pipe.md");
    // mkfifo makes a non-regular file on Linux/macOS; the test is a no-op where it is absent.
    if (spawnSync("mkfifo", [fifo]).status !== 0) return;
    const s = scanDocs(root, layout, config);
    expect(s.sources.map((f) => f.rel)).toEqual(["a.md"]);
    expect(s.warnings).toEqual([{ file: `${D}/pipe.md`, message: "not a regular file; skipped" }]);
  });
});

describe("scanDocs, own-folder mode (sourceDir en)", () => {
  test("en/ is the source, de/ German, a top-level page is a warning", () => {
    const root = docsProject({ "en/a.md": "", "en/guides/Hello World.mdx": "", "de/a.md": "", "x.md": "", "fr/q.md": "", "misc/z.md": "" });
    linkIn(root, "en/linked", "guides");
    const s = scanDocs(root, layoutOwn, config);
    expect(s.sources.map((f) => [f.path, f.rel, f.slug, f.locale])).toEqual([
      [`${D}/en/a.md`, "a.md", "a", "en"],
      [`${D}/en/guides/Hello World.mdx`, "guides/Hello World.mdx", "guides/hello-world", "en"],
    ]);
    expect(s.locales.map((f) => [f.path, f.rel, f.locale])).toEqual([[`${D}/de/a.md`, "a.md", "de"]]);
    expect(s.warnings.map((w) => [w.file, w.message.includes("outside every locale folder")])).toEqual([
      [`${D}/fr`, false], [`${D}/misc`, true], [`${D}/x.md`, true],
    ]);
    expect(s.symlinks).toEqual([{ path: `${D}/en/linked`, locale: "en", slug: "linked", kind: "folder" }]);
  });

  test("a symlinked en/guides has slug guides, never en/guides", () => {
    const root = docsProject({ "en/a.md": "", "real/b.md": "" });
    linkIn(root, "en/guides", "../real");
    expect(scanDocs(root, layoutOwn, config).symlinks).toEqual([
      { path: `${D}/en/guides`, locale: "en", slug: "guides", kind: "folder" },
    ]);
  });

  test("a top-level non-page file is ignored silently", () => {
    const s = scanDocs(docsProject({ "en/a.md": "", "notes.txt": "", "_x.md": "" }), layoutOwn, config);
    expect(s.warnings).toEqual([]);
  });

  test("unsupported files under a locale folder carry the locale tag and a folder-relative slug", () => {
    const s = scanDocs(docsProject({ "zh-cn/g/old.mdwn": "" }), layout, config);
    expect(s.unsupported).toEqual([{ path: `${D}/zh-cn/g/old.mdwn`, locale: "zh-CN", slug: "g/old" }]);
  });
});
