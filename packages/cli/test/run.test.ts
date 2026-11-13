import { createRequire } from "node:module";
import { generateKeyPairSync, sign } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Sql } from "postgres";
import { LicenceError, getLicenceState, migrate } from "@mogging/core";
import { run } from "../src/run.js";
import { UsageError } from "../src/types.js";
import type { CommandEnv, CommandResult, CommandSpec, Deps } from "../src/types.js";
import { withTestDb } from "./db.js";
import { config, connectionOver, testDeps } from "./fixtures.js";
import type { TestDeps } from "./fixtures.js";

const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const DAY = 86_400_000;

/** A sql that must never be used: for runs that must not touch the database. */
const NO_DB = new Proxy({}, {
  get: () => {
    throw new Error("the database must not be touched");
  },
}) as unknown as Sql;

const stub = (name: string, over: Partial<CommandSpec> = {}): CommandSpec => ({
  name, summary: `the ${name} stub`, usage: `mogging ${name} [options]`, options: {}, project: "none", arity: [0, 0],
  run: async () => ({ data: null, lines: [] }),
  ...over,
});
const full = (name: string, over: Partial<CommandSpec> = {}) => stub(name, { project: "full", ...over });
const returning = (result: CommandResult) => async () => result;
const throwing = (err: unknown) => async (): Promise<CommandResult> => {
  throw err;
};

const dbTest = (name: string, fn: (sql: Sql) => Promise<void>) => test(name, () => withTestDb(fn));

function without<K extends keyof Deps>(t: TestDeps, key: K): Omit<Deps, K> {
  const { [key]: _removed, ...rest } = t;
  void _removed;
  return rest;
}

/** Deps that fail the test if the project is loaded or connected. */
function noProject(over: Partial<Deps> = {}): TestDeps {
  return testDeps(NO_DB, {
    loadModule: () => {
      throw new Error("loadModule must not be called");
    },
    connect: () => {
      throw new Error("connect must not be called");
    },
    ...over,
  });
}

const doc = (t: TestDeps) => JSON.parse(t.stdout()) as Record<string, any>;

