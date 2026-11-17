import { renamePage } from "@mogging/markdown";
import { UsageError } from "../types.js";
import type { CommandResult, CommandSpec } from "../types.js";

const USAGE =
  "mogging rename <old-slug> <new-slug> [--dry-run] [--json] [--config <path>] [--database-url <url>]";

/**
 * `mogging rename`: a thin layer over the SDK's `renamePage` (spec 5.6). It renames a Starlight page's slug, moves the
 * English file and every locale's file, and lists the lines that still name the old slug. A project whose config does
 * not export `starlight` is a usage error, raised before the database is opened. The SDK's `ValidationError` and
 * `ConflictError` end the run with exit 1 through the shared error mapping.
 */
export const renameSpec: CommandSpec = {
  name: "rename",
  summary: "rename a Starlight page's slug and keep its translations",
  usage: USAGE,
  options: { "dry-run": { type: "boolean" } },
  project: "full",
  arity: [2, 2],
  checkLoaded(_flags, _positionals, loaded) {
    if (loaded.starlight === undefined) {
      throw new UsageError(
        `rename needs a Starlight project (an \`export const starlight\` in ${loaded.configPath})`,
      );
    }
  },
  async run(env) {
    const layout = env.project.starlight;
    if (layout === undefined) {
      throw new UsageError(
        `rename needs a Starlight project (an \`export const starlight\` in ${env.project.configPath})`,
      );
    }
    const [from, to] = env.positionals as [string, string];
    const report = await renamePage(env.project.ctx, {
      dir: env.project.root,
      layout,
      from,
      to,
      dryRun: env.flags["dry-run"] === true,
    });
    const lines: string[] = [];
    if (report.dryRun) lines.push("dry run: nothing was written");
    for (const a of report.actions) lines.push(`move ${a.path} -> ${a.to}`);
    for (const r of report.references) lines.push(`reference ${r.file}:${r.line}: ${r.text}`);
    for (const w of report.warnings) lines.push(`warning: ${w.file}: ${w.message}`);
    lines.push(report.reminder);
    const result: CommandResult = { data: report, lines };
    return result;
  },
};
