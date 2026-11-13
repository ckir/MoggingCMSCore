import { resolve } from "node:path";
import { importFolder } from "@mogging/markdown";
import type { CommandResult, CommandSpec } from "../types.js";

const SUCCEEDED = new Set(["created", "updated", "unchanged"]);

export const importSpec: CommandSpec = {
  name: "import",
  summary: "import a <locale>/<collection>/<slug>.md tree as drafts",
  usage: "mogging import <dir> [--publish] [--json] [--config <path>] [--database-url <url>]",
  options: { publish: { type: "boolean" } },
  project: "full",
  arity: [1, 1],
  async run(env) {
    const report = await importFolder(env.project.ctx, {
      dir: resolve(env.deps.cwd, env.positionals[0]!),
      publish: env.flags.publish === true,
    });
    const lines = [
      ...report.files.map((f) => `${f.outcome} ${f.file}`),
      ...report.warnings.map((w) => `warning: ${w.file}: ${w.message}`),
      ...report.errors.map((e) => `error: ${e.file}: ${e.message}`),
    ];

    const erroring = report.files.filter((f) => f.outcome === "error").length;
    const failed = erroring === 0 && report.errors.length > 0 ? 1 : erroring;
    const done = report.files.filter((f) => SUCCEEDED.has(f.outcome)).length;
    const result: CommandResult = { data: report, lines };
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