beforeEach(() => {
  vi.stubEnv("MOGGING_LICENSE_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("usage, version and help", () => {
  test("no arguments prints usage to stderr and exits 2", async () => {
    const t = noProject({ commands: [stub("alpha"), stub("beta")] });
    expect(await run([], t)).toBe(2);
    expect(t.stdout()).toBe("");
    expect(t.stderr()).toMatch(/usage: mogging/);
    expect(t.stderr()).toContain("alpha");
    expect(t.stderr()).toContain("the beta stub");
  });

  test("--version prints the package version and exits 0", async () => {
    const t = noProject();
    expect(await run(["--version"], t)).toBe(0);
    expect(t.stdout()).toBe(`${VERSION}\n`);
    expect(t.stderr()).toBe("");
  });

  test("--version stays plain text with --json, and wins over a following verb", async () => {
    const t = noProject();
    expect(await run(["--json", "--version"], t)).toBe(0);
    expect(t.stdout()).toBe(`${VERSION}\n`);
    const u = noProject({ commands: [stub("status")] });
    expect(await run(["--version", "status"], u)).toBe(0);
    expect(u.stdout()).toBe(`${VERSION}\n`);
  });

  test("--help alone prints the usage to stdout and exits 0", async () => {
    const t = noProject({ commands: [stub("alpha")] });
    expect(await run(["--help"], t)).toBe(0);
    expect(t.stdout()).toMatch(/usage: mogging/);
    expect(t.stdout()).toContain("alpha");
    expect(t.stderr()).toBe("");
  });

  test("--help with --json stays plain text", async () => {
    const t = noProject({ commands: [stub("alpha")] });
    expect(await run(["--json", "--help"], t)).toBe(0);
    expect(() => JSON.parse(t.stdout())).toThrow();
  });

  test("<command> --help prints the usage line and exits 0 without loading a project (before or after the verb)", async () => {
    for (const argv of [["status", "--help"], ["--help", "status"]]) {
      const t = noProject({ commands: [full("status", { usage: "mogging status [doc]", arity: [0, 1] })] });
      expect(await run(argv, t)).toBe(0);
      expect(t.stdout()).toBe("mogging status [doc]\n");
      expect(t.stderr()).toBe("");
    }
  });

  test("--help wins over the arity check", async () => {
    const t = noProject({ commands: [stub("status", { usage: "mogging status" })] });
    expect(await run(["status", "a", "b", "--help"], t)).toBe(0);
    expect(t.stdout()).toBe("mogging status\n");
  });

  test("unknown command exits 2 and names the command", async () => {
    const t = noProject({ commands: [stub("status")] });
    expect(await run(["nosuch"], t)).toBe(2);
    expect(t.stderr()).toContain("error: unknown command nosuch");
    expect(t.stdout()).toBe("");
  });

  test("an unknown option exits 2 and names it", async () => {
    const t = noProject({ commands: [stub("status")] });
    expect(await run(["status", "--bogus"], t)).toBe(2);
    expect(t.stderr()).toMatch(/error: .*--bogus/);
  });

  test("--version after a verb that does not define it exits 2 naming the option", async () => {
    const t = noProject({ commands: [stub("status")] });
    expect(await run(["status", "--version"], t)).toBe(2);
    expect(t.stderr()).toMatch(/error: .*--version/);
    expect(t.stdout()).toBe("");
  });

  test("a command that defines its own --version option receives it", async () => {
    const seen: unknown[] = [];
    const t = noProject({
      commands: [stub("approve", {
        options: { version: { type: "string" } }, arity: [1, 1],
        run: async (env) => (seen.push(env.flags.version, env.positionals), { data: null, lines: [] }),
      })],
    });
    expect(await run(["approve", "docs/x", "--version", "3"], t)).toBe(0);
    expect(seen).toEqual(["3", ["docs/x"]]);
  });

  test("a stray positional (a [0,0] stub given one) exits 2 with the usage", async () => {
    const t = noProject({ commands: [stub("status", { usage: "mogging status" })] });
    expect(await run(["status", "docs/x"], t)).toBe(2);
    expect(t.stderr()).toContain("mogging status");
    expect(t.stderr()).toContain("docs/x");
  });

  test("too few positionals is a UsageError printing the usage too", async () => {
    const t = noProject({ commands: [stub("track", { usage: "mogging track <doc>", arity: [1, 1] })] });
    expect(await run(["track"], t)).toBe(2);
    expect(t.stderr()).toContain("mogging track <doc>");
  });

  test("the built-in version and help commands work without a project", async () => {
    const v = noProject();
    expect(await run(["version"], v)).toBe(0);
    expect(v.stdout()).toBe(`${VERSION}\n`);
    const h = noProject();
    expect(await run(["help"], h)).toBe(0);
    expect(h.stdout()).toMatch(/usage: mogging/);
    expect(h.stdout()).toContain("version");
    const one = noProject();
    expect(await run(["help", "version"], one)).toBe(0);
    expect(one.stdout()).toMatch(/mogging version/);
    const bad = noProject();
    expect(await run(["help", "nosuch"], bad)).toBe(2);
  });
});

describe("verb discovery", () => {
  test("--json status finds status and the flag reaches the command (a JSON document is printed)", async () => {
    const t = noProject({
      commands: [stub("status", { run: async (env) => ({ data: { json: env.json }, lines: ["human"] }) })],
    });
    expect(await run(["--json", "status"], t)).toBe(0);
    expect(doc(t)).toEqual({ ok: true, partial: false, data: { json: true }, licence: null });
  });

  test("status --json still works", async () => {
    const t = noProject({
      commands: [stub("status", { run: async (env) => ({ data: { json: env.json }, lines: [] }) })],
    });
    expect(await run(["status", "--json"], t)).toBe(0);
    expect(doc(t).data).toEqual({ json: true });
  });

  dbTest("--actor bob status resolves the actor bob", async (sql) => {
    const t = testDeps(sql, {
      commands: [full("status", { run: async (env) => ({ data: env.project.ctx.actor, lines: [] }) })],
    });
    expect(await run(["--actor", "bob", "status", "--json"], t)).toBe(0);
    expect(doc(t).data).toBe("bob");
  });

  dbTest("--config=x status finds status and the config path reaches loadModule", async (sql) => {
    const loaded: string[] = [];
    const t = testDeps(sql, {
      loadModule: async (p) => (loaded.push(p), { config }),
      commands: [full("status")],
    });
    expect(await run(["--config=x", "status"], t)).toBe(0);
    expect(loaded).toEqual([resolve(t.cwd, "x")]);
  });

  test("--locale de status exits 2 naming --locale", async () => {
    const t = noProject({ commands: [stub("status", { options: { locale: { type: "string" } } })] });
    expect(await run(["--locale", "de", "status"], t)).toBe(2);
    expect(t.stderr()).toMatch(/error: .*--locale/);
  });

  test("a repeated single-value option exits 2 naming it; a repeated multiple option is accepted", async () => {
    const seen: unknown[] = [];
    const t = noProject({
      commands: [stub("pub", {
        options: { locale: { type: "string" }, tag: { type: "string", multiple: true } },
        run: async (env) => (seen.push(env.flags.tag), { data: null, lines: [] }),
      })],
    });
    expect(await run(["pub", "--locale", "de", "--locale", "fr"], t)).toBe(2);
    expect(t.stderr()).toMatch(/--locale given more than once/);
    expect(await run(["pub", "--tag", "a", "--tag", "b"], t)).toBe(0);
    expect(seen).toEqual([["a", "b"]]);
  });

  test("--json nosuch and status --json --bogus each print one JSON failure document with licence null and exit 2", async () => {
    const a = noProject({ commands: [stub("status")] });
    expect(await run(["--json", "nosuch"], a)).toBe(2);
    expect(doc(a)).toEqual({
      ok: false, error: { code: "UsageError", message: expect.stringContaining("nosuch") }, licence: null,
    });
    expect(a.stderr()).toContain("error: unknown command nosuch");

    const b = noProject({ commands: [stub("status")] });
    expect(await run(["status", "--json", "--bogus"], b)).toBe(2);
    expect(doc(b)).toMatchObject({ ok: false, error: { code: "UsageError" }, licence: null });
    expect(doc(b).error.message).toContain("--bogus");
    expect(b.stderr()).toContain("error:");
  });

  test("--json with no verb prints plain usage to stderr and exits 2", async () => {
    const t = noProject({ commands: [stub("status")] });
    expect(await run(["--json"], t)).toBe(2);
    expect(t.stdout()).toBe("");
  });
});

describe("exit codes", () => {
  const codes: Array<[string, string | undefined, number]> = [
    ["LicenceError", "LICENCE_EXPIRED", 3],
    ["LicenceError", "LICENCE_REQUIRED", 3],
    ["LicenceError", undefined, 3],
    ["UsageError", undefined, 2],
    ["ValidationError", undefined, 1],
    ["NotFoundError", undefined, 1],
    ["ConflictError", undefined, 1],
    ["NotPublishableError", undefined, 1],
    ["StaleReleaseError", undefined, 1],
    ["Error", undefined, 1],
    ["TypeError", undefined, 1],
  ];
  test.each(codes)("a thrown %s (code %s) exits %i, mapped by name/code, not instanceof", async (name, code, exit) => {
    const err = new Error("boom");
    err.name = name;
    if (code !== undefined) Object.assign(err, { code });
    const t = noProject({ commands: [stub("go", { run: throwing(err) })] });
    expect(await run(["go"], t)).toBe(exit);
    expect(t.stderr()).toBe("error: boom\n");
    expect(t.stdout()).toBe("");
  });

  test("real core and CLI error classes map the same way", async () => {
    const lic = noProject({ commands: [stub("go", { run: throwing(new LicenceError("LICENCE_REQUIRED", "pay")) })] });
    expect(await run(["go"], lic)).toBe(3);
    const use = noProject({ commands: [stub("go", { run: throwing(new UsageError("bad")) })] });
    expect(await run(["go"], use)).toBe(2);
    const str = noProject({ commands: [stub("go", { run: throwing("a string") })] });
    expect(await run(["go"], str)).toBe(1);
    expect(str.stderr()).toBe("error: a string\n");
  });

  test("a throw in --json mode prints the failure document (no data, no partial) and error: on stderr", async () => {
    const err = Object.assign(new Error("gone"), { name: "NotFoundError", code: "NOT_FOUND" });
    const t = noProject({ commands: [stub("go", { run: throwing(err) })] });
    expect(await run(["go", "--json"], t)).toBe(1);
    expect(doc(t)).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "gone" }, licence: null });
    expect(t.stderr()).toBe("error: gone\n");
  });

  test("exit 0 prints lines to stdout, one per line, and nothing to stderr", async () => {
    const t = noProject({ commands: [stub("go", { run: returning({ data: 1, lines: ["a", "b"] }) })] });
    expect(await run(["go"], t)).toBe(0);
    expect(t.stdout()).toBe("a\nb\n");
    expect(t.stderr()).toBe("");
  });

  test("--json prints exactly one document and not the lines", async () => {
    const t = noProject({ commands: [stub("go", { run: returning({ data: { n: 1 }, lines: ["a", "b"] }) })] });
    expect(await run(["go", "--json"], t)).toBe(0);
    expect(doc(t)).toEqual({ ok: true, partial: false, data: { n: 1 }, licence: null });
  });

  test("exit 4 prints normally, exits 4, and in --json is ok with partial", async () => {
    const result: CommandResult = { data: { done: 1, failed: 1 }, lines: ["half"], exitCode: 4 };
    const h = noProject({ commands: [stub("go", { run: returning(result) })] });
    expect(await run(["go"], h)).toBe(4);
    expect(h.stdout()).toBe("half\n");
    expect(h.stderr()).toBe("");
    const j = noProject({ commands: [stub("go", { run: returning(result) })] });
    expect(await run(["go", "--json"], j)).toBe(4);
    expect(doc(j)).toMatchObject({ ok: true, partial: true, data: { done: 1, failed: 1 } });
  });

  test("a returned exit 1 with an error prints its lines, then error: on stderr; --json has ok false, data and error", async () => {
    const result: CommandResult = {
      data: { stale: [1] }, lines: ["line"], exitCode: 1, error: { code: "StaleReleaseError", message: "stale items" },
    };
    const h = noProject({ commands: [stub("go", { run: returning(result) })] });
    expect(await run(["go"], h)).toBe(1);
    expect(h.stdout()).toBe("line\n");
    expect(h.stderr()).toBe("error: stale items\n");
    const j = noProject({ commands: [stub("go", { run: returning(result) })] });
    expect(await run(["go", "--json"], j)).toBe(1);
    expect(doc(j)).toEqual({
      ok: false, partial: false, data: { stale: [1] }, error: { code: "StaleReleaseError", message: "stale items" },
      licence: null,
    });
    expect(j.stderr()).toBe("error: stale items\n");
  });

  test("a returned exit 1 WITHOUT an error is a contract failure: error: exit 1 without error, exit 1", async () => {
    const t = noProject({ commands: [stub("go", { run: returning({ data: null, lines: ["x"], exitCode: 1 }) })] });
    expect(await run(["go"], t)).toBe(1);
    expect(t.stderr()).toBe("error: exit 1 without error\n");
    expect(t.stdout()).toBe("");
  });
});

