import { table } from "../output.js";
import { UsageError } from "../types.js";
import type { CommandSpec } from "../types.js";

/** The top-level usage text: the command list and the options every command accepts. */
export function rootUsage(commands: readonly CommandSpec[]): string[] {
  return [
    "usage: mogging [--json] [--config <file>] [--database-url <url>] [--actor <name>] <command> [options]",
    "",
    "commands:",
    ...table(commands.map((c) => [c.name, c.summary])).map((l) => `  ${l}`),
    "",
    "options for every command:",
    "  --json                 print one JSON document instead of text",
    "  --config <file>        the config module (default: mogging.config.ts|.mts|.js|.mjs in the current directory)",
    "  --database-url <url>   the database (default: MOGGING_DATABASE_URL, then DATABASE_URL)",
    "  --actor <name>         who is acting (default: MOGGING_ACTOR, then the OS user)",
    "  --help                 print the usage of a command",
    "  --version              print the version (before the command)",
  ];
}

export const helpCommand: CommandSpec = {
  name: "help",
  summary: "print the usage of mogging or of one command",
  usage: "mogging help [command]",
  options: {},
  project: "none",
  arity: [0, 1],
  async run(env) {
    const commands = env.deps.commands ?? [];
    const [name] = env.positionals;
    if (name === undefined) {
      const lines = rootUsage(commands);
      return { data: { usage: lines }, lines };
    }
    const spec = commands.find((c) => c.name === name);
    if (spec === undefined) throw new UsageError(`unknown command ${name}`);
    return { data: { usage: [spec.usage] }, lines: [spec.usage] };
  },
};
