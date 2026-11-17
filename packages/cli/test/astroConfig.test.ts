import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { defineStarlightLayout } from "@mogging/markdown";
import {
  astroConfigWarnings, localeDrift, readAstroConfig, starlightLocaleDirs,
} from "../src/starlight/astroConfig.js";
import type { AstroConfigRead } from "../src/starlight/astroConfig.js";
import { ASTRO_ROOT_DE_ZH, starlightConfig, starlightDocs, starlightProject } from "./starlightFixtures.js";

type Ok = Extract<AstroConfigRead, { ok: true }>;

const ASTRO_SRC = fileURLToPath(new URL("../src/starlight/astroConfig.ts", import.meta.url));
const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));

/** An `astro.config.mjs` over a `starlight({ <options> })` call; `prelude` is extra module text, `top` extra config keys. */
const config = (options: string, { prelude = "", top = "", imp = "starlight" } = {}): string => `import { defineConfig } from "astro/config";
import ${imp} from "@astrojs/starlight";
${prelude}
export default defineConfig({
${top}  integrations: [${imp}({ title: "Docs", ${options} })],
});
`;

const LOCALES = `locales: { root: { label: "English", lang: "en" }, de: { label: "Deutsch", lang: "de" }, "zh-cn": { label: "x", lang: "zh-CN" } }`;

/** Writes `files` into a fresh project and reads its astro config. */
const read = (files: Record<string, string>): AstroConfigRead => readAstroConfig(starlightProject(files));

/** A read of one `astro.config.mjs` text. */
const readMjs = (text: string): AstroConfigRead => read({ "astro.config.mjs": text });

const ok = (r: AstroConfigRead): Ok => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r;
};

const layoutWith = (over: Record<string, unknown> = {}) =>
  defineStarlightLayout({ ...starlightDocs.layout, ...over }, starlightConfig);

