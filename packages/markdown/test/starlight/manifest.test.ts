import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertNoSymlink, moveFile, removeFile, writeFileAtomic,
} from "../../src/starlight/fsSafe.js";
import { readManifest, writeManifest } from "../../src/starlight/manifest.js";
import type { ManifestEntry } from "../../src/starlight/manifest.js";

const roots: string[] = [];
const fresh = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mog-mf-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const SHA = "a".repeat(64);
const entry = (p: string, extra: Partial<ManifestEntry> = {}): ManifestEntry =>
  ({ path: p, slug: "a", locale: "de", version: 1, sha256: SHA, ...extra });
const manifestPath = (root: string): string => path.join(root, ".mogging", "manifest.json");

describe("manifest", () => {
  test("writes the documented format: one compact entry per line, sorted by path", () => {
    const root = fresh();
    writeManifest(root, [entry("docs/de/b.md", { slug: "b" }), entry("docs/de/a.md")]);
    expect(fs.readFileSync(manifestPath(root), "utf8")).toBe(
      '{"version":1,"files":[\n' +
      `{"path":"docs/de/a.md","slug":"a","locale":"de","version":1,"sha256":"${SHA}"},\n` +
      `{"path":"docs/de/b.md","slug":"b","locale":"de","version":1,"sha256":"${SHA}"}\n` +
      "]}\n",
    );
  });

  test("an empty manifest has no entry lines; reading gives the entries back", () => {
    const root = fresh();
    writeManifest(root, []);
    expect(fs.readFileSync(manifestPath(root), "utf8")).toBe('{"version":1,"files":[\n]}\n');
    expect(readManifest(root)).toEqual({ entries: [], warning: null });
    writeManifest(root, [entry("docs/de/a.md")]);
    expect(readManifest(root)).toEqual({ entries: [entry("docs/de/a.md")], warning: null });
  });

  test("a missing manifest is empty without a warning", () => {
    expect(readManifest(fresh())).toEqual({ entries: [], warning: null });
  });

  test("a corrupt manifest is empty with one warning (D9)", () => {
    for (const text of [
      "{not json", '{"version":2,"files":[]}', '{"version":1}', '{"version":1,"files":[{"path":1}]}',
      '{"version":1,"files":[{"path":"x","slug":"a","locale":"de","version":1,"sha256":"zz"}]}', "[]", "null",
    ]) {
      const root = fresh();
      fs.mkdirSync(path.join(root, ".mogging"));
      fs.writeFileSync(manifestPath(root), text);
      const r = readManifest(root);
      expect(r.entries, text).toEqual([]);
      expect(r.warning, text).toMatch(/manifest/);
    }
  });

  test("a manifest reached through a symbolic link is empty with a warning", () => {
    const root = fresh();
    const other = fresh();
    fs.writeFileSync(path.join(other, "manifest.json"), `{"version":1,"files":[\n]}\n`);
    fs.symlinkSync(other, path.join(root, ".mogging"));
    expect(readManifest(root).entries).toEqual([]);
    expect(readManifest(root).warning).toMatch(/symbolic link/);
  });

  test("writing identical content leaves the file and its mtime alone", () => {
    const root = fresh();
    writeManifest(root, [entry("docs/de/a.md")]);
    const old = new Date(2020, 1, 1);
    fs.utimesSync(manifestPath(root), old, old);
    writeManifest(root, [entry("docs/de/a.md")]);
    expect(fs.statSync(manifestPath(root)).mtime.getTime()).toBe(old.getTime());
  });

  test("a symlinked .mogging folder is refused and nothing is written through it", () => {
    const root = fresh();
    const other = fresh();
    fs.symlinkSync(other, path.join(root, ".mogging"));
    expect(() => writeManifest(root, [entry("docs/de/a.md")])).toThrow(/symbolic link/);
    expect(fs.readdirSync(other)).toEqual([]);
  });
});

