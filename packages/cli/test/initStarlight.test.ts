import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Sql } from "postgres";
import { defineStarlightLayout } from "@mogging/markdown";
import { CONFIG_TEMPLATE } from "../src/commands/init.js";
import { run } from "../src/run.js";
import {
  STARLIGHT_RANGE, starlightAnswers, starlightConfigText, starlightVersionWarning,
} from "../src/starlight/initStarlight.js";
import type { AstroConfigRead } from "../src/starlight/astroConfig.js";
import { withTestDb } from "./db.js";
import { connectionOver, testDeps } from "./fixtures.js";
import { ASTRO_ROOT_DE_ZH } from "./starlightFixtures.js";

// Under packages/cli, not os.tmpdir(): the written config imports `@mogging/core` and `@mogging/starlight/preset`,
// which resolve only from inside a package that depends on them (as in init.test.ts).
const CLI_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dirs: string[] = [];
function tempDir(parent = CLI_DIR): string {
  const d = mkdtempSync(join(parent, ".tmp-initsl-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** `testDeps` minus its `loadModule`, so `run` loads the written file through the real jiti loader. */
function realLoader(sql: Sql, cwd: string, overrides: Parameters<typeof testDeps>[1] = {}) {
  const base = testDeps(sql, { cwd, ...overrides });
  const { loadModule: _stub, ...deps } = base;
  void _stub;
  return { base, deps };
}

const write = (dir: string, rel: string, text: string) => {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};

type Loaded = {
  config: { locales: { source: string; chains: Record<string, string[]> } };
  starlight: Record<string, unknown>;
};
const load = async (file: string) => (await createJiti(import.meta.url).import(file)) as Loaded;
const layoutOf = (mod: Loaded) =>
  defineStarlightLayout(mod.starlight as never, mod.config as never);

/** An `astro.config.mjs` whose `starlight()` call has `options` as its option text. */
const astro = (options: string, top = "") => `import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  ${top}integrations: [
    starlight({
      title: "Docs",
      ${options}
    }),
  ],
});
`;

const ok = (
  locales: Array<{ key: string; lang: string; label: string | null }> | null,
  defaultLocale: string | null = null,
): AstroConfigRead => ({ ok: true, file: "astro.config.mjs", docsDir: "src/content/docs", locales, defaultLocale });

describe("mogging init --starlight", () => {
  test("a root-locale site gets a config that loads and validates", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", ASTRO_ROOT_DE_ZH);
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight"], t.deps)).toBe(0);

      const file = join(dir, "mogging.config.ts");
      const mod = await load(file);
      expect(mod.config.locales).toEqual({ source: "en", chains: { de: ["en"], "zh-CN": ["en"] } });
      expect(layoutOf(mod).localeDirs).toEqual({ de: "de", "zh-CN": "zh-cn" });
      expect(layoutOf(mod).sourceDir).toBeNull();
      expect(t.base.stdout()).toContain(`created ${file}`);
    });
  });

  test("an own-folder site (defaultLocale en) gets sourceDir en", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", astro(
        `defaultLocale: "en",
      locales: {
        en: { label: "English", lang: "en" },
        de: { label: "Deutsch", lang: "de" },
      },`,
      ));
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--json"], t.deps)).toBe(0);

      const mod = await load(join(dir, "mogging.config.ts"));
      expect(mod.config.locales).toEqual({ source: "en", chains: { de: ["en"] } });
      expect(layoutOf(mod).sourceDir).toBe("en");
      expect(layoutOf(mod).localeDirs).toEqual({ de: "de" });
      const doc = JSON.parse(t.base.stdout()) as { data: { starlight: unknown } };
      expect(doc.data.starlight).toEqual({
        source: "en", targets: [{ tag: "de", dir: "de" }], sourceDir: "en", docsDir: "src/content/docs",
        pasteBlock: null,
      });
    });
  });

  test("the folder map is read, not derived", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", astro(
        `locales: {
        root: { label: "English", lang: "en" },
        "zh-cn": { label: "简体中文", lang: "zh-Hans-CN" },
      },`,
        `srcDir: "./site",\n  `,
      ));
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight"], t.deps)).toBe(0);

      const file = join(dir, "mogging.config.ts");
      const mod = await load(file);
      expect(layoutOf(mod).localeDirs).toEqual({ "zh-Hans-CN": "zh-cn" });
      expect(mod.config.locales.chains).toEqual({ "zh-Hans-CN": ["en"] });
      expect(readFileSync(file, "utf8")).toContain('docsDir: "site/content/docs"');
    });
  });

  test("a bad --locales tag is exit 2", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", astro(""));
      const connect = vi.fn(() => connectionOver(sql));
      const t = realLoader(sql, dir, { connect });
      expect(await run(["init", "--starlight", "--locales", "de,not_a_tag"], t.deps)).toBe(2);
      expect(t.base.stderr()).toContain("init --starlight: --locales: ");
      expect(t.base.stderr()).toContain("not_a_tag");
      expect(readdirSync(dir)).toEqual(["astro.config.mjs"]);
      expect(connect).not.toHaveBeenCalled();
    });
  });

  test("a bad --source-locale tag is exit 2", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", astro(""));
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--locales", "de", "--source-locale", "x"], t.deps)).toBe(2);
      expect(t.base.stderr()).toContain("init --starlight: --source-locale: ");
      expect(readdirSync(dir)).toEqual(["astro.config.mjs"]);
    });
  });

  test("a single-language site needs --locales and gets the block to add", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", astro(""));
      const without = realLoader(sql, dir);
      expect(await run(["init", "--starlight"], without.deps)).toBe(2);
      expect(without.base.stderr()).toContain(
        "init --starlight: this site has one language; pass --locales de,fr (the languages to add)",
      );
      expect(readdirSync(dir)).toEqual(["astro.config.mjs"]);

      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--locales", "de", "--json"], t.deps)).toBe(0);
      const stderr = t.base.stderr();
      expect(stderr).toContain("add this to the starlight() options in astro.config:");
      expect(stderr).toContain('"de": { label: "Deutsch", lang: "de" },');
      const doc = JSON.parse(t.base.stdout()) as { data: { starlight: { pasteBlock: string; source: string } } };
      const block = doc.data.starlight.pasteBlock;
      expect(block).toBe(
        [
          "add this to the starlight() options in astro.config:",
          "    locales: {",
          '      root: { label: "English", lang: "en" },',
          '      "de": { label: "Deutsch", lang: "de" },',
          "    },",
        ].join("\n"),
      );
      expect(stderr).toContain(`${block}\n`);
      expect(doc.data.starlight.source).toBe("en");
      const mod = await load(join(dir, "mogging.config.ts"));
      expect(mod.config.locales).toEqual({ source: "en", chains: { de: ["en"] } });
    });
  });

  test("--source-locale names the source of a site without locales", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", astro(""));
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--locales", "en,zh-CN", "--source-locale", "fr"], t.deps)).toBe(0);
      const mod = await load(join(dir, "mogging.config.ts"));
      expect(mod.config.locales).toEqual({ source: "fr", chains: { en: ["fr"], "zh-CN": ["fr"] } });
      expect(layoutOf(mod).localeDirs).toEqual({ en: "en", "zh-CN": "zh-cn" });
      expect(t.base.stderr()).toContain('root: { label: "français", lang: "fr" },');
    });
  });

  test("a locales block with only the default language keeps its source", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", astro(`locales: { root: { label: "Français", lang: "fr" } },`));
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--locales", "de", "--json"], t.deps)).toBe(0);
      const doc = JSON.parse(t.base.stdout()) as {
        data: { starlight: { source: string; sourceDir: string | null; pasteBlock: string } };
      };
      expect(doc.data.starlight.source).toBe("fr");
      expect(doc.data.starlight.sourceDir).toBeNull();
      expect(t.base.stderr()).toContain("replace the locales block of the starlight() options in astro.config with:");
      const lines = doc.data.starlight.pasteBlock.split("\n");
      expect(lines[0]).toBe("replace the locales block of the starlight() options in astro.config with:");
      expect(lines[1]).toBe("    locales: {");
      expect(lines[2]).toBe('      root: { label: "Français", lang: "fr" },');
      expect(lines[3]).toBe('      "de": { label: "Deutsch", lang: "de" },');
      expect(lines[4]).toBe("    },");
    });

    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", astro(`defaultLocale: "en",\n      locales: { en: { lang: "en" } },`));
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--locales", "de", "--json"], t.deps)).toBe(0);
      const doc = JSON.parse(t.base.stdout()) as {
        data: { starlight: { source: string; sourceDir: string | null; pasteBlock: string } };
      };
      expect(doc.data.starlight.source).toBe("en");
      expect(doc.data.starlight.sourceDir).toBe("en");
      expect(doc.data.starlight.pasteBlock.split("\n")[2]).toBe('      "en": { label: "English", lang: "en" },');
      const mod = await load(join(dir, "mogging.config.ts"));
      expect(layoutOf(mod).sourceDir).toBe("en");
    });

    await withTestDb(async (sql) => {
      for (const options of [
        `locales: { root: { label: "Français", lang: "fr" } },`,
        `defaultLocale: "en",\n      locales: { en: { lang: "en" } },`,
      ]) {
        const dir = tempDir();
        write(dir, "astro.config.mjs", astro(options));
        const t = realLoader(sql, dir);
        expect(
          await run(["init", "--starlight", "--locales", "de", "--source-locale", "fr"], t.deps),
        ).toBe(2);
        expect(t.base.stderr()).toContain(
          "init --starlight: astro.config declares Starlight's locales; drop --locales and --source-locale",
        );
        expect(readdirSync(dir)).toEqual(["astro.config.mjs"]);
      }
    });
  });

  // The brief asked for a real-loader run from an os.tmpdir() folder, expecting `@mogging/starlight` not to resolve.
  // It does resolve: `createJiti(import.meta.url)` (run.ts) falls back to the CLI's own node_modules for a bare import
  // (measured: a config in the scratchpad loaded fine), so the loader is injected here and fails as Node's would.
  test("a config that does not load is removed again", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir(tmpdir());
      write(dir, "astro.config.mjs", ASTRO_ROOT_DE_ZH);
      const connect = vi.fn(() => connectionOver(sql));
      const loadModule = vi.fn(async (_path: string): Promise<Record<string, unknown>> => {
        throw new Error("Cannot find package '@mogging/starlight' imported from the config");
      });
      const t = testDeps(sql, { cwd: dir, connect, loadModule });
      expect(await run(["init", "--starlight"], t)).toBe(2);
      expect(t.stderr()).toContain(
        "init --starlight: the written config does not load (Cannot find package '@mogging/starlight' imported from the config); install @mogging/starlight and @mogging/core next to it (npm install -D @mogging/starlight @mogging/core) and run init --starlight again",
      );
      expect(loadModule).toHaveBeenCalledTimes(1);
      expect(loadModule).toHaveBeenCalledWith(join(dir, "mogging.config.ts"));
      expect(existsSync(join(dir, "mogging.config.ts"))).toBe(false);
      expect(readdirSync(dir)).toEqual(["astro.config.mjs"]);
      expect(connect).not.toHaveBeenCalled();
    });
  });

  test("a written config whose starlight export is invalid is removed again", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir(tmpdir());
      write(dir, "astro.config.mjs", ASTRO_ROOT_DE_ZH);
      const loadModule = async () => ({
        config: { collections: [], locales: { source: "en" } },
        starlight: { collection: "docs", passthrough: "extra" },
      });
      const t = testDeps(sql, { cwd: dir, loadModule });
      expect(await run(["init", "--starlight"], t)).toBe(2);
      expect(t.stderr()).toContain("the written config does not load (");
      expect(existsSync(join(dir, "mogging.config.ts"))).toBe(false);
    });
  });

  test("a failed delete of the written config never replaces the usage error", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir(tmpdir());
      write(dir, "astro.config.mjs", ASTRO_ROOT_DE_ZH);
      const loadModule = async (path: string): Promise<Record<string, unknown>> => {
        rmSync(path); // so the delete that follows fails with ENOENT
        throw new Error("boom");
      };
      const t = testDeps(sql, { cwd: dir, loadModule });
      expect(await run(["init", "--starlight"], t)).toBe(2);
      expect(t.stderr()).toContain("the written config does not load (boom)");
    });
  });

  test("the warnings survive a failed migration", async () => {
    const dir = tempDir();
    write(dir, "astro.config.mjs", astro(""));
    write(dir, "node_modules/@astrojs/starlight/package.json", JSON.stringify({ version: "0.44.1" }));
    const failing = Object.assign(() => Promise.reject(new Error("db down")), { end: async () => {} }) as unknown as Sql;
    const base = testDeps(failing, { cwd: dir, env: { DATABASE_URL: "postgres://x/y" } });
    const { loadModule: _stub, ...deps } = base;
    void _stub;
    expect(await run(["init", "--starlight", "--locales", "de"], { ...deps, connect: () => failing })).toBe(1);
    const stderr = base.stderr();
    expect(stderr).toContain("add this to the starlight() options in astro.config:");
    expect(stderr).toContain("warning: @astrojs/starlight 0.44.1 is outside the range @mogging/starlight supports (>=0.43.0 <0.44.0)");
    expect(stderr).toContain("db down");
  });

  test("an unreadable astro.config needs --locales", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", astro("locales: someLocales,"));
      const without = realLoader(sql, dir);
      expect(await run(["init", "--starlight"], without.deps)).toBe(2);
      expect(without.base.stderr()).toMatch(
        /init --starlight: astro\.config could not be read statically \(.+\); pass --locales de,fr and, if the site's default language is not English, --source-locale <tag>/,
      );
      expect(readdirSync(dir)).toEqual(["astro.config.mjs"]);

      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--locales", "de", "--json"], t.deps)).toBe(0);
      expect(t.base.stderr()).toMatch(
        /warning: astro\.config could not be read statically \(.+\); the locales come from --locales\n/,
      );
      const doc = JSON.parse(t.base.stdout()) as { data: { starlight: { pasteBlock: string | null; docsDir: string } } };
      expect(doc.data.starlight.pasteBlock).toBeNull();
      expect(doc.data.starlight.docsDir).toBe("src/content/docs");
      expect(t.base.stderr()).not.toContain("add this to the starlight()");
    });
  });

  test("a project with no astro.config is read as unreadable", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--locales", "de"], t.deps)).toBe(0);
      expect(t.base.stderr()).toContain("warning: astro.config could not be read statically (no astro.config file)");
    });
  });

  test("--locales next to readable locales is exit 2", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", ASTRO_ROOT_DE_ZH);
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--locales", "fr"], t.deps)).toBe(2);
      expect(t.base.stderr()).toContain(
        "init --starlight: astro.config declares Starlight's locales; drop --locales and --source-locale (or edit astro.config)",
      );
      expect(readdirSync(dir)).toEqual(["astro.config.mjs"]);
    });
  });

  test("--locales or --source-locale without --starlight is exit 2", async () => {
    await withTestDb(async (sql) => {
      for (const [flag, value] of [["--locales", "de"], ["--source-locale", "en"]] as const) {
        const dir = tempDir();
        const connect = vi.fn(() => connectionOver(sql));
        const t = realLoader(sql, dir, { connect });
        expect(await run(["init", flag, value], t.deps)).toBe(2);
        expect(t.base.stderr()).toContain(`init: ${flag} needs --starlight`);
        expect(readdirSync(dir)).toEqual([]);
        expect(connect).not.toHaveBeenCalled();
      }
    });
  });

  test("no database URL is exit 2 before any file is written", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", ASTRO_ROOT_DE_ZH);
      const t = realLoader(sql, dir, { env: {} });
      expect(await run(["init", "--starlight"], t.deps)).toBe(2);
      expect(t.base.stderr()).toContain("no database URL: set DATABASE_URL");
      expect(readdirSync(dir)).toEqual(["astro.config.mjs"]);
    });
  });

  test("an existing config is left unchanged and says --starlight wrote nothing", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      write(dir, "astro.config.mjs", ASTRO_ROOT_DE_ZH);
      const file = join(dir, "mogging.config.ts");
      const original = Buffer.from('export const config = { collections: [], locales: { source: "en" } };\r\n// héllo', "utf8");
      writeFileSync(file, original);

      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight"], t.deps)).toBe(0);
      expect(Buffer.compare(readFileSync(file), original)).toBe(0);
      expect(t.base.stdout()).toContain(`${file} already exists: left unchanged; --starlight wrote nothing`);
      const [row] = await sql`select to_regclass('migrations') as t`;
      expect(row!.t).not.toBeNull();

      const j = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--json"], j.deps)).toBe(0);
      const doc = JSON.parse(j.base.stdout()) as { data: { configCreated: boolean; starlight: unknown } };
      expect(doc.data.configCreated).toBe(false);
      expect(doc.data.starlight).toBeNull();
    });
  });

  test("--config reads astro.config from the folder of the config file", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      const site = join(dir, "site");
      write(site, "astro.config.mjs", ASTRO_ROOT_DE_ZH);
      const t = realLoader(sql, dir);
      expect(await run(["init", "--starlight", "--config", "site/mogging.config.ts"], t.deps)).toBe(0);
      const mod = await load(join(site, "mogging.config.ts"));
      expect(mod.config.locales.chains).toEqual({ de: ["en"], "zh-CN": ["en"] });
    });
  });
});

