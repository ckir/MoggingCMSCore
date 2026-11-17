import { resolve } from "node:path";
import { normalizeLocale } from "@mogging/core";
import type { MoggingConfig } from "@mogging/core";
import { exportFolder } from "@mogging/markdown";
import type { ExportReport } from "@mogging/markdown";
import { astroConfigWarnings } from "../starlight/astroConfig.js";
import { UsageError } from "../types.js";
import type { CommandResult, CommandSpec, Flags } from "../types.js";

const USAGE =
  "mogging export [<dir>] [--collection <c>]... [--locale <l>]... [--dry-run] [--json] [--config <path>] [--database-url <url>]";

/** The string values of a `multiple` option, or `undefined` when it was not given. */
function listOf(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined;
}

/**
 * Checks the `--collection` and `--locale` values against the config and normalizes the locales.
 *
 * `exportFolder` drops what it does not know without a word, so a typo would export nothing and exit 0. A malformed
 * tag makes `normalizeLocale` throw; that is reported as the same unknown-locale usage error.
 *
 * @param flags the parsed flags.
 * @param config the validated config.
 * @returns the collections as given and the normalized locales, each `undefined` when its flag was not given.
 * @throws {UsageError} when a collection or locale is not declared.
 */
function checkedSelection(
  flags: Flags,
  config: MoggingConfig,
): { collections: string[] | undefined; locales: string[] | undefined } {
  const collections = listOf(flags.collection);
  for (const name of collections ?? []) {
    if (!config.collections.some((c) => c.name === name)) {
      throw new UsageError(
        `unknown collection "${name}" (declared: ${config.collections.map((c) => c.name).join(", ")})`,
      );
    }
  }
  const declared = [config.locales.source, ...Object.keys(config.locales.chains)];
  const locales = listOf(flags.locale)?.map((raw) => {
    let tag: string | null;
    try {
      tag = normalizeLocale(raw);
    } catch {
      tag = null;
    }
    if (tag === null || !declared.includes(tag)) {
      throw new UsageError(`unknown locale "${raw}" (declared: ${declared.join(", ")})`);
    }
    return tag;
  });
  return { collections, locales };
}

/** The output lines of a Starlight run: header, actions, the kept count, attention and warnings. */
function starlightLines(report: ExportReport): string[] {
  const details = report.starlight;
  const lines: string[] = [];
  if (details?.dryRun === true) lines.push("dry run: nothing was written");
  let kept = 0;
  for (const a of details?.actions ?? []) {
    if (a.action === "keep" && details?.dryRun !== true) {
      kept++;
      continue;
    }
    lines.push(`${a.action} ${a.path}${a.to === undefined ? "" : ` -> ${a.to}`} (${a.reason})`);
  }
  if (kept > 0) lines.push(`kept ${kept} unchanged locale file(s)`);
  for (const a of details?.attention ?? []) lines.push(`attention: ${a.file}: ${a.message}`);
  for (const w of report.warnings) lines.push(`warning: ${w.file}: ${w.message}`);
  return lines;
}

/**
 * `mogging export`: the generic `<locale>/<collection>/<slug>.md` tree export, or, in a project whose config exports
 * `starlight`, the Starlight export of the docs folder (spec 5.4) with `--dry-run`, the Starlight locale check and
 * exit 4 when the run needs attention.
 */
export const exportSpec: CommandSpec = {
  name: "export",
  summary: "write the published content as a <locale>/<collection>/<slug>.md tree",
  usage: USAGE,
  options: {
    collection: { type: "string", multiple: true },
    locale: { type: "string", multiple: true },
    "dry-run": { type: "boolean" },
  },
  project: "full",
  arity: [0, 1],
  checkLoaded(flags, positionals, loaded) {
    const layout = loaded.starlight;
    if (layout === undefined) {
      if (flags["dry-run"] === true) {
        throw new UsageError(
          `export: --dry-run needs a Starlight project (an \`export const starlight\` in ${loaded.configPath})`,
        );
      }
      if (positionals.length === 0) throw new UsageError(`export: missing argument\nusage: ${USAGE}`);
    } else {
      if (positionals.length > 0) {
        throw new UsageError(
          `export: a Starlight project exports its docs folder (${layout.docsDir}); drop the directory argument`,
        );
      }
      if (listOf(flags.collection) !== undefined) {
        throw new UsageError("export: a Starlight project has one docs collection; drop --collection");
      }
    }
    checkedSelection(flags, loaded.config);
  },
  async run(env) {
    const { config } = env.project.ctx;
    const { collections, locales } = checkedSelection(env.flags, config);
    const layout = env.project.starlight;
    let report: ExportReport;
    if (layout === undefined) {
      report = await exportFolder(env.project.ctx, {
        dir: resolve(env.deps.cwd, env.positionals[0]!),
        ...(collections === undefined ? {} : { collections }),
        ...(locales === undefined ? {} : { locales }),
      });
    } else {
      const { root } = env.project;
      const { localeDirs, warnings } = astroConfigWarnings(root, layout);
      report = await exportFolder(env.project.ctx, {
        dir: root,
        ...(locales === undefined ? {} : { locales }),
        starlight: { layout, dryRun: env.flags["dry-run"] === true, starlightLocaleDirs: localeDirs },
      });
      // The astro.config warnings come first, and ride in `data.warnings` so `--json` carries them.
      report = { ...report, warnings: [...warnings, ...report.warnings] };
    }
    const lines =
      layout === undefined
        ? [
            ...report.files.map((f) => `wrote ${f}`),
            ...report.warnings.map((w) => `warning: ${w.file}: ${w.message}`),
          ]
        : starlightLines(report);
    const result: CommandResult = { data: report, lines };
    // Spec 5.4: exit 4 when the run left something the operator must act on.
    if ((report.starlight?.attention.length ?? 0) > 0) result.exitCode = 4;
    return result;
  },
};
