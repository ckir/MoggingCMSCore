import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

// The history gate scripts/check-0001-frozen.mjs is the twin of the hash pin in migrate.test.ts: it is the only guard
// against editing 0001 AND updating the pin in one commit. Each scenario runs the REAL script inside a throwaway clone
// of this repository, so the exit code and message are what CI sees. Needs the full history back to the freeze base.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "check-0001-frozen.mjs");
const FILE = "packages/core/migrations/0001_engine.sql";
const PIN_TEST = "packages/core/test/migrate.test.ts";
const FREEZE_BASE = /FREEZE_BASE = "([0-9a-f]{40})"/.exec(readFileSync(SCRIPT, "utf8"))![1]!;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const historyPresent = (() => {
  try {
    execFileSync("git", ["cat-file", "-e", `${FREEZE_BASE}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Clones this repository into a temp dir (full history unless `shallow`) and returns its path. */
function clone(shallow = false): string {
  const parent = mkdtempSync(join(tmpdir(), "mog-frozen-"));
  dirs.push(parent);
  const dest = join(parent, "clone");
  if (shallow) git(parent, "clone", "--quiet", "--depth", "1", `file://${ROOT}`, dest);
  else git(parent, "clone", "--quiet", "--no-hardlinks", ROOT, dest);
  return dest;
}

/** Runs the real gate script with `cwd` as the repository under check. */
function gate(cwd: string): { status: number | null; out: string; err: string } {
  const r = spawnSync("node", [SCRIPT], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!historyPresent)("check-0001-frozen gate (needs the full git history)", () => {
  test("passes on an untouched clone", () => {
    const r = gate(clone());
    expect(r.status).toBe(0);
    expect(r.out).toContain("check:frozen: OK");
  }, 60_000);

  test("passes when a later commit adds 0002 and leaves 0001 alone", () => {
    const dir = clone();
    writeFileSync(join(dir, "packages/core/migrations/0002_next.sql"), "-- schema change\n");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "add 0002");
    const r = gate(dir);
    expect(r.status).toBe(0);
    expect(r.out).toContain("check:frozen: OK");
  }, 60_000);

  test("fails (exit 1, naming the commit) when a later commit edits 0001, even if the same commit updates the hash pin", () => {
    const dir = clone();
    appendFileSync(join(dir, FILE), "\n-- sneaky edit\n");
    appendFileSync(join(dir, PIN_TEST), "\n// pin updated in the same commit\n");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "edit 0001 and the pin together");
    const r = gate(dir);
    expect(r.status).toBe(1);
    expect(r.err).toContain("migration 0001 is frozen");
    expect(r.err).toContain("edit 0001 and the pin together");
    expect(r.err).toContain("add the schema change as a new migration (0002_*.sql)");
  }, 60_000);

  test("fails with exit 2 on a shallow clone, telling the caller to fetch the full history", () => {
    const r = gate(clone(true));
    expect(r.status).toBe(2);
    expect(r.err).toContain("is not in this clone");
    expect(r.err).toContain("fetch-depth: 0");
  }, 60_000);

  test("fails with exit 2 when HEAD does not descend from the freeze base", () => {
    const dir = clone();
    git(dir, "checkout", "--quiet", "--orphan", "alien");
    git(dir, "commit", "--quiet", "--allow-empty", "-m", "unrelated history");
    const r = gate(dir);
    expect(r.status).toBe(2);
    expect(r.err).toContain("does not descend from the freeze base");
  }, 60_000);
});