describe("validate runs before anything is loaded", () => {
  test("a validate that throws UsageError exits 2 with connect and loadModule never called", async () => {
    const connect = vi.fn(() => {
      throw new Error("connect must not be called");
    });
    const loadModule = vi.fn(async () => {
      throw new Error("loadModule must not be called");
    });
    const t = testDeps(NO_DB, {
      connect, loadModule,
      commands: [full("compile", {
        validate: () => {
          throw new UsageError("--budget is required");
        },
      })],
    });
    expect(await run(["compile"], t)).toBe(2);
    expect(t.stderr()).toBe("error: --budget is required\n");
    expect(connect).not.toHaveBeenCalled();
    expect(loadModule).not.toHaveBeenCalled();
  });

  test("validate receives the parsed flags and positionals", async () => {
    const seen: unknown[] = [];
    const t = noProject({
      commands: [stub("pub", {
        options: { locale: { type: "string" } }, arity: [0, 1],
        validate: (flags, positionals) => void seen.push(flags.locale, positionals),
      })],
    });
    await run(["pub", "docs/x", "--locale", "de"], t);
    expect(seen).toEqual(["de", ["docs/x"]]);
  });

  test("in --json mode a validate failure prints the failure document with licence null", async () => {
    const t = noProject({
      commands: [full("compile", { validate: () => { throw new UsageError("--budget is required"); } })],
    });
    expect(await run(["compile", "--json"], t)).toBe(2);
    expect(doc(t)).toEqual({
      ok: false, error: { code: "UsageError", message: "--budget is required" }, licence: null,
    });
  });
});

