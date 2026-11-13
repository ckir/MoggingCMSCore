import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { UsageError } from "./types.js";
import type { CommandSpec, Flags } from "./types.js";

type Options = NonNullable<ParseArgsConfig["options"]>;

/**
 * Options every command accepts. `--version` is deliberately not here: `splitCommand` alone recognises it, before
 * the verb. After a verb it is an unknown option unless the command's own `options` define it (`review approve`
 * takes a string `version`); a shared boolean `version` would let `publish docs/x --version 3` run with a stray
 * positional.
 */
export const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  config: { type: "string" },
  "database-url": { type: "string" },
  actor: { type: "string" },
  help: { type: "boolean" },
} as const satisfies Options;

type GlobalName = keyof typeof GLOBAL_OPTIONS;
const isGlobal = (name: string): name is GlobalName => Object.hasOwn(GLOBAL_OPTIONS, name);

/**
 * Finds the verb. Leading tokens that are global options (a string option also consumes its value, unless written
 * `--name=value`) or `--version` are skipped; the first other token is the verb, whatever it looks like, so a
 * stray `--locale` there becomes an unknown command. `rest` is `argv` with only the verb token removed.
 */
export function splitCommand(argv: string[]): { command: string | undefined; rest: string[]; versionFlag: boolean } {
  let versionFlag = false;
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--version") {
      versionFlag = true;
      i += 1;
      continue;
    }
    const m = /^--([^=]+)(=.*)?$/s.exec(token);
    if (m !== null && isGlobal(m[1]!)) {
      const consumesNext = GLOBAL_OPTIONS[m[1] as GlobalName].type === "string" && m[2] === undefined;
      i += consumesNext ? 2 : 1;
      continue;
    }
    return { command: token, rest: [...argv.slice(0, i), ...argv.slice(i + 1)], versionFlag };
  }
  return { command: undefined, rest: argv, versionFlag };
}

/** `parseArgs` in strict mode: usage mistakes become `UsageError`, and a single-value option may appear once. */
export function parseCommand(args: string[], spec: CommandSpec): { flags: Flags; positionals: string[] } {
  const options: Options = { ...GLOBAL_OPTIONS, ...spec.options };
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true, tokens: true });
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) throw new UsageError((e as Error).message);
    throw e;
  }
  // parseArgs keeps the last of a repeated single-value option; the tokens still count every occurrence.
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== "option") continue;
    if (options[token.name]?.multiple === true) continue;
    if (seen.has(token.name)) throw new UsageError(`--${token.name} given more than once`);
    seen.add(token.name);
  }
  return { flags: { ...parsed.values } as Flags, positionals: parsed.positionals };
}

const flagName = (name: string) => (name.startsWith("--") ? name : `--${name}`);

/** An integer option: digits only (`Number()` alone would accept `1e1`, `0x10`, ` 3 `), at least `min`, at most `max`. */
export function intOption(name: string, text: string | undefined, min: number, max?: number): number | undefined {
  if (text === undefined) return undefined;
  const flag = flagName(name);
  if (!/^[0-9]+$/.test(text)) throw new UsageError(`${flag} must be a whole number, got "${text}"`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new UsageError(`${flag} is too large: "${text}"`);
  if (n < min) throw new UsageError(`${flag} must be at least ${min}, got ${n}`);
  if (max !== undefined && n > max) throw new UsageError(`${flag} must be at most ${max}, got ${n}`);
  return n;
}

/** A USD amount: plain decimal digits and strictly positive. */
export function usdOption(name: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const flag = flagName(name);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) throw new UsageError(`${flag} must be an amount in USD such as 0.50, got "${text}"`);
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be greater than 0, got "${text}"`);
  return n;
}
