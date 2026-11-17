import type { ParseArgsConfig } from "node:util";
import type { Sql } from "postgres";
import type { AiConfig } from "@mogging/ai";
import type { Ctx, MoggingConfig } from "@mogging/core";
import type { StarlightLayout } from "@mogging/markdown";

export type Io = {
  out(s: string): void;
  err(s: string): void;
  stdin: NodeJS.ReadableStream;
  /** True only when stdin AND stdout are terminals. */
  isTTY: boolean;
  /** `process.stdout.columns`. */
  width: number | undefined;
  /** Stdout is a terminal and `NO_COLOR` is unset. */
  color: boolean;
};

export type LicenceInfo = {
  state: "licensed" | "evaluation" | "expired";
  daysLeft: number | null;
  warn: boolean;
  plan: string | null;
  licensee: string | null;
  keyError: string | null;
};

export type CommandResult = {
  data: unknown;
  lines: string[];
  exitCode?: 0 | 1 | 4;
  /** Present exactly when `exitCode` is 1. */
  error?: { code: string; message: string };
  /** Returned only by a `project: "none"` command that opened a project itself (`init`). */
  licence?: LicenceInfo;
};

export type Project = {
  sql: Sql;
  ctx: Ctx;
  ai: AiConfig | undefined;
  /** The validated Starlight layout of the config's `starlight` export, or `undefined` for a generic project. */
  starlight: StarlightLayout | undefined;
  /** The project root: the folder holding the config file (never the working directory). */
  root: string;
  configPath: string;
  close(): Promise<void>;
};

/** What `loadProject` knows once the config module is loaded and validated, before it connects. */
export type LoadedConfig = {
  config: MoggingConfig;
  starlight: StarlightLayout | undefined;
  configPath: string;
  /** The folder holding the config file. */
  root: string;
  /** `deps.cwd`, for a check that resolves a path the user typed (such as `--restore`). */
  cwd: string;
};

/** `util.parseArgs` values. */
export type Flags = Record<string, string | boolean | string[] | undefined>;

export type CommandEnv = {
  project: Project;
  io: Io;
  flags: Flags;
  positionals: string[];
  signal: AbortSignal;
  deps: Deps;
  json: boolean;
};

export type CommandSpec = {
  name: string;
  summary: string;
  usage: string;
  options: ParseArgsConfig["options"];
  project: "none" | "full";
  needsAi?: boolean;
  usesSignal?: boolean | ((flags: Flags, positionals: string[]) => boolean);
  arity: [min: number, max: number];
  validate?(flags: Flags, positionals: string[], io: Io): void;
  /**
   * Usage checks that depend on the loaded config (a Starlight-only flag in a generic project, an undeclared locale).
   * Runs after the config and its `starlight` layout are validated and before the database connection is opened, so
   * a `UsageError` thrown here is exit 2 without touching the database.
   */
  checkLoaded?(flags: Flags, positionals: string[], loaded: LoadedConfig): void;
  run(env: CommandEnv): Promise<CommandResult>;
};

export type Deps = {
  io: Io;
  env: Record<string, string | undefined>;
  cwd: string;
  loadModule(path: string): Promise<Record<string, unknown>>;
  connect(url: string): Sql;
  now(): Date;
  signal?: AbortSignal;
  editor(file: string): Promise<void>;
  exit(code: number): void;
  commands?: CommandSpec[];
  licenceKeys?: readonly string[];
};

/** A command-line usage mistake: exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
