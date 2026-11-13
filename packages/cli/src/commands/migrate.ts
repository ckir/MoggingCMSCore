import { migrate } from "@mogging/core";
import type { CommandSpec } from "../types.js";

/** One line per applied migration, or a single line saying there was nothing to do. */
export function appliedLines(applied: string[]): string[] {
  return applied.length === 0 ? ["database is up to date"] : applied.map((name) => `applied ${name}`);
}

export const migrateSpec: CommandSpec = {
  name: "migrate",
  summary: "apply pending database migrations",
  usage: "mogging migrate [--json] [--config <path>] [--database-url <url>]",
  options: {},
  project: "full",
  arity: [0, 0],
  async run(env) {
    const applied = await migrate(env.project.sql);
    return { data: { applied }, lines: appliedLines(applied) };
  },
};
