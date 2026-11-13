import { spawn } from "node:child_process";
import { createJiti } from "jiti";
import postgres from "postgres";
import { getLicenceState } from "@mogging/core";
import { parseCommand, splitCommand } from "./args.js";
import { commands as registry } from "./commands/index.js";
import { rootUsage } from "./commands/help.js";
import { VERSION } from "./commands/version.js";
import { describeError, jsonDocument, licenceInfo, licenceLines, maskSecrets } from "./output.js";
import { loadProject } from "./project.js";
import { UsageError } from "./types.js";
import type { CommandEnv, CommandResult, Deps, Io, LicenceInfo, Project } from "./types.js";

function defaultIo(): Io {
  const tty = process.stdout.isTTY === true;
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    stdin: process.stdin,
    isTTY: tty && process.stdin.isTTY === true,
    width: process.stdout.columns,
    color: tty && process.env.NO_COLOR === undefined,
  };
}

/** `$VISUAL || $EDITOR || vi`, split on whitespace; the first token is spawned with the rest plus the file. */
function openEditor(file: string): Promise<void> {
  const [command, ...args] = (process.env.VISUAL || process.env.EDITOR || "vi").trim().split(/\s+/);
  return new Promise((resolve, reject) => {
    const child = spawn(command!, [...args, file], { shell: false, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`editor ${command} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

function defaultDeps(): Deps {
  return {
    io: defaultIo(),
    env: process.env,
    cwd: process.cwd(),
    loadModule: async (path) => (await createJiti(import.meta.url).import(path)) as Record<string, unknown>,
    connect: (url) => postgres(url, { max: 4, onnotice: () => {} }),
    now: () => new Date(),
    editor: openEditor,
    exit: (code) => process.exit(code),
  };
}

/** Errors map to an exit code by `name`/`code`, never `instanceof`: the user's config may load a second copy of core. */
function exitCodeFor(err: unknown): number {
  const e = (typeof err === "object" && err !== null ? err : {}) as { name?: unknown; code?: unknown };
  if (e.name === "UsageError") return 2;
  if (e.name === "LicenceError" || (typeof e.code === "string" && e.code.startsWith("LICENCE_"))) return 3;
  return 1;
}

/** Runs the CLI and returns its exit code. Every stdout and stderr write goes through `maskSecrets`. */
export async function run(argv: string[], overrides: Partial<Deps> = {}): Promise<number> {
  const base: Deps = { ...defaultDeps(), ...overrides };
  const raw = base.io;
  const io: Io = { ...raw, out: (s) => raw.out(maskSecrets(s)), err: (s) => raw.err(maskSecrets(s)) };
  const deps: Deps = { ...base, io, commands: base.commands ?? registry };

  let json = argv.includes("--json"); // refined once the options are parsed; a parse error is itself reported as JSON
  let licence: LicenceInfo | null = null;
  let project: Project | undefined;
  let removeListeners: (() => void) | undefined;
  try {
    // 1. the verb
    const { command, rest, versionFlag } = splitCommand(argv);
    if (versionFlag) {
      io.out(`${VERSION}\n`);
      return 0;
    }
    if (command === undefined) {
      const usage = rootUsage(deps.commands!).map((l) => `${l}\n`).join("");
      if (argv.includes("--help")) {
        io.out(usage);
        return 0;
      }
      io.err(usage);
      return 2;
    }
    const spec = deps.commands!.find((c) => c.name === command);
    if (spec === undefined) throw new UsageError(`unknown command ${command}`);

    // 2. options, --help, arity
    const { flags, positionals } = parseCommand(rest, spec);
    json = flags.json === true;
    if (flags.help === true) {
      io.out(`${spec.usage}\n`);
      return 0;
    }
    const [min, max] = spec.arity;
    if (positionals.length < min || positionals.length > max) {
      const problem = positionals.length < min ? "missing argument" : `unexpected argument ${positionals[max]}`;
      throw new UsageError(`${spec.name}: ${problem}\nusage: ${spec.usage}`);
    }

    // 3. command-specific rules, before anything is loaded or connected
    spec.validate?.(flags, positionals, io);

    // 4. signals: only a command that honours env.signal gets listeners (anything else dies on Ctrl-C by default)
    const wantsSignal =
      typeof spec.usesSignal === "function" ? spec.usesSignal(flags, positionals) : spec.usesSignal === true;
    let signal: AbortSignal;
    if (wantsSignal) {
      const controller = new AbortController();
      let received = 0;
      const onSignal = () => {
        received += 1;
        if (received === 1) {
          io.err("interrupted: stopping after the current step (interrupt again to quit now)\n");
          controller.abort();
        } else {
          deps.exit(130);
        }
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      removeListeners = () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      };
      signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
    } else {
      signal = deps.signal ?? new AbortController().signal;
    }

    // 5. the project and the licence line
    if (spec.project === "full") {
      project = await loadProject(deps, flags);
      licence = licenceInfo(await getLicenceState(project.ctx, { publicKeys: deps.licenceKeys }));
      for (const line of licenceLines(licence)) io.err(`${line}\n`);
      if (spec.needsAi && project.ai === undefined) {
        throw new UsageError(`${spec.name} needs an \`ai\` export in ${project.configPath} (defineAiConfig)`);
      }
    }

    // 6. the command
    const env = { project, io, flags, positionals, signal, deps, json } as CommandEnv;
    const result: CommandResult = await spec.run(env);
    const exitCode = result.exitCode ?? 0;
    if (exitCode === 1 && result.error === undefined) throw new Error("exit 1 without error");
    if (json) io.out(`${JSON.stringify(jsonDocument({ result, licence }), null, 2)}\n`);
    else for (const line of result.lines) io.out(`${line}\n`);
    if (exitCode === 1) io.err(`error: ${result.error!.message}\n`);
    return exitCode;
  } catch (err) {
    // 7. any throw
    const failure = describeError(err);
    io.err(`error: ${failure.message}\n`);
    if (json) io.out(`${JSON.stringify(jsonDocument({ error: failure, licence }), null, 2)}\n`);
    return exitCodeFor(err);
  } finally {
    // 8. cleanup never changes the exit code
    removeListeners?.();
    try {
      await project?.close();
    } catch (e) {
      io.err(`warning: closing the database failed: ${describeError(e).message}\n`);
    }
  }
}
