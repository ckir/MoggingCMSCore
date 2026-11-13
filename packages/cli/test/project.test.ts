import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Sql } from "postgres";
import { loadProject, resolveActor, resolveDatabaseUrl } from "../src/project.js";
import { run } from "../src/run.js";
import { UsageError } from "../src/types.js";
import type { CommandSpec, Deps } from "../src/types.js";
import { withTestDb } from "./db.js";
import { testDeps } from "./fixtures.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mogging-cli-project-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("resolveActor", () => {
  test("order: flag, MOGGING_ACTOR, OS user, cli", () => {
    expect(resolveActor({ actor: "flag" }, { MOGGING_ACTOR: "env" }, "os")).toBe("flag");
    expect(resolveActor({}, { MOGGING_ACTOR: "env" }, "os")).toBe("env");
    expect(resolveActor({}, {}, "os")).toBe("os");
    expect(resolveActor({}, {}, undefined)).toBe("cli");
  });

  test("an empty string falls through at every step", () => {
    expect(resolveActor({ actor: "" }, { MOGGING_ACTOR: "env" }, "os")).toBe("env");
    expect(resolveActor({}, { MOGGING_ACTOR: "" }, "os")).toBe("os");
    expect(resolveActor({}, { MOGGING_ACTOR: "" }, "")).toBe("cli");
    expect(resolveActor({ actor: "" }, { MOGGING_ACTOR: "  " }, undefined)).toBe("cli");
  });
});

describe("resolveDatabaseUrl", () => {
  test("order: --database-url, MOGGING_DATABASE_URL, DATABASE_URL", () => {
    const env = { MOGGING_DATABASE_URL: "m", DATABASE_URL: "d" };
    expect(resolveDatabaseUrl({ "database-url": "f" }, env)).toBe("f");
    expect(resolveDatabaseUrl({}, env)).toBe("m");
    expect(resolveDatabaseUrl({}, { DATABASE_URL: "d" })).toBe("d");
    expect(resolveDatabaseUrl({ "database-url": "" }, { DATABASE_URL: "d" })).toBe("d");
  });

  test("none set is a UsageError", () => {
    expect(() => resolveDatabaseUrl({}, {})).toThrow(UsageError);
    expect(() => resolveDatabaseUrl({}, {})).toThrow("no database URL: set DATABASE_URL");
  });
});

/** Deps whose connect and loadModule record what they were given; `end` is the project's only effect. */
function recording(cwd: string, mod: Record<string, unknown> | Error, env: Deps["env"] = { DATABASE_URL: "postgres://u:p@h/d" }) {
  const loaded: string[] = [];
  const ended = vi.fn(async () => {});
  const connected: string[] = [];
  const deps = {
    cwd,
    env,
    loadModule: async (p: string) => {
      loaded.push(p);
      if (mod instanceof Error) throw mod;
      return mod;
    },
    connect: (url: string) => {
      connected.push(url);
      return { end: ended } as unknown as Sql;
    },
  } as unknown as Deps;
  return { deps, loaded, ended, connected };
}
const goodConfig = { collections: [], locales: { source: "en" } };
const touch = (dir: string, name: string) => writeFileSync(join(dir, name), "");

