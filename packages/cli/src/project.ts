import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import type { AiConfig } from "@mogging/ai";
import type { MoggingConfig } from "@mogging/core";
import { defineStarlightLayout } from "@mogging/markdown";
import type { StarlightLayout, StarlightLayoutInput } from "@mogging/markdown";
import { UsageError } from "./types.js";
import type { Deps, Flags, LoadedConfig, Project } from "./types.js";

/** The discovery order for the config file; `init` agrees with it on what counts as an existing config. */
export const CONFIG_NAMES = ["mogging.config.ts", "mogging.config.mts", "mogging.config.js", "mogging.config.mjs"];

/** The first non-blank string, trimmed. */
function firstText(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return undefined;
}

/** `--actor`, else `MOGGING_ACTOR`, else the OS user, else `cli`; never empty (attribution, not authentication). */
export function resolveActor(flags: Flags, env: Record<string, string | undefined>, osUser: string | undefined): string {
  return firstText(flags.actor, env.MOGGING_ACTOR, osUser) ?? "cli";
}

/** `--database-url` given but blank is a usage error: falling through to the environment would pick another database. */
export function resolveDatabaseUrl(flags: Flags, env: Record<string, string | undefined>): string {
  const given = flags["database-url"];
  if (typeof given === "string" && given.trim() === "") throw new UsageError("--database-url must not be empty");
  const url = firstText(flags["database-url"], env.MOGGING_DATABASE_URL, env.DATABASE_URL);
  if (url === undefined) throw new UsageError("no database URL: set DATABASE_URL");
  return url;
}

/** `--config` as given (untrimmed), or `undefined`; a blank value is a usage error rather than the working directory. */
export function configFlag(flags: Flags): string | undefined {
  if (typeof flags.config !== "string") return undefined;
  if (flags.config.trim() === "") throw new UsageError("--config must not be empty");
  return flags.config;
}

/** `lstat`, not `existsSync`: a dangling symlink counts as present, so its load fails with exit 1. */
export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function findConfig(deps: Deps, flags: Flags): string {
  const given = configFlag(flags);
  if (given !== undefined) return resolve(deps.cwd, given);
  for (const name of CONFIG_NAMES) {
    const path = resolve(deps.cwd, name);
    if (present(path)) return path;
  }
  throw new UsageError(`no mogging.config.ts|.mts|.js|.mjs in ${deps.cwd}: run mogging init or pass --config`);
}

function isConfig(value: unknown): value is MoggingConfig {
  if (typeof value !== "object" || value === null) return false;
  const c = value as { collections?: unknown; locales?: { source?: unknown } | null };
  return Array.isArray(c.collections) && typeof c.locales?.source === "string";
}

function osUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined; // e.g. a container user with no passwd entry
  }
}

/**
 * Validates the optional `starlight` export against the config. Matches the error by `name`, not `instanceof`,
 * because the layout code and the config may come from different copies of core.
 */
function starlightLayout(exported: unknown, config: MoggingConfig, configPath: string): StarlightLayout | undefined {
  if (exported === undefined) return undefined;
  const prefix = `${configPath} must export \`starlight\` as a valid Starlight layout`;
  if (typeof exported !== "object" || exported === null) {
    throw new UsageError(`${prefix}: the export is not an object`);
  }
  try {
    return defineStarlightLayout(exported as StarlightLayoutInput, config);
  } catch (err) {
    if (err instanceof Error && err.name === "ValidationError") throw new UsageError(`${prefix}: ${err.message}`);
    throw err;
  }
}

/**
 * Loads the config module, validates its exports and connects. Every usage error (no config, no URL, a bad export, a
 * failing `check`) is raised before `deps.connect`, so a failure never leaves a connection that nobody closes.
 *
 * @param deps the injected process seams.
 * @param flags the parsed global and command flags.
 * @param check a command's config-dependent usage check, called with the loaded config before connecting.
 * @returns the open project.
 * @throws {UsageError} for a missing or malformed config or `starlight` export, a missing database URL, or anything
 * `check` throws.
 */
export async function loadProject(
  deps: Deps,
  flags: Flags,
  check?: (loaded: LoadedConfig) => void,
): Promise<Project> {
  const configPath = findConfig(deps, flags);
  const url = resolveDatabaseUrl(flags, deps.env);
  const mod = await deps.loadModule(configPath);
  if (!isConfig(mod.config)) {
    throw new UsageError(
      `${configPath} must export \`config\` (defineConfig) with a collections array and locales.source; the export is missing or malformed`,
    );
  }
  const starlight = starlightLayout(mod.starlight, mod.config, configPath);
  const root = dirname(configPath);
  check?.({ config: mod.config, starlight, configPath, root, cwd: deps.cwd });
  const sql = deps.connect(url);
  return {
    sql,
    ctx: { sql, config: mod.config, actor: resolveActor(flags, deps.env, osUser()) },
    ai: mod.ai as AiConfig | undefined,
    starlight,
    root,
    configPath,
    close: async () => {
      await sql.end();
    },
  };
}
