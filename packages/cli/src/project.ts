import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import type { AiConfig } from "@mogging/ai";
import type { MoggingConfig } from "@mogging/core";
import { UsageError } from "./types.js";
import type { Deps, Flags, Project } from "./types.js";

const CONFIG_NAMES = ["mogging.config.ts", "mogging.config.mts", "mogging.config.js", "mogging.config.mjs"];

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

export function resolveDatabaseUrl(flags: Flags, env: Record<string, string | undefined>): string {
  const url = firstText(flags["database-url"], env.MOGGING_DATABASE_URL, env.DATABASE_URL);
  if (url === undefined) throw new UsageError("no database URL: set DATABASE_URL");
  return url;
}

/** `lstat`, not `existsSync`: a dangling symlink counts as present, so its load fails with exit 1. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function findConfig(deps: Deps, flags: Flags): string {
  if (typeof flags.config === "string") return resolve(deps.cwd, flags.config);
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
 * Loads the config module and connects. Every usage error (no config, no URL, a bad export) is raised before
 * `deps.connect`, so a failure never leaves a connection that nobody closes.
 */
export async function loadProject(deps: Deps, flags: Flags): Promise<Project> {
  const configPath = findConfig(deps, flags);
  const url = resolveDatabaseUrl(flags, deps.env);
  const mod = await deps.loadModule(configPath);
  if (!isConfig(mod.config)) {
    throw new UsageError(
      `${configPath} must export \`config\` (defineConfig) with a collections array and locales.source; the export is missing or malformed`,
    );
  }
  const sql = deps.connect(url);
  return {
    sql,
    ctx: { sql, config: mod.config, actor: resolveActor(flags, deps.env, osUser()) },
    ai: mod.ai as AiConfig | undefined,
    configPath,
    close: async () => {
      await sql.end();
    },
  };
}