describe("loadProject: config discovery", () => {
  test("takes the first of .ts, .mts, .js, .mjs that exists, passing loadModule an absolute path", async () => {
    const dir = tempDir();
    touch(dir, "mogging.config.mjs");
    touch(dir, "mogging.config.js");
    const a = recording(dir, { config: goodConfig });
    await loadProject(a.deps, {});
    expect(a.loaded).toEqual([join(dir, "mogging.config.js")]);

    touch(dir, "mogging.config.mts");
    touch(dir, "mogging.config.ts");
    const b = recording(dir, { config: goodConfig });
    await loadProject(b.deps, {});
    expect(b.loaded).toEqual([join(dir, "mogging.config.ts")]);
  });

  test("a dangling symlink counts as present, so its load failure is the error (not a missing-config UsageError)", async () => {
    const dir = tempDir();
    symlinkSync(join(dir, "nowhere.ts"), join(dir, "mogging.config.ts"));
    const loadFailure = new Error("Cannot find module");
    const r = recording(dir, loadFailure);
    await expect(loadProject(r.deps, {})).rejects.toBe(loadFailure);
    expect(r.loaded).toEqual([join(dir, "mogging.config.ts")]);
    expect(r.connected).toEqual([]);
  });

  test("none of the four is a UsageError, and nothing connects", async () => {
    const dir = tempDir();
    const r = recording(dir, { config: goodConfig });
    const err = await loadProject(r.deps, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toBe(
      `no mogging.config.ts|.mts|.js|.mjs in ${dir}: run mogging init or pass --config`,
    );
    expect(r.connected).toEqual([]);
    expect(r.loaded).toEqual([]);
  });

  test("--config overrides discovery and is resolved against deps.cwd, never the process cwd", async () => {
    const dir = tempDir();
    touch(dir, "mogging.config.ts");
    const r = recording(dir, { config: goodConfig });
    await loadProject(r.deps, { config: "sub/other.config.ts" });
    expect(r.loaded).toEqual([resolve(dir, "sub/other.config.ts")]);

    const abs = recording(dir, { config: goodConfig });
    await loadProject(abs.deps, { config: join(tempDir(), "x.ts") });
    expect(abs.loaded[0]).toMatch(/x\.ts$/);
  });
});

describe("loadProject: the module", () => {
  test("a missing config export is a UsageError naming the file and the export; nothing connects", async () => {
    const dir = tempDir();
    touch(dir, "mogging.config.ts");
    const r = recording(dir, { somethingElse: 1 });
    const err = await loadProject(r.deps, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain(join(dir, "mogging.config.ts"));
    expect((err as Error).message).toContain("config");
    expect(r.connected).toEqual([]);
  });

  test.each([
    ["no collections", { locales: { source: "en" } }],
    ["collections not an array", { collections: {}, locales: { source: "en" } }],
    ["no locales", { collections: [] }],
    ["locales.source not a string", { collections: [], locales: { source: 1 } }],
    ["config not an object", "nope"],
  ])("an invalid config export (%s) is a UsageError and nothing connects", async (_name, config) => {
    const dir = tempDir();
    touch(dir, "mogging.config.ts");
    const r = recording(dir, { config });
    await expect(loadProject(r.deps, {})).rejects.toBeInstanceOf(UsageError);
    expect(r.connected).toEqual([]);
  });

  test("no database URL is a UsageError before connecting", async () => {
    const dir = tempDir();
    touch(dir, "mogging.config.ts");
    const r = recording(dir, { config: goodConfig }, {});
    await expect(loadProject(r.deps, {})).rejects.toThrow("no database URL: set DATABASE_URL");
    expect(r.connected).toEqual([]);
  });

  test("builds the project: connects with the resolved URL, carries ai, the config path and the actor", async () => {
    const dir = tempDir();
    touch(dir, "mogging.config.ts");
    const ai = { marker: true };
    const r = recording(dir, { config: goodConfig, ai });
    const p = await loadProject(r.deps, { actor: "bob", "database-url": "postgres://x:y@z/w" });
    expect(r.connected).toEqual(["postgres://x:y@z/w"]);
    expect(p.configPath).toBe(join(dir, "mogging.config.ts"));
    expect(p.ai).toBe(ai);
    expect(p.ctx.config).toBe(goodConfig);
    expect(p.ctx.actor).toBe("bob");
    expect(p.ctx.sql).toBeDefined();
    await p.close();
    expect(r.ended).toHaveBeenCalledTimes(1);
  });

  test("without an ai export project.ai is undefined; the actor is never empty", async () => {
    const dir = tempDir();
    touch(dir, "mogging.config.ts");
    const r = recording(dir, { config: goodConfig });
    const p = await loadProject(r.deps, {});
    expect(p.ai).toBeUndefined();
    expect(p.ctx.actor.length).toBeGreaterThan(0);
  });

  test("the actor chain reads deps.env", async () => {
    const dir = tempDir();
    touch(dir, "mogging.config.ts");
    const r = recording(dir, { config: goodConfig }, { DATABASE_URL: "postgres://u:p@h/d", MOGGING_ACTOR: "envy" });
    expect((await loadProject(r.deps, {})).ctx.actor).toBe("envy");
  });
});

describe("real jiti (run without a loadModule seam)", () => {
  const probe: CommandSpec = {
    name: "probe", summary: "p", usage: "mogging probe", options: {}, project: "full", arity: [0, 0],
    run: async (env) => ({
      data: { config: env.project.ctx.config, ai: env.project.ai, path: env.project.configPath },
      lines: [],
    }),
  };
  /** `testDeps` minus its `loadModule`, so `run` falls back to the real jiti loader. */
  function realLoader(sql: Sql, cwd: string) {
    const base = testDeps(sql, { cwd, commands: [probe] });
    const { loadModule: _stub, ...rest } = base;
    void _stub;
    return { base, deps: rest };
  }

  test("a config that imports a sibling .ts through a .js specifier loads; --config overrides discovery", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      writeFileSync(join(dir, "lib.ts"), 'export const z: string = "zed";\n');
      writeFileSync(
        join(dir, "mogging.config.ts"),
        'import { z } from "./lib.js";\nexport const config = { collections: [z], locales: { source: "en" } };\n',
      );
      mkdirSync(join(dir, "other"));
      writeFileSync(
        join(dir, "other", "alt.config.ts"),
        'export const config = { collections: ["alt"], locales: { source: "de" } };\nexport const ai = { marker: 1 };\n',
      );

      const first = realLoader(sql, dir);
      expect(await run(["probe", "--json"], first.deps)).toBe(0);
      expect(JSON.parse(first.base.stdout()).data).toEqual({
        config: { collections: ["zed"], locales: { source: "en" } }, path: join(dir, "mogging.config.ts"),
      });

      const second = realLoader(sql, dir);
      expect(await run(["probe", "--json", "--config", "other/alt.config.ts"], second.deps)).toBe(0);
      expect(JSON.parse(second.base.stdout()).data).toEqual({
        config: { collections: ["alt"], locales: { source: "de" } }, ai: { marker: 1 },
        path: join(dir, "other", "alt.config.ts"),
      });
    });
  });

  test("a config module without a config export is a UsageError (exit 2) naming the file", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      writeFileSync(join(dir, "mogging.config.ts"), "export const nothing = 1;\n");
      const t = realLoader(sql, dir);
      expect(await run(["probe"], t.deps)).toBe(2);
      expect(t.base.stderr()).toContain(join(dir, "mogging.config.ts"));
    });
  });
});
