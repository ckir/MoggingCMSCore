import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

// scripts/check-publish-ready.mjs (`pnpm check:publish`) run for real. The script finds its packages relative to its own
// location, so each test copies it (and its lib) into a throwaway mini-repository with two fake, dependency-free packages
// and runs it there: the exit codes, the OK/FAIL lines, the retained tarballs of `--release --out` and the cleanup are
// what the owner sees on release day.
const SCRIPTS = fileURLToPath(new URL("../../../scripts/", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type PackageSpec = { version?: string; private?: boolean; readme?: boolean };

/** A mini repository: the real scripts plus packages `aaa` and `bbb`, each publishable once `private` is false. */
function miniRepo(a: PackageSpec = {}, b: PackageSpec = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mog-publish-ready-"));
  dirs.push(root);
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  copyFileSync(join(SCRIPTS, "check-publish-ready.mjs"), join(root, "scripts", "check-publish-ready.mjs"));
  copyFileSync(join(SCRIPTS, "lib", "pack-checks.mjs"), join(root, "scripts", "lib", "pack-checks.mjs"));
  for (const [name, spec] of [["aaa", a], ["bbb", b]] as const) {
    const dir = join(root, "packages", name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "export const x = 1;\n");
    writeFileSync(join(dir, "dist", "index.d.ts"), "export declare const x = 1;\n");
    writeFileSync(join(dir, "LICENSE.md"), "licence\n");
    if (spec.readme !== false) writeFileSync(join(dir, "README.md"), "readme\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: `@mogging/${name}`, version: spec.version ?? "0.1.0", ...(spec.private === false ? {} : { private: true }),
      type: "module", license: "SEE LICENSE IN LICENSE.md", main: "./dist/index.js", types: "./dist/index.d.ts",
      files: ["dist", "README.md", "LICENSE.md"], publishConfig: { access: "public" },
    }));
  }
  return root;
}

const run = (root: string, ...args: string[]) => {
  const r = spawnSync("node", [join(root, "scripts", "check-publish-ready.mjs"), ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

describe("check-publish-ready", () => {
  test("a clean repository exits 0 with one OK line per package, and removes the LICENSE.md copies it relied on", () => {
    const root = miniRepo();
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.out).toContain("OK   @mogging/aaa@0.1.0 (");
    expect(r.out).toContain("OK   @mogging/bbb@0.1.0 (");
    expect(r.out).toContain("OK   all 2 tarballs are publishable");
    expect(existsSync(join(root, "packages/aaa/LICENSE.md"))).toBe(false);
    expect(existsSync(join(root, "packages/bbb/LICENSE.md"))).toBe(false);
  }, 120_000);

  test("a bad tarball exits 1 with a FAIL line naming the package and the rule, and the other package still reports OK", () => {
    const r = run(miniRepo({}, { readme: false }));
    expect(r.status).toBe(1);
    expect(r.err).toContain("FAIL @mogging/bbb: package/README.md is missing from the tarball");
    expect(r.out).toContain("OK   @mogging/aaa@0.1.0");
    expect(r.out).not.toContain("tarballs are publishable");
  }, 120_000);

  test("--release without --out exits 2 before packing anything, and so does --out followed by another flag", () => {
    const root = miniRepo();
    const none = run(root, "--release");
    expect(none.status).toBe(2);
    expect(none.err).toContain("--release needs --out DIR");
    const flag = run(root, "--release", "--out", "--other");
    expect(flag.status).toBe(2);
    expect(flag.err).toContain("--release needs --out DIR");
    expect(none.out + flag.out).toBe("");
  }, 120_000);

  test("--release --out DIR on release-ready packages exits 0 and keeps exactly the checked tarballs in DIR", () => {
    const root = miniRepo({ private: false }, { private: false });
    const out = join(root, "release");
    const r = run(root, "--release", "--out", out);
    expect(r.status).toBe(0);
    expect(r.out).toContain("all 2 tarballs are release-ready; publish exactly these files from");
    expect(readdirSync(out).sort()).toEqual(["mogging-aaa-0.1.0.tgz", "mogging-bbb-0.1.0.tgz"]);
  }, 120_000);

  test("--release fails (exit 1) when the packages are at different versions, naming both", () => {
    const root = miniRepo({ private: false, version: "0.1.0" }, { private: false, version: "0.1.1" });
    const r = run(root, "--release", "--out", join(root, "release"));
    expect(r.status).toBe(1);
    expect(r.err).toContain("the packages are at different versions: @mogging/aaa@0.1.0, @mogging/bbb@0.1.1");
  }, 120_000);

  test("--release fails (exit 1) on a private package, which the plain check accepts", () => {
    const root = miniRepo({ private: false }, {});
    expect(run(root).status).toBe(0);
    const r = run(root, "--release", "--out", join(root, "release"));
    expect(r.status).toBe(1);
    expect(r.err).toContain(`FAIL @mogging/bbb: "private": true would make npm refuse to publish it`);
  }, 120_000);
});