describe("starlightAnswers", () => {
  const de = { key: "de", lang: "de", label: null };
  const root = { key: "root", lang: "en", label: null };

  test("a multilingual site with defaultLocale as its own folder", () => {
    const a = starlightAnswers(ok([{ key: "en", lang: "en", label: null }, de, { key: "zh-cn", lang: "zh-CN", label: null }], "en"), {});
    expect(a).toEqual({
      source: "en", sourceDir: "en", docsDir: "src/content/docs", pasteBlock: null, warnings: [],
      targets: [{ tag: "de", dir: "de" }, { tag: "zh-CN", dir: "zh-cn" }],
    });
  });

  test("locales without a root locale and without defaultLocale is a usage error", () => {
    expect(() => starlightAnswers(ok([de, { key: "fr", lang: "fr", label: null }]), {})).toThrow(
      "init --starlight: astro.config has locales but neither a root locale nor defaultLocale",
    );
  });

  test("a defaultLocale that is not a key, or next to a root key, is a usage error", () => {
    expect(() => starlightAnswers(ok([root, de], "fr"), {})).toThrow(/^init --starlight: .*"fr"/);
    expect(() => starlightAnswers(ok([root, de, { key: "fr", lang: "fr", label: null }], "fr"), {})).toThrow(
      /^init --starlight: .*"fr"/,
    );
  });

  test("a duplicate target, a duplicate folder and a target equal to the source are usage errors naming it", () => {
    const flags = { sourceLocale: undefined };
    expect(() => starlightAnswers(ok(null), { ...flags, locales: "de,de" })).toThrow(/init --starlight: .*"de"/);
    expect(() => starlightAnswers(ok(null), { ...flags, locales: "en" })).toThrow(/init --starlight: .*"en".*source/);
    expect(() => starlightAnswers(ok([root, { key: "a", lang: "de", label: null }, { key: "b", lang: "de", label: null }]), {})).toThrow(
      /init --starlight: .*"de"/,
    );
    expect(() => starlightAnswers(ok([root, { key: "a", lang: "de", label: null }, { key: "b", lang: "en", label: null }]), {})).toThrow(
      /init --starlight: .*"en".*source/,
    );
  });

  test("an unreadable astro.config without --locales names the reason", () => {
    expect(() => starlightAnswers({ ok: false, file: null, reason: "no astro.config file" }, {})).toThrow(
      "init --starlight: astro.config could not be read statically (no astro.config file); pass --locales de,fr and, if the site's default language is not English, --source-locale <tag>",
    );
  });
});

