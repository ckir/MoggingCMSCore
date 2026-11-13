// Pack-and-install smoke: builds, packs the four packages, installs the tarballs into an empty project outside the
// repository and runs the installed `mogging` binary against a throwaway schema of the test database.
// Not part of `pnpm test`. Usage: DATABASE_URL=postgres://... pnpm smoke:pack
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = ["core", "markdown", "ai", "cli"];
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL is not set: point it at the test database (docs/dev-setup.md)");
  process.exit(2);
}

/** Runs a command, throws with its output on a non-zero exit, and returns stdout. */
function sh(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env ?? process.env, encoding: "utf8" });
  if (r.error !== undefined || r.status !== 0) {
    const detail = r.error?.message ?? `exit ${r.status}`;
    throw new Error(`${cmd} ${args.join(" ")}: ${detail}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
  return r.stdout;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const ok = (step) => console.log(`OK   ${step}`);

const schema = `smoke_${randomBytes(4).toString("hex")}`;
const work = mkdtempSync(join(tmpdir(), "mogging-smoke-"));
const tarballs = join(work, "tarballs");
const project = join(work, "project");
mkdirSync(tarballs);
mkdirSync(project);

// `postgres` is a dependency of the packages, not of the repository root: resolve it from core.
const postgres = (await import(pathToFileURL(createRequire(join(root, "packages/core/package.json")).resolve("postgres")).href)).default;
const sql = postgres(baseUrl, { max: 1, onnotice: () => {} });
const tablesIn = async (name) =>
  Number((await sql`select count(*) as n from information_schema.tables where table_schema = ${name}`)[0].n);

let failed = false;
try {
  sh("pnpm", ["build"], { cwd: root });
  ok("build");

  for (const name of packages) sh("pnpm", ["pack", "--pack-destination", tarballs], { cwd: join(root, "packages", name) });
  const files = readdirSync(tarballs).filter((f) => f.endsWith(".tgz")).sort();
  check(files.length === packages.length, `expected ${packages.length} tarballs, got ${files.join(", ")}`);
  for (const f of files) {
    const listing = sh("tar", ["-tzf", join(tarballs, f)]).split("\n");
    check(listing.includes("package/LICENSE.md"), `${f} has no package/LICENSE.md`);
  }
  ok(`pack ${files.length} tarballs, each lists package/LICENSE.md`);

  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke-project", private: true, type: "module" }));
  sh("npm", ["install", "--no-audit", "--no-fund", ...files.map((f) => join(tarballs, f))], { cwd: project });
  ok("npm install of the four tarballs");

  const bin = join(project, "node_modules", ".bin", "mogging");
  check(existsSync(bin), "node_modules/.bin/mogging was not created (no bin in the packed cli manifest)");
  const shebang = readFileSync(join(project, "node_modules", "@mogging", "cli", "dist", "bin.js"), "utf8").split("\n")[0];
  check(shebang === "#!/usr/bin/env node", `dist/bin.js starts with ${JSON.stringify(shebang)}`);
  ok("installed dist/bin.js keeps the shebang");

  await sql.unsafe(`create schema ${schema}`);
  const publicBefore = await tablesIn("public");

  const url = new URL(baseUrl);
  url.searchParams.set("search_path", schema);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, MOGGING_ACTOR: "smoke", DATABASE_URL: url.href };
  const mogging = (...args) => sh(bin, args, { cwd: project, env });

  const version = mogging("--version").trim();
  check(version === JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version, `--version printed ${version}`);
  ok("mogging --version");

  mogging("init");
  check(existsSync(join(project, "mogging.config.ts")), "init did not write mogging.config.ts");
  const inSchema = await tablesIn(schema);
  const publicAfter = await tablesIn("public");
  check(inSchema > 0, `init applied no migrations into ${schema}`);
  check(publicAfter === publicBefore, `init changed the public schema (${publicBefore} -> ${publicAfter} tables)`);
  ok(`mogging init (config written; ${inSchema} tables in the throwaway schema; public has ${publicAfter}, unchanged)`);

  mkdirSync(join(project, "content", "en", "docs"), { recursive: true });
  writeFileSync(join(project, "content", "en", "docs", "intro.md"), "---\ntitle: Intro\n---\nHello\n");
  const imported = mogging("import", "content", "--publish");
  check(imported.includes("en/docs/intro.md"), `import did not report the file:\n${imported}`);
  ok("mogging import content --publish");

  mogging("status");
  ok("mogging status");

  const queried = mogging("query", "docs/intro");
  check(queried.includes("Intro"), `query did not show the title:\n${queried}`);
  ok("mogging query docs/intro");

  console.log("SKIP mogging jobs (needs the optional ai configuration)");
} catch (e) {
  failed = true;
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  try {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
  } catch (e) {
    failed = true;
    console.error(`FAIL could not drop ${schema}: ${e instanceof Error ? e.message : String(e)}`);
  }
  await sql.end();
  for (const name of packages) rmSync(join(root, "packages", name, "LICENSE.md"), { force: true });
  rmSync(work, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("smoke:pack passed");