describe("readAstroConfig", () => {
  test("reads locales, defaultLocale and the docs folder from a plain astro.config.mjs", () => {
    const root = starlightProject({ "astro.config.mjs": ASTRO_ROOT_DE_ZH });
    expect(readAstroConfig(root)).toEqual({
      ok: true,
      file: join(root, "astro.config.mjs"),
      docsDir: "src/content/docs",
      defaultLocale: null,
      locales: [
        { key: "root", lang: "en", label: "English" },
        { key: "de", lang: "de", label: "Deutsch" },
        { key: "zh-cn", lang: "zh-CN", label: "简体中文" },
      ],
    });
  });

  test("lang defaults to the key", () => {
    const r = ok(readMjs(config(`locales: { root: { label: "English", lang: "en" }, de: { label: "Deutsch" } }`)));
    expect(r.locales?.[1]).toMatchObject({ key: "de", lang: "de" });
  });

  test("srcDir moves the docs folder", () => {
    expect(readMjs(config("", { top: `  srcDir: "./site/",\n` }))).toMatchObject({ ok: true, docsDir: "site/content/docs" });
    expect(readMjs(config("", { top: `  srcDir: "src",\n` }))).toMatchObject({ ok: true, docsDir: "src/content/docs" });
  });

  test("a renamed starlight import is found", () => {
    const text = config(LOCALES, { imp: "sl" });
    expect(readMjs(text)).toMatchObject({ ok: true, locales: [{ key: "root" }, { key: "de" }, { key: "zh-cn" }] });
  });

  test("a TypeScript config with annotations is read and prints nothing", () => {
    const text = `const title: string = "Docs";\n${config(LOCALES).replace('title: "Docs"', "title")}`;
    const root = starlightProject({ "astro.config.ts": text });
    // in-process: the read works, and process.emitWarning is the original function afterwards
    const before = process.emitWarning;
    expect(readAstroConfig(root)).toMatchObject({ ok: true, locales: [{ key: "root" }, { key: "de" }, { key: "zh-cn" }] });
    expect(process.emitWarning).toBe(before);
    // fresh process (Node warns once per process): nothing reaches stderr
    const script = `const { readAstroConfig } = await import(${JSON.stringify(pathToFileURL(ASTRO_SRC).href)});
const r = readAstroConfig(${JSON.stringify(root)}); process.stdout.write(JSON.stringify(r));`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: CLI_DIR, encoding: "utf8" });
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toMatchObject({ ok: true, locales: [{ key: "root" }, { key: "de" }, { key: "zh-cn" }] });
  });

  test("the child-process probe can see the warning (control: Node's own call, unsuppressed)", () => {
    const script = `import { stripTypeScriptTypes } from "node:module"; stripTypeScriptTypes("const a: string = 'x';");`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: CLI_DIR, encoding: "utf8" });
    expect(child.stderr).toContain("ExperimentalWarning");
  });

  test("Astro's file order: .mjs wins over .ts", () => {
    const ts = config(`locales: { root: { label: "E", lang: "en" }, fr: { label: "F" } }`);
    const r = ok(read({ "astro.config.ts": ts, "astro.config.mjs": ASTRO_ROOT_DE_ZH }));
    expect(r.file.endsWith("astro.config.mjs")).toBe(true);
    expect(r.locales?.map((l) => l.key)).toEqual(["root", "de", "zh-cn"]);
  });

  test("a single-language site has locales null", () => {
    expect(readMjs(config(""))).toMatchObject({ ok: true, locales: null, defaultLocale: null });
  });

  test("defaultLocale is read when it is a string literal", () => {
    const text = config(`defaultLocale: "en", locales: { en: { label: "English" }, de: { label: "Deutsch" } }`);
    expect(readMjs(text)).toMatchObject({ ok: true, defaultLocale: "en" });
  });

  describe("cannot be read statically", () => {
    const cases: Array<[string, string, string]> = [
      ["a syntax error", "export default defineConfig({", "could not be parsed"],
      ["an imported locales constant", config("locales: LOCALES", { prelude: `import { LOCALES } from "./l.mjs";` }), "locales is not a literal object"],
      ["a spread in locales", config("locales: { ...more }"), "locales is not a literal object"],
      ["a computed locale key", config("locales: { [k]: {} }"), "locales is not a literal object"],
      ["an identifier defaultLocale", config(`defaultLocale: DEFAULT, locales: { en: {} }`), "defaultLocale is not a string literal"],
      ["a template lang with an expression", config("locales: { de: { lang: `${x}` } }"), "locales is not a literal object"],
      ["no starlight call", `import starlight from "@astrojs/starlight";\nexport default { integrations: [] };\n`, "no starlight() call in integrations"],
      ["no starlight import", `export default { integrations: [] };\n`, "no import of @astrojs/starlight"],
      ["export default of a call", `import starlight from "@astrojs/starlight";\nexport default someFunction();\n`, "export default is not defineConfig({...}) or an object literal"],
      ["a variable srcDir", config("", { top: "  srcDir: dir,\n" }), "srcDir is not a string literal"],
      ["a spread in the starlight options", config("...shared"), "starlight options holds a spread, computed or duplicate key"],
      ["a spread in the config", `import { defineConfig } from "astro/config";\nimport starlight from "@astrojs/starlight";\nexport default defineConfig({ ...base, integrations: [starlight({})] });\n`, "config holds a spread, computed or duplicate key"],
      ["a spread in one locale", config("locales: { de: { ...l } }"), "locale de holds a spread, computed or duplicate key"],
      ["a __proto__ key in the config", `import { defineConfig } from "astro/config";\nimport starlight from "@astrojs/starlight";\nexport default defineConfig({ __proto__: base, integrations: [starlight({})] });\n`, "config holds a spread, computed or duplicate key"],
      ["a __proto__ key in the starlight options", config(`__proto__: shared`), "starlight options holds a spread, computed or duplicate key"],
      ["a string-literal __proto__ key in the starlight options", config(`"__proto__": shared`), "starlight options holds a spread, computed or duplicate key"],
      ["a __proto__ key in one locale", config(`locales: { de: { __proto__: l, lang: "de" } }`), "locale de holds a spread, computed or duplicate key"],
      ["duplicate starlight options keys", config("locales: {}, locales: {}"), "starlight options holds a spread, computed or duplicate key"],
      ["a root locale without lang", config(`locales: { root: { label: "English" } }`), "the root locale has no lang"],
    ];
    test.each(cases)("%s", (_name, text, reason) => {
      expect(readMjs(text)).toMatchObject({ ok: false, reason });
    });

    test("no file: file is null", () => {
      expect(read({})).toEqual({ ok: false, file: null, reason: "no astro.config file" });
    });

    test("an unreadable config reports its file", () => {
      const root = starlightProject({ "astro.config.mjs": "export default defineConfig({" });
      expect(readAstroConfig(root)).toEqual({ ok: false, file: join(root, "astro.config.mjs"), reason: "could not be parsed" });
    });

    test("a TypeScript syntax error stays unreadable", () => {
      expect(read({ "astro.config.ts": "const a: = ;\nexport default {};\n" })).toMatchObject({ ok: false, reason: "could not be parsed" });
    });

    test("the earlier step's reason wins when a config has two problems", () => {
      const text = config("locales: LOCALES", { top: "  srcDir: dir,\n" });
      expect(readMjs(text)).toMatchObject({ ok: false, reason: "srcDir is not a string literal" });
    });

    test("it never throws: a config path that is not readable is reported", () => {
      expect(readAstroConfig("/nonexistent/mogging-root")).toEqual({ ok: false, file: null, reason: "no astro.config file" });
    });
  });

  test("labels are read when literal", () => {
    expect(ok(readMjs(ASTRO_ROOT_DE_ZH)).locales?.map((l) => l.label)).toEqual(["English", "Deutsch", "简体中文"]);
    const text = config(`locales: { root: { label: ENGLISH, lang: "en" }, de: { label: "Deutsch" } }`);
    const r = ok(readMjs(text));
    expect(r.locales?.map((l) => l.label)).toEqual([null, "Deutsch"]);
  });
});