describe("starlightConfigText", () => {
  test("is exactly the documented text, with the commented AI block of the plain template", () => {
    const answers = starlightAnswers(
      ok([
        { key: "root", lang: "en", label: "English" },
        { key: "de", lang: "de", label: "Deutsch" },
        { key: "zh-cn", lang: "zh-CN", label: null },
      ]),
      {},
    );
    const ai = CONFIG_TEMPLATE.slice(CONFIG_TEMPLATE.indexOf("// AI translation (optional)."));
    expect(ai.startsWith("// AI translation (optional). Uncomment")).toBe(true);
    expect(starlightConfigText(answers)).toBe(`import { defineConfig } from "@mogging/core";
import { starlightPreset } from "@mogging/starlight/preset";

// The Starlight docs collection and its layout (folders, locale folders, front-matter mapping).
const docs = starlightPreset({
  docsDir: "src/content/docs",
  sourceDir: null,
  localeDirs: { "de": "de", "zh-CN": "zh-cn" },
});

export const config = defineConfig({
  collections: [docs.collection],
  locales: { source: "en", chains: { "de": ["en"], "zh-CN": ["en"] } },
});

// Read by the mogging CLI: where the docs live and how front matter maps to fields.
export const starlight = docs.layout;

${ai}`);
  });
});

