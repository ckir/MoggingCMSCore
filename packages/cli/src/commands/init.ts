import { unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineStarlightLayout } from "@mogging/markdown";
import type { StarlightLayoutInput } from "@mogging/markdown";
import { getLicenceState, migrate } from "@mogging/core";
import type { MoggingConfig } from "@mogging/core";
import { licenceInfo, licenceLines } from "../output.js";
import { CONFIG_NAMES, configFlag, loadProject, present, resolveDatabaseUrl } from "../project.js";
import { readAstroConfig } from "../starlight/astroConfig.js";
import {
  AI_CONFIG_BLOCK, starlightAnswers, starlightConfigText, starlightVersionWarning,
} from "../starlight/initStarlight.js";
import type { StarlightAnswers } from "../starlight/initStarlight.js";
import { UsageError } from "../types.js";
import type { CommandSpec, Deps, Flags } from "../types.js";
import { appliedLines } from "./migrate.js";

/** Fixed text: `init` writes it verbatim and never edits `.gitignore` or `.env`. */
export const CONFIG_TEMPLATE = `import { defineConfig, defineCollection, slug, text, richText } from "@mogging/core";

const docs = defineCollection("docs", {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
});

export const config = defineConfig({
  collections: [docs],
  locales: { source: "en", chains: { de: ["en"] } },
});

${AI_CONFIG_BLOCK}`;

/**
 * Where `init` writes its config: the `--config` path (resolved against the working directory), else the first
 * existing `mogging.config.*` in the working directory, else `mogging.config.ts` there. `exists` is true only for
 * the second case; a `--config` path is tried with `wx` instead.
 */
function configTarget(deps: Deps, flags: Flags): { path: string; exists: boolean } {
  const given = configFlag(flags);
  if (given !== undefined) return { path: resolve(deps.cwd, given), exists: false };
  const found = CONFIG_NAMES.map((name) => resolve(deps.cwd, name)).find(present);
  if (found !== undefined) return { path: found, exists: true };
  return { path: resolve(deps.cwd, CONFIG_NAMES[0]!), exists: false };
}

/**
 * Writes `text` to `path` with `wx`, which fails with `EEXIST` for any existing path, a symlink (dangling or not)
 * included, so an existing file is never written through. Returns whether the file was created.
 */
async function createFile(path: string, text: string): Promise<boolean> {
  try {
    await writeFile(path, text, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as { code?: unknown }).code === "EEXIST") return false;
    throw e;
  }
}

/** Writes the template unless a config already exists. Returns whether the file was created. */
async function writeTemplate(deps: Deps, flags: Flags): Promise<{ path: string; created: boolean }> {
  const target = configTarget(deps, flags);
  if (target.exists) return { path: target.path, created: false };
  return { path: target.path, created: await createFile(target.path, CONFIG_TEMPLATE) };
}

/** What `init --starlight` reports in `data.starlight`. */
type StarlightReport = Pick<StarlightAnswers, "source" | "targets" | "sourceDir" | "docsDir" | "pasteBlock">;

/**
 * Loads the config this run just wrote, once, and validates its `starlight` export. When either fails (most often
 * `@mogging/starlight` or `@mogging/core` is not installed where the config can import it) the file is deleted again
 * and the failure is a usage error.
 */
async function checkWrittenConfig(deps: Deps, path: string): Promise<void> {
  try {
    const mod = await deps.loadModule(path);
    defineStarlightLayout(mod.starlight as StarlightLayoutInput, mod.config as MoggingConfig);
  } catch (e) {
    try {
      await unlink(path);
    } catch {
      // a failed delete never replaces the usage error
    }
    const message = e instanceof Error ? e.message : String(e);
    throw new UsageError(
      `init --starlight: the written config does not load (${message}); install @mogging/starlight and ` +
        "@mogging/core next to it (npm install -D @mogging/starlight @mogging/core) and run init --starlight again",
    );
  }
}

/**
 * The `--starlight` half of `init`: no config yet means read astro.config next to the config file to be written,
 * decide the answers (usage errors before any write), write the preset config and check that it loads. Returns what
 * to print; an existing config is left alone and `report` is `null`.
 */
async function writeStarlightConfig(
  deps: Deps,
  flags: Flags,
): Promise<{ path: string; created: boolean; report: StarlightReport | null; stderr: string[] }> {
  const target = configTarget(deps, flags);
  if (target.exists || present(target.path)) return { path: target.path, created: false, report: null, stderr: [] };
  const root = dirname(target.path);
  const answers = starlightAnswers(readAstroConfig(root), {
    locales: typeof flags.locales === "string" ? flags.locales : undefined,
    sourceLocale: typeof flags["source-locale"] === "string" ? flags["source-locale"] : undefined,
  });
  if (!(await createFile(target.path, starlightConfigText(answers)))) {
    return { path: target.path, created: false, report: null, stderr: [] }; // lost a race with another writer
  }
  await checkWrittenConfig(deps, target.path);
  const stderr = answers.warnings.map((w) => `warning: ${w}`);
  const version = starlightVersionWarning(root);
  if (version !== null) stderr.push(`warning: ${version}`);
  if (answers.pasteBlock !== null) stderr.push(answers.pasteBlock);
  const { source, targets, sourceDir, docsDir, pasteBlock } = answers;
  return { path: target.path, created: true, report: { source, targets, sourceDir, docsDir, pasteBlock }, stderr };
}

export const initSpec: CommandSpec = {
  name: "init",
  summary: "write mogging.config.ts if there is none and apply the migrations",
  usage:
    "mogging init [--starlight [--locales de,fr] [--source-locale en]] [--json] [--config <path>] [--database-url <url>]",
  options: {
    starlight: { type: "boolean" },
    locales: { type: "string" },
    "source-locale": { type: "string" },
  },
  project: "none",
  arity: [0, 0],
  validate(flags) {
    if (flags.starlight === true) return;
    for (const name of ["locales", "source-locale"]) {
      if (flags[name] !== undefined) throw new UsageError(`init: --${name} needs --starlight`);
    }
  },
  async run(env) {
    const { deps, flags, io } = env;
    resolveDatabaseUrl(flags, deps.env); // a missing URL is a usage error before anything is written
    const starlight = flags.starlight === true;
    let path: string;
    let created: boolean;
    let report: StarlightReport | null = null;
    if (starlight) {
      const written = await writeStarlightConfig(deps, flags);
      ({ path, created, report } = written);
      // At once, so a later migration failure does not lose them.
      for (const line of written.stderr) io.err(`${line}\n`);
    } else {
      ({ path, created } = await writeTemplate(deps, flags));
    }
    const project = await loadProject(deps, flags);
    try {
      const licence = licenceInfo(await getLicenceState(project.ctx, { publicKeys: deps.licenceKeys }));
      for (const line of licenceLines(licence)) io.err(`${line}\n`);
      const applied = await migrate(project.sql);
      const first = created
        ? `created ${path}`
        : starlight
          ? `${path} already exists: left unchanged; --starlight wrote nothing`
          : `${path} already exists: left unchanged`;
      const data = starlight ? { configCreated: created, applied, starlight: report } : { configCreated: created, applied };
      return { data, lines: [first, ...appliedLines(applied)], licence };
    } finally {
      await project.close();
    }
  },
};
