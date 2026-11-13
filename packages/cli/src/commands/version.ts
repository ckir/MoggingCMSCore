import { createRequire } from "node:module";
import type { CommandSpec } from "../types.js";

/** The package version, also printed by `mogging --version`. */
export const VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

export const versionCommand: CommandSpec = {
  name: "version",
  summary: "print the CLI version",
  usage: "mogging version",
  options: {},
  project: "none",
  arity: [0, 0],
  async run() {
    return { data: { version: VERSION }, lines: [VERSION] };
  },
};