describe("starlightLocaleDirs", () => {
  test("root mode gives the folder locales; an own-folder default is left out", () => {
    expect(starlightLocaleDirs(ok(readMjs(ASTRO_ROOT_DE_ZH)))).toEqual(["de", "zh-cn"]);
    const own = config(`defaultLocale: "en", locales: { en: { label: "English" }, de: { label: "Deutsch" } }`);
    expect(starlightLocaleDirs(ok(readMjs(own)))).toEqual(["de"]);
    expect(starlightLocaleDirs(ok(readMjs(config(""))))).toEqual([]);
  });
});

describe("localeDrift", () => {
  const cfg = (keys: string[], extra = "") =>
    ok(readMjs(config(`${extra}locales: { ${keys.map((k) => (k === "root" ? `root: { label: "E", lang: "en" }` : `"${k}": { label: "${k}" }`)).join(", ")} }`)));

  test("names each mismatch, in order", () => {
    expect(localeDrift(cfg(["root", "de", "fr"]), layoutWith())).toEqual([
      `locale "zh-CN" (folder zh-cn) is not in Starlight's locales`,
      `Starlight locale folder "fr" is not a Mogging locale (add it to mogging.config.ts or to otherLocaleDirs)`,
    ]);
    expect(localeDrift(cfg(["root", "de", "fr"]), layoutWith({ otherLocaleDirs: ["fr"] }))).toEqual([
      `locale "zh-CN" (folder zh-cn) is not in Starlight's locales`,
    ]);
  });

  test("a matching config gives no drift", () => {
    expect(localeDrift(ok(readMjs(ASTRO_ROOT_DE_ZH)), layoutWith())).toEqual([]);
  });

  test("own-folder Starlight against a root-mode layout names the source side", () => {
    const own = cfg(["en", "de", "zh-cn"], `defaultLocale: "en", `);
    expect(localeDrift(own, layoutWith())).toEqual([`the source folder differs: Mogging (root), Starlight en`]);
  });

  test("a root-mode Starlight against an own-folder layout names the source side", () => {
    expect(localeDrift(ok(readMjs(ASTRO_ROOT_DE_ZH)), layoutWith({ sourceDir: "en" }))).toEqual([
      `the source folder differs: Mogging en, Starlight root`,
    ]);
  });

  test("an own-folder layout matching defaultLocale has no source drift", () => {
    const own = cfg(["en", "de", "zh-cn"], `defaultLocale: "en", `);
    expect(localeDrift(own, layoutWith({ sourceDir: "en" }))).toEqual([]);
  });
});

describe("astroConfigWarnings", () => {
  test("one warning when unreadable", () => {
    const root = starlightProject({ "astro.config.mjs": config("locales: LOCALES") });
    expect(astroConfigWarnings(root, layoutWith())).toEqual({
      localeDirs: null,
      warnings: [{
        file: "astro.config",
        message: "could not be read statically (locales is not a literal object); the Starlight locale check was skipped",
      }],
    });
  });

  test("a missing file is one warning too", () => {
    const r = astroConfigWarnings(starlightProject({}), layoutWith());
    expect(r.localeDirs).toBeNull();
    expect(r.warnings).toEqual([{
      file: "astro.config",
      message: "could not be read statically (no astro.config file); the Starlight locale check was skipped",
    }]);
  });

  test("a readable config gives the folders and one warning per drift message", () => {
    const root = starlightProject({ "astro.config.mjs": config(`locales: { root: { label: "E", lang: "en" }, de: {}, fr: {} }`) });
    expect(astroConfigWarnings(root, layoutWith())).toEqual({
      localeDirs: ["de", "fr"],
      warnings: [
        { file: "astro.config.mjs", message: `locale "zh-CN" (folder zh-cn) is not in Starlight's locales` },
        { file: "astro.config.mjs", message: `Starlight locale folder "fr" is not a Mogging locale (add it to mogging.config.ts or to otherLocaleDirs)` },
      ],
    });
  });

  test("a matching config gives no warnings", () => {
    const root = starlightProject({ "astro.config.mjs": ASTRO_ROOT_DE_ZH });
    expect(astroConfigWarnings(root, layoutWith())).toEqual({ localeDirs: ["de", "zh-cn"], warnings: [] });
  });
});
