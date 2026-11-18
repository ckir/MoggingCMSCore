import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { checkTarball, entryFiles } from "../../../scripts/lib/pack-checks.mjs";

// Ship step 4: the publish-readiness rules (scripts/lib/pack-checks.mjs, run over real tarballs by
// scripts/check-publish-ready.mjs) and the prepack build gate (scripts/prepack.mjs).

const PREPACK = fileURLToPath(new URL("../../../scripts/prepack.mjs", import.meta.url));

describe("entryFiles", () => {
  test("collects main, types, a string bin, a bin map and every nested exports target, without the leading ./", () => {
    expect(entryFiles({ main: "./dist/index.js", types: "./dist/index.d.ts", bin: { a: "./dist/a.js" },
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./preset": "./dist/preset.js" } }).sort())
      .toEqual(["dist/a.js", "dist/index.d.ts", "dist/index.d.ts", "dist/index.js", "dist/index.js", "dist/preset.js"]);
    expect(entryFiles({ bin: "./dist/bin.js" })).toEqual(["dist/bin.js"]);
    expect(entryFiles({})).toEqual([]);
  });
});

/** A tarball that satisfies every rule; each test below breaks exactly one thing. */
function good() {
  return {
    listing: ["package/package.json", "package/LICENSE.md", "package/README.md", "package/dist/index.js", "package/dist/index.d.ts",
      "package/migrations/0001_engine.sql"],
    manifest: {
      name: "@mogging/x", version: "0.0.0", license: "SEE LICENSE IN LICENSE.md", main: "./dist/index.js", types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      dependencies: { "@mogging/core": "0.0.0", postgres: "^4" },
    } as Record<string, any>,
    source: { name: "@mogging/x", version: "0.0.0", files: ["dist", "migrations", "README.md", "LICENSE.md"], publishConfig: { access: "public" } } as Record<string, any>,
    siblings: new Map([["@mogging/core", "0.0.0"], ["@mogging/x", "0.0.0"]]),
    release: false,
  };
}

describe("checkTarball", () => {
  test("a clean tarball has no problems, as a check and as a release candidate that is not private", () => {
    expect(checkTarball(good())).toEqual([]);
    const r = good();
    r.manifest.version = "0.1.0";
    expect(checkTarball({ ...r, release: true })).toEqual([]);
  });

  test("a missing licence or readme is reported", () => {
    const g = good();
    g.listing = g.listing.filter((p) => !p.endsWith("LICENSE.md") && !p.endsWith("README.md"));
    expect(checkTarball(g)).toEqual([
      "package/LICENSE.md is missing from the tarball",
      "package/README.md is missing from the tarball",
      '"files" entry README.md has nothing in the tarball',
      '"files" entry LICENSE.md has nothing in the tarball',
    ]);
  });

  test("source, tests and a build cache in the tarball are reported", () => {
    const g = good();
    g.listing.push("package/src/index.ts", "package/test/a.test.ts", "package/tsconfig.tsbuildinfo");
    expect(checkTarball(g)).toEqual([
      "the tarball ships source or tests: package/src/index.ts",
      "the tarball ships source or tests: package/test/a.test.ts",
      "the tarball ships a build cache: package/tsconfig.tsbuildinfo",
    ]);
  });

  test('a "files" entry with nothing behind it is reported', () => {
    const g = good();
    g.listing = g.listing.filter((p) => !p.startsWith("package/migrations/"));
    expect(checkTarball(g)).toEqual(['"files" entry migrations has nothing in the tarball']);
  });

  test("a manifest entry the tarball does not contain is reported, whether it is main or an exports target", () => {
    const g = good();
    g.listing = g.listing.filter((p) => p !== "package/dist/index.js");
    expect(checkTarball(g)).toEqual([
      "the packed manifest names dist/index.js but the tarball does not contain it",
      "the packed manifest names dist/index.js but the tarball does not contain it",
    ]);
  });

  test("a manifest that still points at source is reported", () => {
    const g = good();
    g.manifest.main = "./src/index.ts";
    g.listing.push("package/src/index.ts");
    expect(checkTarball(g)).toContain("the packed manifest points at ./src/index.ts, not at ./dist/");
  });

  test("an unrewritten workspace dependency and a sibling version mismatch are reported", () => {
    const g = good();
    g.manifest.dependencies = { "@mogging/core": "workspace:*" };
    expect(checkTarball(g)).toEqual(["dependencies.@mogging/core is still workspace:* (the workspace protocol was not rewritten)"]);
    g.manifest.dependencies = { "@mogging/core": "0.0.1" };
    expect(checkTarball(g)).toEqual(["dependencies.@mogging/core is 0.0.1 but @mogging/core is at 0.0.0 in this repository"]);
  });

  test('a missing publishConfig.access "public" is reported, because a scoped package would publish as restricted', () => {
    const g = good();
    g.source.publishConfig = {};
    expect(checkTarball(g)).toEqual([`publishConfig.access is not "public" (a scoped package would publish as restricted)`]);
  });

  test("a manifest with no license is reported", () => {
    const g = good();
    delete g.manifest.license;
    expect(checkTarball(g)).toEqual(["the manifest has no license field"]);
  });

  test("release mode rejects a private manifest and a 0.0.0 or malformed version, and the plain check does not", () => {
    const g = good();
    g.manifest.private = true;
    expect(checkTarball(g)).toEqual([]);
    expect(checkTarball({ ...g, release: true })).toEqual([`"private": true would make npm refuse to publish it`, "version 0.0.0 is not a release version"]);
    g.manifest.private = false;
    g.manifest.version = "1.0";
    expect(checkTarball({ ...g, release: true })).toEqual(["version 1.0 is not a release version"]);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway package whose `publishConfig` swaps to `dist`, with a standalone tsconfig.build.json. */
function fakePackage(opts: { publishConfig?: Record<string, unknown>; files?: Record<string, string> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "mog-prepack-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"));
  const files = opts.files ?? { "src/index.ts": "export const x: number = 1;\n" };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "@mogging/fake", version: "0.0.0", type: "module", main: "./src/index.ts",
    publishConfig: opts.publishConfig ?? { main: "./dist/index.js", types: "./dist/index.d.ts" },
  }));
  writeFileSync(join(dir, "tsconfig.build.json"), JSON.stringify({
    compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", outDir: "dist", rootDir: "src", declaration: true },
    include: ["src"],
  }));
  return dir;
}

const prepack = (cwd: string) => {
  const r = spawnSync("node", [PREPACK], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

describe("prepack gate", () => {
  test("builds dist from the current source and copies the root licence", () => {
    const dir = fakePackage();
    const r = prepack(dir);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "dist/index.js"), "utf8")).toContain("export const x = 1");
    expect(existsSync(join(dir, "dist/index.d.ts"))).toBe(true);
    expect(existsSync(join(dir, "LICENSE.md"))).toBe(true);
  }, 60_000);

  test("deletes output that no source file produces any more (a stale dist cannot ship)", () => {
    const dir = fakePackage();
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/zombie.js"), "export const old = 1;\n");
    expect(prepack(dir).status).toBe(0);
    expect(existsSync(join(dir, "dist/zombie.js"))).toBe(false);
  }, 60_000);

  test("fails with exit 1 when the build has a type error, and names tsc", () => {
    const dir = fakePackage({ files: { "src/index.ts": "export const x: number = 'nope';\n" } });
    const r = prepack(dir);
    expect(r.status).toBe(1);
    expect(r.err).toContain("tsc failed");
  }, 60_000);

  test("fails with exit 1 when a file the published manifest points at is not produced", () => {
    const dir = fakePackage({ publishConfig: { main: "./dist/missing.js" } });
    const r = prepack(dir);
    expect(r.status).toBe(1);
    expect(r.err).toContain("did not produce dist/missing.js");
  }, 60_000);

  test("fails with exit 1 when publishConfig names no dist entry at all", () => {
    const r = prepack(fakePackage({ publishConfig: {} }));
    expect(r.status).toBe(1);
    expect(r.err).toContain("names no dist entry file");
  }, 60_000);

  test("a bin file must keep its shebang: with it the gate passes, without it the gate fails", () => {
    const withShebang = fakePackage({
      publishConfig: { bin: { fake: "./dist/bin.js" } },
      files: { "src/bin.ts": "#!/usr/bin/env node\nexport const y = 1;\n" },
    });
    expect(prepack(withShebang).status).toBe(0);
    const without = fakePackage({ publishConfig: { bin: { fake: "./dist/bin.js" } }, files: { "src/bin.ts": "export const y = 1;\n" } });
    const r = prepack(without);
    expect(r.status).toBe(1);
    expect(r.err).toContain('must start with "#!/usr/bin/env node"');
  }, 60_000);
});
