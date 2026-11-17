import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeLocale } from "@mogging/core";
import { UsageError } from "../types.js";
import type { AstroConfigRead, AstroLocale } from "./astroConfig.js";

/**
 * The commented AI block that ends every config `init` writes (plain and Starlight): fixed text, never edited.
 * `init.ts` builds its template from it, so the two configs cannot drift apart.
 */
export const AI_CONFIG_BLOCK = `// AI translation (optional). Uncomment, then set the model ids and prices from your provider.
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

/** What `init --starlight` decided: the Mogging locales and folders, and what the adopter must paste into astro.config. */
export type StarlightAnswers = {
  /** The source locale tag. */
  source: string;
  /** The target locales, each with its Starlight folder. */
  targets: Array<{ tag: string; dir: string }>;
  /** The source locale's folder, or `null` in root-locale mode. */
  sourceDir: string | null;
  /** The docs folder relative to the project root. */
  docsDir: string;
  /** The header line plus the `locales` block to paste into astro.config (joined by `\n`), or `null` when none is needed. */
  pasteBlock: string | null;
  /** Warnings to print on stderr. */
  warnings: string[];
};

/** The `@astrojs/starlight` versions `@mogging/starlight` supports: `>=min <below`. */
export const STARLIGHT_RANGE: { readonly min: "0.43.0"; readonly below: "0.44.0" } = {
  min: "0.43.0",
  below: "0.44.0",
};

const usage = (message: string): UsageError => new UsageError(`init --starlight: ${message}`);

/** `normalizeLocale`, with its `ValidationError` turned into a usage error that starts with `where`. */
function normalize(tag: string, where: string): string {
  try {
    return normalizeLocale(tag);
  } catch (e) {
    if (e instanceof Error && e.name === "ValidationError") throw usage(`${where}: ${e.message}`);
    throw e;
  }
}

/** The language's own name for itself (`de` is `Deutsch`); the tag when the runtime has no name for it. */
function labelOf(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** One line of a Starlight `locales` block; `root` is written bare, every other key quoted. */
function entryLine(key: string, label: string, lang: string): string {
  const name = key === "root" ? "root" : JSON.stringify(key);
  return `      ${name}: { label: ${JSON.stringify(label)}, lang: ${JSON.stringify(lang)} },`;
}

/** The header plus a whole `locales` block from `entries` (`[key, label, lang]`), joined by `\n`. */
function block(header: string, entries: Array<[string, string, string]>): string {
  return [header, "    locales: {", ...entries.map(([k, label, lang]) => entryLine(k, label, lang)), "    },"].join("\n");
}

/** The `--locales` list: each tag normalized, its folder the lowercase tag. */
function targetsFromFlag(list: string): Array<{ tag: string; dir: string }> {
  return list.split(",").map((raw) => {
    const tag = normalize(raw.trim(), "--locales");
    return { tag, dir: tag.toLowerCase() };
  });
}

/** Refuses a duplicate tag or folder among the targets, and a target equal to the source (or its folder). */
function checkDistinct(source: string, sourceDir: string | null, targets: Array<{ tag: string; dir: string }>): void {
  const tags = new Set<string>();
  const dirs = new Set<string>(sourceDir === null ? [] : [sourceDir]);
  for (const t of targets) {
    if (t.tag === source) throw usage(`the locale "${t.tag}" is the source locale and cannot also be a target`);
    if (tags.has(t.tag)) throw usage(`the locale "${t.tag}" appears twice`);
    if (dirs.has(t.dir)) throw usage(`the folder "${t.dir}" is used twice (locale "${t.tag}")`);
    tags.add(t.tag);
    dirs.add(t.dir);
  }
}

/**
 * Decides the Mogging locales and folders `init --starlight` writes (spec 5.2 "Locale identity", 6): the Starlight
 * `locales` of a readable astro.config, or `--locales`/`--source-locale` when the site has one language or cannot be
 * read statically. Never prompts.
 *
 * @param read the static read of the site's astro.config.
 * @param flags the `--locales` list and the `--source-locale` tag as typed.
 * @returns the answers, including the `locales` block to paste into astro.config when the site needs one.
 * @throws {UsageError} when the flags and astro.config disagree, a flag is malformed, a tag or folder repeats, or
 * astro.config's locales are inconsistent.
 */
export function starlightAnswers(
  read: AstroConfigRead,
  flags: { locales?: string; sourceLocale?: string },
): StarlightAnswers {
  if (!read.ok) {
    if (flags.locales === undefined) {
      throw usage(
        `astro.config could not be read statically (${read.reason}); pass --locales de,fr and, if the site's default ` +
          "language is not English, --source-locale <tag>",
      );
    }
    const source = normalize(flags.sourceLocale ?? "en", "--source-locale");
    const targets = targetsFromFlag(flags.locales);
    checkDistinct(source, null, targets);
    return {
      source, targets, sourceDir: null, docsDir: "src/content/docs", pasteBlock: null,
      warnings: [`astro.config could not be read statically (${read.reason}); the locales come from --locales`],
    };
  }

  const locales = read.locales ?? [];
  if (locales.length === 0) {
    // Starlight's own single-language default: nothing declared, so the adopter adds the whole block.
    if (flags.locales === undefined) {
      throw usage("this site has one language; pass --locales de,fr (the languages to add)");
    }
    const source = normalize(flags.sourceLocale ?? "en", "--source-locale");
    const targets = targetsFromFlag(flags.locales);
    checkDistinct(source, null, targets);
    const entries: Array<[string, string, string]> = [
      ["root", labelOf(source), source],
      ...targets.map((t): [string, string, string] => [t.dir, labelOf(t.tag), t.tag]),
    ];
    return {
      source, targets, sourceDir: null, docsDir: read.docsDir,
      pasteBlock: block("add this to the starlight() options in astro.config:", entries), warnings: [],
    };
  }

  // Which entry is the default language: `root` (no folder) or the `defaultLocale` key (its own folder).
  const rootMode = read.defaultLocale === null || read.defaultLocale === "root";
  const hasRoot = locales.some((l) => l.key === "root");
  let defaultKey: string;
  if (rootMode) {
    if (!hasRoot) throw usage("astro.config has locales but neither a root locale nor defaultLocale");
    defaultKey = "root";
  } else {
    defaultKey = read.defaultLocale!;
    if (!locales.some((l) => l.key === defaultKey)) {
      throw usage(`astro.config defaultLocale "${defaultKey}" is not one of its locales`);
    }
    if (hasRoot) throw usage(`astro.config has a root locale and also defaultLocale "${defaultKey}"`);
  }
  const defaultEntry = locales.find((l) => l.key === defaultKey) as AstroLocale;
  const others = locales.filter((l) => l.key !== defaultKey);
  const sourceDir = rootMode ? null : defaultKey;

  if (others.length > 0) {
    if (flags.locales !== undefined || flags.sourceLocale !== undefined) {
      throw usage("astro.config declares Starlight's locales; drop --locales and --source-locale (or edit astro.config)");
    }
    const source = normalize(defaultEntry.lang, `astro.config locale "${defaultKey}"`);
    const targets = others.map((l) => ({ tag: normalize(l.lang, `astro.config locale "${l.key}"`), dir: l.key }));
    checkDistinct(source, sourceDir, targets);
    return { source, targets, sourceDir, docsDir: read.docsDir, pasteBlock: null, warnings: [] };
  }

  // Only the default language is declared: keep it as the source and add the --locales ones.
  if (flags.sourceLocale !== undefined) {
    throw usage("astro.config declares Starlight's locales; drop --locales and --source-locale (or edit astro.config)");
  }
  if (flags.locales === undefined) {
    throw usage("this site has one language; pass --locales de,fr (the languages to add)");
  }
  const source = normalize(defaultEntry.lang, `astro.config locale "${defaultKey}"`);
  const targets = targetsFromFlag(flags.locales);
  checkDistinct(source, sourceDir, targets);
  const entries: Array<[string, string, string]> = [
    [defaultKey, defaultEntry.label ?? labelOf(source), defaultEntry.lang],
    ...targets.map((t): [string, string, string] => [t.dir, labelOf(t.tag), t.tag]),
  ];
  return {
    source, targets, sourceDir, docsDir: read.docsDir,
    pasteBlock: block("replace the locales block of the starlight() options in astro.config with:", entries),
    warnings: [],
  };
}