describe("starlightVersionWarning", () => {
  const withStarlight = (dir: string, version: string) =>
    write(dir, "node_modules/@astrojs/starlight/package.json", JSON.stringify({ name: "@astrojs/starlight", version }));

  test("a version outside the range, a missing install, a good one and a hoisted one", () => {
    const outside = tempDir(tmpdir());
    withStarlight(outside, "0.44.1");
    expect(starlightVersionWarning(outside)).toBe(
      "@astrojs/starlight 0.44.1 is outside the range @mogging/starlight supports (>=0.43.0 <0.44.0)",
    );

    const missing = tempDir(tmpdir());
    expect(starlightVersionWarning(missing)).toBe(
      `@astrojs/starlight is not installed in ${missing}; install it before building the site`,
    );

    const good = tempDir(tmpdir());
    withStarlight(good, "0.43.2");
    expect(starlightVersionWarning(good)).toBeNull();

    const parent = tempDir(tmpdir());
    withStarlight(parent, "0.43.2");
    const child = join(parent, "packages", "site");
    mkdirSync(child, { recursive: true });
    expect(starlightVersionWarning(child)).toBeNull();
  });

  test("the edges of the range and an unparsable version", () => {
    for (const [version, warned] of [
      ["0.43.0", false], ["0.42.9", true], ["0.43.99", false], ["0.44.0", true], ["1.0.0", true],
      ["next", true], ["", true],
    ] as const) {
      const dir = tempDir(tmpdir());
      withStarlight(dir, version);
      expect(starlightVersionWarning(dir) !== null, version).toBe(warned);
    }
    const bad = tempDir(tmpdir());
    write(bad, "node_modules/@astrojs/starlight/package.json", "not json");
    expect(starlightVersionWarning(bad)).toMatch(/is outside the range/);
  });

  test("STARLIGHT_RANGE matches the package's peer range", () => {
    const pkg = JSON.parse(readFileSync(join(CLI_DIR, "..", "starlight", "package.json"), "utf8")) as {
      peerDependencies: Record<string, string>;
    };
    expect(pkg.peerDependencies["@astrojs/starlight"]).toBe(`>=${STARLIGHT_RANGE.min} <${STARLIGHT_RANGE.below}`);
  });
});
