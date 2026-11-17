import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeFileAtomic } from "../../src/starlight/fsSafe.js";

const tmp: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("writeFileAtomic durability", () => {
  test("fsyncs the file before the rename and the parent folder after it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mog-fs-"));
    tmp.push(root);
    const events: string[] = [];
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => { events.push("fsync"); realFsync(fd); });
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => { events.push("rename"); realRename(a, b); });
    writeFileAtomic(root, "docs/a.md", "text\n");
    expect(events).toEqual(["fsync", "rename", "fsync"]);
    expect(fs.readFileSync(path.join(root, "docs", "a.md"), "utf8")).toBe("text\n");
  });

  test("a parent folder that refuses fsync is not an error", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mog-fs-"));
    tmp.push(root);
    const realFsync = fs.fsyncSync;
    let n = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++n === 2) throw Object.assign(new Error("not supported"), { code: "EINVAL" });
      realFsync(fd);
    });
    expect(() => writeFileAtomic(root, "docs/a.md", "x")).not.toThrow();
    expect(fs.readFileSync(path.join(root, "docs", "a.md"), "utf8")).toBe("x");
  });
});
