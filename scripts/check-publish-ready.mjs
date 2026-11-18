// Packs every @mogging package (its `prepack` rebuilds dist), then checks each tarball with scripts/lib/pack-checks.mjs:
// licence, readme, no src/test, every manifest entry present, workspace deps rewritten to the sibling's version,
// publishConfig.access "public". Needs no database. Run it as `pnpm check:publish`; CI runs it on every push.
//
//   node scripts/check-publish-ready.mjs                  check only; tarballs go to a temp folder that is removed
//   node scripts/check-publish-ready.mjs --release --out DIR
//        the final check after the release commit: additionally demands non-private manifests at one shared,
//        non-0.0.0 version, and KEEPS the tarballs in DIR. Publish those exact files (docs/RELEASING.md), never a re-pack.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTarball } from "./lib/pack-checks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const release = args.includes("--release");
const outIndex = args.indexOf("--out");
const outArg = outIndex === -1 ? undefined : args[outIndex + 1];
if (release && (outArg === undefined || outArg.startsWith("--"))) {
  console.error("check:publish --release needs --out DIR: the tarballs checked there are the ones to publish.");
  process.exit(2);
}

/** Runs a command and returns stdout; throws with the output on a non-zero exit. */
function sh(cmd, argv, cwd) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined || r.status !== 0) {
    throw new Error(`${cmd} ${argv.join(" ")} (in ${cwd}): ${r.error?.message ?? `exit ${r.status}`}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
  return r.stdout;
}

const dirs = readdirSync(join(root, "packages")).filter((d) => existsSync(join(root, "packages", d, "package.json"))).sort();
const sources = new Map(dirs.map((d) => [d, JSON.parse(readFileSync(join(root, "packages", d, "package.json"), "utf8"))]));
const siblings = new Map([...sources.values()].map((m) => [m.name, m.version]));

const outDir = outArg === undefined ? mkdtempSync(join(tmpdir(), "mogging-publish-ready-")) : resolve(outArg);
mkdirSync(outDir, { recursive: true });
let failed = false;
try {
  if (release) {
    const versions = new Set(siblings.values());
    if (versions.size !== 1) {
      failed = true;
      console.error(`FAIL the packages are at different versions: ${[...siblings].map(([n, v]) => `${n}@${v}`).join(", ")}`);
    }
  }
  for (const d of dirs) {
    const source = sources.get(d);
    sh("pnpm", ["pack", "--pack-destination", outDir], join(root, "packages", d));
    const tgz = join(outDir, `${source.name.replace("@", "").replace("/", "-")}-${source.version}.tgz`);
    if (!existsSync(tgz)) throw new Error(`pnpm pack did not produce ${tgz}`);
    const listing = sh("tar", ["-tzf", tgz], outDir).split("\n").filter((l) => l !== "");
    const manifest = JSON.parse(sh("tar", ["-xzOf", tgz, "package/package.json"], outDir));
    const problems = checkTarball({ listing, manifest, source, siblings, release });
    if (problems.length === 0) console.log(`OK   ${source.name}@${source.version} (${listing.length} files)`);
    else {
      failed = true;
      for (const p of problems) console.error(`FAIL ${source.name}: ${p}`);
    }
  }
  if (!failed) console.log(release ? `OK   all ${dirs.length} tarballs are release-ready; publish exactly these files from ${outDir}` : `OK   all ${dirs.length} tarballs are publishable (private and 0.0.0 are fine until the release commit)`);
} catch (e) {
  failed = true;
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (outArg === undefined) rmSync(outDir, { recursive: true, force: true });
  for (const d of dirs) rmSync(join(root, "packages", d, "LICENSE.md"), { force: true });
}
process.exit(failed ? 1 : 0);