describe("fsSafe", () => {
  test("assertNoSymlink throws on a linked component, the final one included, and passes on absent paths", () => {
    const root = fresh();
    const other = fresh();
    fs.mkdirSync(path.join(root, "d"));
    fs.symlinkSync(other, path.join(root, "d", "link"));
    fs.writeFileSync(path.join(other, "t.md"), "x");
    fs.symlinkSync(path.join(other, "t.md"), path.join(root, "d", "file.md"));
    expect(() => assertNoSymlink(root, "d/link/x.md")).toThrow(/symbolic link: d\/link/);
    expect(() => assertNoSymlink(root, "d/file.md")).toThrow(/symbolic link: d\/file.md/);
    expect(() => assertNoSymlink(root, "d/new/deeper/x.md")).not.toThrow();
    expect(() => assertNoSymlink(root, "../x")).toThrow();
    expect(() => assertNoSymlink(root, "/etc/x")).toThrow();
  });

  test("writeFileAtomic writes through a tmp file, creates parents and leaves no tmp file", () => {
    const root = fresh();
    writeFileAtomic(root, "a/b/c.md", "hello");
    expect(fs.readFileSync(path.join(root, "a/b/c.md"), "utf8")).toBe("hello");
    writeFileAtomic(root, "a/b/c.md", "again");
    expect(fs.readFileSync(path.join(root, "a/b/c.md"), "utf8")).toBe("again");
    expect(fs.readdirSync(path.join(root, "a/b"))).toEqual(["c.md"]);
  });

  test("writeFileAtomic never writes through a symlink target, a linked folder or a planted tmp link", () => {
    const root = fresh();
    const other = fresh();
    fs.writeFileSync(path.join(other, "secret.txt"), "keep");
    fs.symlinkSync(path.join(other, "secret.txt"), path.join(root, "t.md"));
    expect(() => writeFileAtomic(root, "t.md", "x")).toThrow(/symbolic link/);
    fs.symlinkSync(other, path.join(root, "dir"));
    expect(() => writeFileAtomic(root, "dir/t.md", "x")).toThrow(/symbolic link/);
    expect(fs.readFileSync(path.join(other, "secret.txt"), "utf8")).toBe("keep");
    expect(fs.readdirSync(other)).toEqual(["secret.txt"]);
  });

  test("writeFileAtomic opens its tmp file with O_EXCL and O_NOFOLLOW and removes it when the rename fails", () => {
    const root = fresh();
    const open = vi.spyOn(fs, "openSync");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("boom"); });
    expect(() => writeFileAtomic(root, "t.md", "x")).toThrow("boom");
    const flags = open.mock.calls[0]![1] as number;
    expect(flags & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(String(open.mock.calls[0]![0])).toMatch(/t\.md\.[0-9a-f]+\.mogging-tmp$/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test("moveFile is one rename and creates the parents of the target", () => {
    const root = fresh();
    fs.writeFileSync(path.join(root, "Foo.md"), "x");
    const rename = vi.spyOn(fs, "renameSync");
    moveFile(root, "Foo.md", "sub/foo.md");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, "sub/foo.md"), "utf8")).toBe("x");
    expect(fs.existsSync(path.join(root, "Foo.md"))).toBe(false);
  });

  test("removeFile unlinks a symlink without touching its target and refuses a linked parent", () => {
    const root = fresh();
    const other = fresh();
    fs.writeFileSync(path.join(other, "secret.txt"), "keep");
    fs.symlinkSync(path.join(other, "secret.txt"), path.join(root, "x.mogging-tmp"));
    removeFile(root, "x.mogging-tmp");
    expect(fs.existsSync(path.join(other, "secret.txt"))).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
    fs.symlinkSync(other, path.join(root, "dir"));
    expect(() => removeFile(root, "dir/secret.txt")).toThrow(/symbolic link/);
    expect(fs.existsSync(path.join(other, "secret.txt"))).toBe(true);
  });
});