/**
 * The text of the `mogging.config.ts` that `init --starlight` writes: the `@mogging/starlight` preset, the source
 * locale with one fallback chain per target, the `starlight` export the CLI reads, and the commented AI block.
 *
 * @param a the answers from `starlightAnswers`.
 * @returns the file text, ending in a newline.
 */
export function starlightConfigText(a: StarlightAnswers): string {
  const q = JSON.stringify;
  const dirs = a.targets.map((t) => `${q(t.tag)}: ${q(t.dir)}`).join(", ");
  const chains = a.targets.map((t) => `${q(t.tag)}: [${q(a.source)}]`).join(", ");
  return `import { defineConfig } from "@mogging/core";
import { starlightPreset } from "@mogging/starlight/preset";

// The Starlight docs collection and its layout (folders, locale folders, front-matter mapping).
const docs = starlightPreset({
  docsDir: ${q(a.docsDir)},
  sourceDir: ${q(a.sourceDir)},
  localeDirs: { ${dirs} },
});

export const config = defineConfig({
  collections: [docs.collection],
  locales: { source: ${q(a.source)}, chains: { ${chains} } },
});

// Read by the mogging CLI: where the docs live and how front matter maps to fields.
export const starlight = docs.layout;

${AI_CONFIG_BLOCK}`;
}

/** `x.y.z` as numbers from a version string (a pre-release or build suffix is ignored), or `null`. */
function parseVersion(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Checks the installed `@astrojs/starlight` against `STARLIGHT_RANGE`. Looks for
 * `node_modules/@astrojs/starlight/package.json` in `root` and then in each parent folder (a hoisted monorepo
 * install); it reads the file rather than resolving the package, because Starlight's `exports` has no
 * `./package.json`.
 *
 * @param root the project root.
 * @returns a warning text (without the `warning: ` prefix), or `null` when the installed version is supported.
 */
export function starlightVersionWarning(root: string): string | null {
  const min = parseVersion(STARLIGHT_RANGE.min)!;
  const below = parseVersion(STARLIGHT_RANGE.below)!;
  let dir = root;
  for (;;) {
    let text: string | undefined;
    try {
      text = readFileSync(join(dir, "node_modules", "@astrojs", "starlight", "package.json"), "utf8");
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      let version = "unreadable";
      try {
        const v = (JSON.parse(text) as { version?: unknown }).version;
        version = typeof v === "string" ? v : "unknown";
      } catch {
        // an unreadable package.json counts as a version that does not parse
      }
      const parsed = parseVersion(version);
      if (parsed === null || compareVersions(parsed, min) < 0 || compareVersions(parsed, below) >= 0) {
        return `@astrojs/starlight ${version} is outside the range @mogging/starlight supports (>=${STARLIGHT_RANGE.min} <${STARLIGHT_RANGE.below})`;
      }
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return `@astrojs/starlight is not installed in ${root}; install it before building the site`;
    }
    dir = parent;
  }
}
