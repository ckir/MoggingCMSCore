import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getLicenceState, migrate } from "@mogging/core";
import { licenceInfo, licenceLines } from "../output.js";
import { CONFIG_NAMES, configFlag, loadProject, present, resolveDatabaseUrl } from "../project.js";
import type { CommandSpec, Deps, Flags } from "../types.js";
import { appliedLines } from "./migrate.js";

/** Fixed text: `init` writes it verbatim and never edits `.gitignore` or `.env`. */
export const CONFIG_TEMPLATE = `import { defineConfig, defineCollection, slug, text, richText } from "@mogging/core";

const docs = defineCollection("docs", {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
});

export const config = defineConfig({
  collections: [docs],
  locales: { source: "en", chains: { de: ["en"] } },
});

// AI translation (optional). Uncomment, then set the model ids and prices from your provider.
// Secrets are read from the environment, never from this file:
//   OPENROUTER_API_KEY   the OpenRouter API key used by \`mogging compile\` and \`mogging worker\`
//   MOGGING_LICENSE_KEY  your MoggingCMS licence key (without one, the 30-day evaluation applies)
//
// import { defineAiConfig } from "@mogging/ai";
//
// export const ai = defineAiConfig({
//   provider: { kind: "openrouter" },
//   models: { translate: "<vendor>/<model-id>" },
//   prices: { "<vendor>/<model-id>": { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 128000 } },
//   budgets: { monthlyCapUsd: 10 },
// });
`;

/**
 * Writes the template unless a config already exists. `wx` fails with `EEXIST` for any existing path, a symlink
 * (dangling or not) included, so an existing file is never written through. Returns whether the file was created.
 */
async function writeTemplate(deps: Deps, flags: Flags): Promise<{ path: string; created: boolean }> {
  let path: string;
  const given = configFlag(flags);
  if (given !== undefined) {
    path = resolve(deps.cwd, given);
  } else {
    const found = CONFIG_NAMES.map((name) => resolve(deps.cwd, name)).find(present);
    if (found !== undefined) return { path: found, created: false };
    path = resolve(deps.cwd, CONFIG_NAMES[0]!);
  }
  try {
    await writeFile(path, CONFIG_TEMPLATE, { flag: "wx" });
    return { path, created: true };
  } catch (e) {
    if ((e as { code?: unknown }).code === "EEXIST") return { path, created: false };
    throw e;
  }
}

export const initSpec: CommandSpec = {
  name: "init",
  summary: "write mogging.config.ts if there is none and apply the migrations",
  usage: "mogging init [--json] [--config <path>] [--database-url <url>]",
  options: {},
  project: "none",
  arity: [0, 0],
  async run(env) {
    const { deps, flags, io } = env;
    resolveDatabaseUrl(flags, deps.env); // a missing URL is a usage error before anything is written
    const { path, created } = await writeTemplate(deps, flags);
    const project = await loadProject(deps, flags);
    try {
      const licence = licenceInfo(await getLicenceState(project.ctx, { publicKeys: deps.licenceKeys }));
      for (const line of licenceLines(licence)) io.err(`${line}\n`);
      const applied = await migrate(project.sql);
      const first = created ? `created ${path}` : `${path} already exists: left unchanged`;
      return { data: { configCreated: created, applied }, lines: [first, ...appliedLines(applied)], licence };
    } finally {
      await project.close();
    }
  },
};