describe("cleanup", () => {
  test("a full command whose loadModule rejects exits 1 without a TypeError from the cleanup", async () => {
    const t = testDeps(NO_DB, {
      loadModule: async () => {
        throw new Error("cannot load config");
      },
      connect: () => {
        throw new Error("connect must not be called");
      },
      commands: [full("go")],
    });
    expect(await run(["go"], t)).toBe(1);
    expect(t.stderr()).toBe("error: cannot load config\n");
    expect(t.stderr()).not.toContain("TypeError");
  });

  dbTest("a project.close() that rejects keeps the command's exit code and prints a warning", async (sql) => {
    const t = testDeps(sql, {
      connect: () => connectionOver(sql, () => Promise.reject(new Error("socket hang up"))),
      commands: [full("go", { run: returning({ data: null, lines: ["ok"], exitCode: 4 }) })],
    });
    expect(await run(["go"], t)).toBe(4);
    expect(t.stdout()).toBe("ok\n");
    expect(t.stderr()).toContain("warning: closing the database failed: socket hang up\n");
  });

  dbTest("a close failure never replaces a thrown error either", async (sql) => {
    const t = testDeps(sql, {
      connect: () => connectionOver(sql, () => Promise.reject(new Error("socket hang up"))),
      commands: [full("go", { run: throwing(new Error("boom")) })],
    });
    expect(await run(["go"], t)).toBe(1);
    expect(t.stderr()).toContain("error: boom\n");
    expect(t.stderr()).toContain("warning: closing the database failed: socket hang up");
  });

  dbTest("the project is closed exactly once after a full command, and a none command never connects", async (sql) => {
    const end = vi.fn(async () => {});
    const t = testDeps(sql, { connect: () => connectionOver(sql, end), commands: [full("go"), stub("plain")] });
    expect(await run(["go"], t)).toBe(0);
    expect(end).toHaveBeenCalledTimes(1);
    expect(await run(["plain"], t)).toBe(0);
    expect(end).toHaveBeenCalledTimes(1);
  });

  dbTest("needsAi without an ai export is a UsageError naming the command and the config, after the licence line", async (sql) => {
    const end = vi.fn(async () => {});
    const t = testDeps(sql, {
      connect: () => connectionOver(sql, end),
      loadModule: async () => ({ config }),
      commands: [full("compile", { needsAi: true })],
    });
    expect(await run(["compile", "--json"], t)).toBe(2);
    const message = `compile needs an \`ai\` export in ${resolve(t.cwd, "mogging.config.ts")} (defineAiConfig)`;
    expect(t.stderr()).toContain(`error: ${message}`);
    expect(doc(t)).toMatchObject({ ok: false, error: { code: "UsageError", message } });
    expect(doc(t).licence).toMatchObject({ state: "evaluation" });
    expect(end).toHaveBeenCalledTimes(1);
  });

  dbTest("needsAi with an ai export runs the command", async (sql) => {
    const t = testDeps(sql, { commands: [full("compile", { needsAi: true, run: async (env) => ({ data: env.project.ai !== undefined, lines: [] }) })] });
    expect(await run(["compile", "--json"], t)).toBe(0);
    expect(doc(t).data).toBe(true);
  });
});

