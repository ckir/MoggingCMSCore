import { isAbsolute, relative, resolve, sep } from "node:path";
import { importFolder } from "@mogging/markdown";
import type { ImportReport } from "@mogging/markdown";
import { astroConfigWarnings } from "../starlight/astroConfig.js";
import { UsageError } from "../types.js";
import type { CommandResult, CommandSpec, Flags } from "../types.js";

const SUCCEEDED = new Set(["created", "updated", "unchanged"]);

const USAGE =
  "mogging import [<dir>] [--publish] [--prune] [--accept-new-and-gone] [--restore <file>]... [--dry-run] [--json] [--config <path>] [--database-url <url>]";

/** The Starlight-only flags, in the order a generic project is told about them. */
const STARLIGHT_FLAGS = ["prune", "accept-new-and-gone", "restore", "dry-run"] as const;

/** The `--restore` values as given, or `[]` when the flag was not used. */
function restoreValues(flags: Flags): string[] {
  const v = flags.restore;
  return Array.isArray(v) ? v : [];
}

/** Whether a Starlight-only flag was given (a `multiple` option is an array, so an empty one is not given). */
function given(flags: Flags, name: (typeof STARLIGHT_FLAGS)[number]): boolean {
  return name === "restore" ? restoreValues(flags).length > 0 : flags[name] === true;
}

/**
 * Converts each `--restore` path, typed relative to the working directory, to the project-relative POSIX form the SDK
 * matches (`src/content/docs/de/a.md`).
 *
 * @param flags the parsed flags.
 * @param root the project root (the config's folder).
 * @param cwd the working directory.
 * @returns the converted paths, in the order given.
 * @throws {UsageError} when a path is the project itself or lies outside it.
 */
function restorePaths(flags: Flags, root: string, cwd: string): string[] {
  return restoreValues(flags).map((p) => {
    const rel = relative(root, resolve(cwd, p));
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new UsageError(`--restore ${p} is outside the project ${root}`);
    }
    return rel.split(sep).join("/");
  });
}

const titled = (title: string | null): string => `"${title ?? "(no title)"}"`;

/** The output lines of a Starlight run, in the order the spec lists them. */
function starlightLines(report: ImportReport): string[] {
  const details = report.starlight;
  const lines: string[] = [];
  if (details?.dryRun === true) lines.push("dry run: nothing was written");
  for (const f of report.files) lines.push(`${f.outcome} ${f.file}`);
  for (const slug of details?.pruned ?? []) lines.push(`pruned ${slug}`);
  const stop = details?.stop ?? null;
  if (stop !== null) {
    lines.push(
      `stopped: ${stop.gone.length} page(s) gone and ${stop.added.length} new file(s); nothing was created or pruned`,
    );
    for (const g of stop.gone) lines.push(`  gone ${g.slug} ${titled(g.title)}`);
    for (const a of stop.added) lines.push(`  new ${a.file} ${titled(a.title)}`);
    lines.push(
      stop.command !== null
        ? `run: ${stop.command}`
        : "pair them with mogging rename <old> <new>, or pass --accept-new-and-gone",
    );
  }
  for (const file of details?.behind ?? []) lines.push(`behind ${file}`);
  for (const w of report.warnings) lines.push(`warning: ${w.file}: ${w.message}`);
  for (const e of report.errors) lines.push(`error: ${e.file}: ${e.message}`);
  return lines;
}

/**
 * `mogging import`: the generic `<locale>/<collection>/<slug>.md` folder import, or, in a project whose config
 * exports `starlight`, the Starlight import of the docs folder (spec 5.2 to 5.6) with `--prune`,
 * `--accept-new-and-gone`, `--restore` and `--dry-run`.
 */
export const importSpec: CommandSpec = {
  name: "import",
  summary: "import a <locale>/<collection>/<slug>.md tree as drafts",
  usage: USAGE,
  options: {
    publish: { type: "boolean" },
    prune: { type: "boolean" },
    "accept-new-and-gone": { type: "boolean" },
    restore: { type: "string", multiple: true },
    "dry-run": { type: "boolean" },
  },
  project: "full",
  arity: [0, 1],
  checkLoaded(flags, positionals, loaded) {
    const layout = loaded.starlight;
    if (layout === undefined) {
      for (const name of STARLIGHT_FLAGS) {
        if (given(flags, name)) {
          throw new UsageError(
            `import: --${name} needs a Starlight project (an \`export const starlight\` in ${loaded.configPath})`,
          );
        }
      }
      if (positionals.length === 0) throw new UsageError(`import: missing argument\nusage: ${USAGE}`);
      return;
    }
    if (positionals.length > 0) {
      throw new UsageError(
        `import: a Starlight project imports from its docs folder (${layout.docsDir}); drop the directory argument`,
      );
    }
    restorePaths(flags, loaded.root, loaded.cwd);
  },
  async run(env) {
    const layout = env.project.starlight;
    let report: ImportReport;
    if (layout === undefined) {
      report = await importFolder(env.project.ctx, {
        dir: resolve(env.deps.cwd, env.positionals[0]!),
        publish: env.flags.publish === true,
      });
    } else {
      const { root } = env.project;
      report = await importFolder(env.project.ctx, {
        dir: root,
        publish: env.flags.publish === true,
        starlight: {
          layout,
          prune: env.flags.prune === true,
          acceptNewAndGone: env.flags["accept-new-and-gone"] === true,
          restore: restorePaths(env.flags, root, env.deps.cwd),
          dryRun: env.flags["dry-run"] === true,
        },
      });
      // The astro.config drift warnings come first, and ride in `data.warnings` so `--json` carries them.
      report = { ...report, warnings: [...astroConfigWarnings(root, layout).warnings, ...report.warnings] };
    }
    const lines =
      layout === undefined
        ? [
            ...report.files.map((f) => `${f.outcome} ${f.file}`),
            ...report.warnings.map((w) => `warning: ${w.file}: ${w.message}`),
            ...report.errors.map((e) => `error: ${e.file}: ${e.message}`),
          ]
        : starlightLines(report);

    const result: CommandResult = { data: report, lines };
    if (report.starlight?.stop != null) {
      // Spec 5.4: exit 4 when a safety stop left other files imported, exit 1 when nothing else was imported.
      if (report.files.some((f) => f.outcome === "created" || f.outcome === "updated")) result.exitCode = 4;
      else {
        result.exitCode = 1;
        result.error = { code: "ImportStopped", message: "rename safety stop: nothing was imported" };
      }
      return result;
    }
    const erroring = report.files.filter((f) => f.outcome === "error").length;
    const failed = erroring === 0 && report.errors.length > 0 ? 1 : erroring;
    const done = report.files.filter((f) => SUCCEEDED.has(f.outcome)).length;
    if (failed > 0 && done > 0) result.exitCode = 4;
    else if (failed > 0) {
      result.exitCode = 1;
      const first = report.errors[0];
      result.error = {
        code: "ImportFailed",
        message: first === undefined ? "no file was imported" : `no file was imported: ${first.file}: ${first.message}`,
      };
    }
    return result;
  },
};
