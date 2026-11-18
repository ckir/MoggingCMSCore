// Each package's `prepack` (cwd is the package directory). The gate that makes a stale `dist` unshippable: it copies the
// root LICENSE.md into the package, DELETES `dist`, rebuilds it with `tsc -p tsconfig.build.json`, and then verifies that
// every file the published manifest points at exists (and that a `bin` file keeps its shebang). `pnpm pack`, `pnpm publish`
// and `npm publish` from a package directory all run it, so the tarball is always built from the current source. It
// deliberately has no cache: deleting `dist` first is what removes the output of a source file that no longer exists.
// The licence copies are git-ignored (`packages/*/LICENSE.md`).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entryFiles } from "./lib/pack-checks.mjs";

const cwd = process.cwd();
const fail = (message) => {
  console.error(`prepack (${cwd}): ${message}`);
  process.exit(1);
};

copyFileSync(fileURLToPath(new URL("../LICENSE.md", import.meta.url)), join(cwd, "LICENSE.md"));

const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
// The pnpm pack/publish merge of publishConfig over the manifest happens after prepack, so read the published view here.
const published = { ...manifest, ...(manifest.publishConfig ?? {}) };
const wanted = entryFiles(published).filter((p) => p.startsWith("dist/"));
if (wanted.length === 0) fail("publishConfig names no dist entry file, so there is nothing to build for");

rmSync(join(cwd, "dist"), { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd, encoding: "utf8" });
if (build.status !== 0) fail(`tsc failed (exit ${build.status}):\n${build.stdout}${build.stderr}`);

for (const file of wanted) {
  if (!existsSync(join(cwd, file))) fail(`the build did not produce ${file}, which the published manifest points at`);
}
const bins = typeof published.bin === "string" ? [published.bin] : Object.values(published.bin ?? {});
for (const bin of bins) {
  const first = readFileSync(join(cwd, bin), "utf8").split("\n")[0];
  if (first !== "#!/usr/bin/env node") fail(`${bin} must start with "#!/usr/bin/env node", it starts with ${JSON.stringify(first)}`);
}
console.log(`prepack: rebuilt dist (${wanted.length} entry files present)`);