describe("signals", () => {
  const counts = () => ({ int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") });

  test("with no usesSignal command, run registers no SIGINT/SIGTERM listener (before, during, after)", async () => {
    const before = counts();
    let during: ReturnType<typeof counts> | undefined;
    const t = noProject({
      commands: [stub("go", { run: async () => (during = counts(), { data: null, lines: [] }) })],
    });
    expect(await run(["go"], t)).toBe(0);
    expect(during).toEqual(before);
    expect(counts()).toEqual(before);
  });

  dbTest("a full command without usesSignal registers none either", async (sql) => {
    const before = counts();
    let during: ReturnType<typeof counts> | undefined;
    const t = testDeps(sql, {
      commands: [full("go", { run: async () => (during = counts(), { data: null, lines: [] }) })],
    });
    await run(["go"], t);
    expect(during).toEqual(before);
    expect(counts()).toEqual(before);
  });

  test("with usesSignal the listeners exist during the run and are gone after", async () => {
    const before = counts();
    let during: ReturnType<typeof counts> | undefined;
    const t = noProject({
      commands: [stub("go", { usesSignal: true, run: async () => (during = counts(), { data: null, lines: [] }) })],
    });
    expect(await run(["go"], t)).toBe(0);
    expect(during).toEqual({ int: before.int + 1, term: before.term + 1 });
    expect(counts()).toEqual(before);
  });

  test("the first signal aborts env.signal; a second calls deps.exit(130); listeners are removed in finally", async () => {
    const before = counts();
    const trace: unknown[] = [];
    const t = noProject({
      commands: [stub("go", {
        usesSignal: true,
        run: async (env) => {
          const mine = process.listeners("SIGINT").filter((l) => !sigintBefore.includes(l));
          trace.push(env.signal.aborted);
          mine[0]!.call(process, "SIGINT");
          trace.push(env.signal.aborted, t.exits.slice());
          mine[0]!.call(process, "SIGINT");
          trace.push(t.exits.slice());
          return { data: null, lines: [] };
        },
      })],
    });
    const sigintBefore = process.listeners("SIGINT");
    expect(await run(["go"], t)).toBe(0);
    expect(trace).toEqual([false, true, [], [130]]);
    expect(counts()).toEqual(before);
  });

  test("SIGTERM counts as a signal too (a SIGINT then a SIGTERM exits 130)", async () => {
    const t = noProject({
      commands: [stub("go", {
        usesSignal: true,
        run: async (env) => {
          const int = process.listeners("SIGINT").find((l) => !sigintBefore.includes(l))!;
          const term = process.listeners("SIGTERM").find((l) => !sigtermBefore.includes(l))!;
          int.call(process, "SIGINT");
          expect(env.signal.aborted).toBe(true);
          term.call(process, "SIGTERM");
          return { data: null, lines: [] };
        },
      })],
    });
    const sigintBefore = process.listeners("SIGINT");
    const sigtermBefore = process.listeners("SIGTERM");
    await run(["go"], t);
    expect(t.exits).toEqual([130]);
  });

  test("the listeners are removed even when the command throws", async () => {
    const before = counts();
    const t = noProject({ commands: [stub("go", { usesSignal: true, run: throwing(new Error("boom")) })] });
    expect(await run(["go"], t)).toBe(1);
    expect(counts()).toEqual(before);
  });

  test("usesSignal as a function decides per invocation", async () => {
    const before = counts();
    const during: number[] = [];
    const t = noProject({
      commands: [stub("review", {
        arity: [0, Infinity], options: { interactive: { type: "boolean" } },
        usesSignal: (flags, positionals) => flags.interactive === true && positionals.length === 0,
        run: async () => (during.push(process.listenerCount("SIGINT") - before.int), { data: null, lines: [] }),
      })],
    });
    await run(["review", "list"], t);
    await run(["review", "--interactive"], t);
    await run(["review"], t);
    expect(during).toEqual([0, 1, 0]);
    expect(counts()).toEqual(before);
  });

  test("a test's deps.signal reaches a usesSignal command, already aborted or aborted later", async () => {
    const seen: boolean[] = [];
    const ctl = new AbortController();
    const t = noProject({
      signal: ctl.signal,
      commands: [stub("go", {
        usesSignal: true,
        run: async (env) => {
          seen.push(env.signal.aborted);
          ctl.abort();
          seen.push(env.signal.aborted);
          return { data: null, lines: [] };
        },
      })],
    });
    await run(["go"], t);
    expect(seen).toEqual([false, true]);
    const pre = AbortSignal.abort();
    const u = noProject({
      signal: pre,
      commands: [stub("go", { usesSignal: true, run: async (env) => (seen.push(env.signal.aborted), { data: null, lines: [] }) })],
    });
    await run(["go"], u);
    expect(seen[2]).toBe(true);
  });

  test("a command without usesSignal gets deps.signal itself, else a live signal", async () => {
    const ctl = new AbortController();
    let got: AbortSignal | undefined;
    const cmd = stub("go", { run: async (env) => (got = env.signal, { data: null, lines: [] }) });
    await run(["go"], noProject({ signal: ctl.signal, commands: [cmd] }));
    expect(got).toBe(ctl.signal);
    await run(["go"], noProject({ commands: [cmd] }));
    expect(got).toBeInstanceOf(AbortSignal);
    expect(got!.aborted).toBe(false);
  });
});

describe("secrets", () => {
  const URL_SECRET = "postgres://u:secret@h/db";

  test("an error message containing a database URL prints the masked URL on stderr and in the JSON error.message", async () => {
    const mk = () => noProject({ commands: [stub("go", { run: throwing(new Error(`cannot reach ${URL_SECRET}`)) })] });
    const h = mk();
    expect(await run(["go"], h)).toBe(1);
    expect(h.stderr()).toBe("error: cannot reach postgres://u:***@h/db\n");
    const j = mk();
    expect(await run(["go", "--json"], j)).toBe(1);
    expect(doc(j).error.message).toBe("cannot reach postgres://u:***@h/db");
    expect(j.stderr()).toBe("error: cannot reach postgres://u:***@h/db\n");
    expect(j.stdout()).not.toContain("secret");
  });

  test("result lines and data containing a URL print *** in both human and --json output", async () => {
    const result: CommandResult = { data: { url: URL_SECRET, list: [URL_SECRET] }, lines: [`connected to ${URL_SECRET}`] };
    const h = noProject({ commands: [stub("go", { run: returning(result) })] });
    await run(["go"], h);
    expect(h.stdout()).toBe("connected to postgres://u:***@h/db\n");
    expect(h.stdout()).not.toContain("secret");
    const j = noProject({ commands: [stub("go", { run: returning(result) })] });
    await run(["go", "--json"], j);
    expect(j.stdout()).not.toContain("secret");
    expect(doc(j).data).toEqual({ url: "postgres://u:***@h/db", list: ["postgres://u:***@h/db"] });
  });

  test("a returned exit-1 error message and a usage error are masked too", async () => {
    const t = noProject({
      commands: [stub("go", {
        run: returning({ data: null, lines: [], exitCode: 1, error: { code: "X", message: `bad ${URL_SECRET}` } }),
      })],
    });
    await run(["go", "--json"], t);
    expect(t.stderr()).not.toContain("secret");
    expect(t.stdout()).not.toContain("secret");
    const u = noProject({ commands: [stub("go")] });
    await run([`postgres://u:secret@h/db`], u);
    expect(u.stderr()).not.toContain("secret");
  });

  test("the io handed to validate and to the command masks direct writes", async () => {
    const t = noProject({
      commands: [stub("go", {
        validate: (_f, _p, io) => io.err(`v ${URL_SECRET}\n`),
        run: async (env: CommandEnv) => (env.io.out(`r ${URL_SECRET}\n`), env.io.err(`e ${URL_SECRET}\n`), { data: null, lines: [] }),
      })],
    });
    await run(["go"], t);
    expect(t.stdout()).toBe("r postgres://u:***@h/db\n");
    expect(t.stderr()).toBe("v postgres://u:***@h/db\ne postgres://u:***@h/db\n");
  });

  dbTest("a close failure message with a URL is masked", async (sql) => {
    const t = testDeps(sql, {
      connect: () => connectionOver(sql, () => Promise.reject(new Error(`lost ${URL_SECRET}`))),
      commands: [full("go")],
    });
    await run(["go"], t);
    expect(t.stderr()).toContain("warning: closing the database failed: lost postgres://u:***@h/db");
    expect(t.stderr()).not.toContain("secret");
  });
});

describe("a refused connection", () => {
  test("a real run against localhost:1 exits 1 with a non-empty error line and no leaked password", async () => {
    const t = testDeps(NO_DB, { env: {}, commands: [full("go")] });
    const deps = without(t, "connect");
    const code = await run(["go", "--database-url", "postgres://u:hunter2@localhost:1/x"], deps);
    expect(code).toBe(1);
    expect(t.stderr()).toMatch(/error: \S.*\n/);
    expect(t.stderr()).not.toContain("hunter2");
    expect(t.stderr()).not.toContain("warning: closing");
  });
});

describe("the licence line", () => {
  const ago = (days: number) => (sql: Sql) =>
    sql`update migrations set applied_at = ${new Date(Date.now() - days * DAY)}`;
  const probe = () => full("go", { run: returning({ data: { done: true }, lines: ["did it"] }) });

  function keys() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
    return {
      publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      token(payload: Record<string, unknown>): string {
        const bytes = Buffer.from(JSON.stringify(payload), "utf8");
        return `mog1.${b64u(bytes)}.${b64u(sign(null, bytes, privateKey))}`;
      },
    };
  }
  const key = (plan: string) => ({ licensee: "Club e.V.", license_id: "lic_1", expiry: "2099-12-31", plan });

  dbTest("--json keeps stdout one parseable document while the evaluation warning prints to stderr", async (sql) => {
    await migrate(sql);
    await ago(25)(sql);
    const t = testDeps(sql, { commands: [probe()] });
    expect(await run(["go", "--json"], t)).toBe(0);
    const state = await getLicenceState({ sql, config, actor: "t" });
    expect(state.daysLeft).toBe(5);
    expect(doc(t)).toEqual({
      ok: true, partial: false, data: { done: true },
      licence: { state: "evaluation", daysLeft: state.daysLeft, warn: true, plan: null, licensee: null, keyError: null },
    });
    expect(t.stderr()).toBe("warning: MoggingCMS evaluation: 5 days left\n");
  });

  dbTest("evaluation prints the days left on stderr; the human lines stay on stdout", async (sql) => {
    await migrate(sql);
    await ago(20)(sql);
    const t = testDeps(sql, { commands: [probe()] });
    expect(await run(["go"], t)).toBe(0);
    expect(t.stderr()).toBe("MoggingCMS evaluation: 10 days left\n");
    expect(t.stdout()).toBe("did it\n");
  });

  dbTest("from 7 days left the line is a warning", async (sql) => {
    await migrate(sql);
    await ago(23)(sql);
    const t = testDeps(sql, { commands: [probe()] });
    await run(["go"], t);
    expect(t.stderr()).toBe("warning: MoggingCMS evaluation: 7 days left\n");
  });

  dbTest("expired warns that reads work and writes pause", async (sql) => {
    await migrate(sql);
    await ago(31)(sql);
    const t = testDeps(sql, { commands: [probe()] });
    expect(await run(["go", "--json"], t)).toBe(0);
    expect(t.stderr()).toMatch(/^warning: .*reads keep working.*paused/);
    expect(doc(t).licence).toMatchObject({ state: "expired", daysLeft: 0, warn: true });
  });

  dbTest("a noncommercial key prints exactly the notice and the licensee, and no evaluation line", async (sql) => {
    await migrate(sql);
    const k = keys();
    const t = testDeps(sql, {
      licenceKeys: [k.publicPem],
      loadModule: async () => ({ config: { ...config, license: k.token(key("noncommercial")) } }),
      commands: [probe()],
    });
    expect(await run(["go", "--json"], t)).toBe(0);
    expect(t.stderr()).toBe(
      "MoggingCMS noncommercial licence: commercial use is not permitted\nlicensee: Club e.V.\n",
    );
    expect(doc(t).licence).toEqual({
      state: "licensed", daysLeft: null, warn: false, plan: "noncommercial", licensee: "Club e.V.", keyError: null,
    });
  });

  dbTest("a paid key prints no licence line", async (sql) => {
    await migrate(sql);
    const k = keys();
    const t = testDeps(sql, {
      licenceKeys: [k.publicPem],
      loadModule: async () => ({ config: { ...config, license: k.token(key("solo")) } }),
      commands: [probe()],
    });
    expect(await run(["go", "--json"], t)).toBe(0);
    expect(t.stderr()).toBe("");
    expect(doc(t).licence).toMatchObject({ state: "licensed", plan: "solo", keyError: null });
  });

  dbTest("a key signed by a different pair is reported first, then the evaluation line; the JSON carries keyError", async (sql) => {
    await migrate(sql);
    const trusted = keys();
    const stranger = keys();
    const t = testDeps(sql, {
      licenceKeys: [trusted.publicPem],
      loadModule: async () => ({ config: { ...config, license: stranger.token(key("solo")) } }),
      commands: [probe()],
    });
    expect(await run(["go", "--json"], t)).toBe(0);
    expect(t.stderr()).toBe(
      "warning: licence key rejected (LICENCE_INVALID); running as evaluation\nMoggingCMS evaluation: 30 days left\n",
    );
    expect(doc(t).licence).toMatchObject({ state: "evaluation", keyError: "LICENCE_INVALID" });
  });

  dbTest("the failure document of a throw after the project opened carries the opened licence", async (sql) => {
    await migrate(sql);
    const t = testDeps(sql, { commands: [full("go", { run: throwing(new Error("late")) })] });
    expect(await run(["go", "--json"], t)).toBe(1);
    expect(doc(t)).toMatchObject({ ok: false, error: { code: "Error", message: "late" }, licence: { state: "evaluation" } });
    expect(doc(t)).not.toHaveProperty("data");
  });

  dbTest("a none command's JSON licence is its own result.licence, else null", async (sql) => {
    const own = { state: "licensed", daysLeft: null, warn: false, plan: "solo", licensee: "A", keyError: null } as const;
    const a = testDeps(sql, { commands: [stub("go", { run: returning({ data: null, lines: [], licence: own }) })] });
    await run(["go", "--json"], a);
    expect(doc(a).licence).toEqual(own);
    const b = testDeps(sql, { commands: [stub("go")] });
    await run(["go", "--json"], b);
    expect(doc(b).licence).toBeNull();
    expect(b.stderr()).toBe("");
  });
});
