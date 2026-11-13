import { resolve } from "node:path";
import { exportFolder } from "@mogging/markdown";
import { UsageError } from "../types.js";
import type { CommandSpec } from "../types.js";

/** The string values of a `multiple` option, or `undefined` when it was not given. */
function listOf(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined;
}

export const exportSpec: CommandSpec = {
  name: "export",
  summary: "write the published content as a <locale>/<collection>/<slug>.md tree",
  usage: "mogging export <dir> [--collection <c>]... [--locale <l>]... [--json] [--config <path>] [--database-url <url>]",
  options: { collection: { type: "string", multiple: true }, locale: { type: "string", multiple: true } },
  project: "full",
  arity: [1, 1],
  async run(env) {
    const { config } = env.project.ctx;
    const collections = listOf(env.flags.collection);
    const locales = listOf(env.flags.locale);
    // exportFolder drops what it does not know without a word, so a typo would export nothing and exit 0.
    for (const name of collections ?? []) {
      if (!config.collections.some((c) => c.name === name)) {
        throw new UsageError(
          `unknown collection "${name}" (declared: ${config.collections.map((c) => c.name).join(", ")})`,
        );
      }
    }
    const declared = [config.locales.source, ...Object.keys(config.locales.chains)];
    for (const locale of locales ?? []) {
      if (!declared.includes(locale)) throw new UsageError(`unknown locale "${locale}" (declared: ${declared.join(", ")})`);
    }

    const report = await exportFolder(env.project.ctx, {
      dir: resolve(env.deps.cwd, env.positionals[0]!),
      ...(collections === undefined ? {} : { collections }),
      ...(locales === undefined ? {} : { locales }),
    });
    return {
      data: report,
      lines: [...report.files.map((f) => `wrote ${f}`), ...report.warnings.map((w) => `warning: ${w.file}: ${w.message}`)],
    };
  },
};
