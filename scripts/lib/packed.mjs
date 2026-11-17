// Shared helpers of the scripts that run the packed packages outside the repository (the Starlight acceptance run).
// Not part of `pnpm test`: building, packing and installing need the network.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root (the folder above `scripts/`). */
export const root = fileURLToPath(new URL("../..", import.meta.url));

/** The packages the acceptance run packs, in dependency order. */
export const PACKAGES = ["core", "markdown", "ai", "cli", "starlight"];

/**
 * Runs a command and returns its stdout.
 * @param {string} cmd The executable.
 * @param {string[]} args Its arguments.
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [options] The working folder and the whole child environment (default: this process's).
 * @returns {string} The standard output.
 * @throws {Error} On a spawn error or a non-zero exit, with the command line and its output.
 */
export function sh(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env ?? process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined || r.status !== 0) {
    const detail = r.error?.message ?? `exit ${r.status}`;
    throw new Error(`${cmd} ${args.join(" ")}: ${detail}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
  return r.stdout;
}

/**
 * Fails the run when a condition does not hold.
 * @param {unknown} condition The condition.
 * @param {string} message The failure message.
 * @throws {Error} With the message, when the condition is falsy.
 */
export function check(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Removes the `LICENSE.md` that each package's `prepack` copied into its folder.
 * @param {string} repoRoot The repository root.
 */
export function removeLicences(repoRoot) {
  for (const name of PACKAGES) rmSync(join(repoRoot, "packages", name, "LICENSE.md"), { force: true });
}

/**
 * Builds the workspace and packs the five packages.
 * @param {string} repoRoot The repository root.
 * @param {string} dest An existing folder that receives the tarballs.
 * @returns {Record<string, string>} The absolute tarball path by package name (`@mogging/core`, ...).
 * @throws {Error} When a build or pack fails, or a tarball is missing or lacks `package/LICENSE.md`.
 */
export function buildAndPack(repoRoot, dest) {
  sh("pnpm", ["build"], { cwd: repoRoot });
  const out = {};
  for (const pkg of PACKAGES) {
    const dir = join(repoRoot, "packages", pkg);
    const before = new Set(readdirSync(dest));
    sh("pnpm", ["pack", "--pack-destination", dest], { cwd: dir });
    const made = readdirSync(dest).filter((f) => f.endsWith(".tgz") && !before.has(f));
    check(made.length === 1, `packing ${pkg} produced ${made.length} tarballs (${made.join(", ")})`);
    const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
    const tarball = join(dest, made[0]);
    check(sh("tar", ["-tzf", tarball]).split("\n").includes("package/LICENSE.md"), `${made[0]} has no package/LICENSE.md`);
    out[name] = tarball;
  }
  return out;
}

/**
 * Loads a dependency of a workspace package: the repository root resolves neither `postgres` nor `yaml`.
 * @param {string} repoRoot The repository root.
 * @param {string} pkg The workspace package folder name (`core`, `cli`, ...).
 * @param {string} name The dependency to load.
 * @returns {Promise<any>} The module's default export (or the namespace when there is none).
 */
export async function requireFrom(repoRoot, pkg, name) {
  const resolved = createRequire(join(repoRoot, "packages", pkg, "package.json")).resolve(name);
  const mod = await import(pathToFileURL(resolved).href);
  return mod.default ?? mod;
}

/**
 * Creates an `accept_<hex>` schema in the test database.
 * @param {string} baseUrl The `DATABASE_URL` of the test database.
 * @returns {Promise<{ url: string, tables: (schema?: string) => Promise<number>, drop: () => Promise<void> }>}
 *   `url` is `baseUrl` with `search_path` set to the schema; `tables` counts the tables of a schema (default the
 *   throwaway one); `drop` drops the schema and closes the connection.
 */
export async function throwawaySchema(baseUrl) {
  const postgres = await requireFrom(root, "core", "postgres");
  const sql = postgres(baseUrl, { max: 1, onnotice: () => {} });
  const schema = `accept_${randomBytes(4).toString("hex")}`;
  try {
    await sql.unsafe(`create schema ${schema}`);
  } catch (e) {
    await sql.end();
    throw e;
  }
  const url = new URL(baseUrl);
  url.searchParams.set("search_path", schema);
  return {
    url: url.href,
    async tables(name = schema) {
      return Number((await sql`select count(*) as n from information_schema.tables where table_schema = ${name}`)[0].n);
    },
    async drop() {
      try {
        await sql.unsafe(`drop schema if exists ${schema} cascade`);
      } finally {
        await sql.end();
      }
    },
  };
}

/**
 * The environment of a command run inside the site: an allowlist, never the inherited `DATABASE_URL`, because
 * `node --env-file` does not override a variable that is already set.
 * @param {Record<string, string>} extra Variables added last.
 * @returns {Record<string, string>} The child environment.
 */
export function siteEnv(extra = {}) {
  const env = { MOGGING_ACTOR: "accept" };
  for (const k of [
    "PATH", "HOME",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "npm_config_cafile",
  ]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return { ...env, ...extra };
}

/**
 * Points the site at the packed tarballs and installs it. The packed CLI names `@mogging/markdown` at version
 * `0.0.0`, which npm would otherwise look for in the registry, so all five tarballs are installed together.
 * @param {string} siteDir The copied template folder.
 * @param {Record<string, string>} tarballs The tarball path by package name, as `buildAndPack` returns.
 * @param {Record<string, string>} [extraDev] Extra `devDependencies` (name to version).
 * @throws {Error} When `npm install` fails.
 */
export function installSite(siteDir, tarballs, extraDev = {}) {
  const file = join(siteDir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["dependencies", "devDependencies"]) {
    pkg[key] = Object.fromEntries(Object.entries(pkg[key] ?? {}).filter(([n]) => !n.startsWith("@mogging/")));
  }
  for (const [name, tarball] of Object.entries(tarballs)) {
    (name === "@mogging/starlight" ? pkg.dependencies : pkg.devDependencies)[name] = `file:${tarball}`;
  }
  Object.assign(pkg.devDependencies, extraDev);
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: siteDir });
}
