import { describe, expect, test } from "vitest";
import { GLOBAL_OPTIONS, intOption, parseCommand, splitCommand, usdOption } from "../src/args.js";
import { UsageError } from "../src/types.js";
import type { CommandSpec } from "../src/types.js";

const spec = (options: CommandSpec["options"] = {}): CommandSpec => ({
  name: "stub", summary: "s", usage: "mogging stub", options, project: "none", arity: [0, Infinity],
  run: async () => ({ data: null, lines: [] }),
});

describe("splitCommand", () => {
  test("a plain verb leaves the rest untouched", () => {
    expect(splitCommand(["status", "docs/x", "--json"])).toEqual({
      command: "status", rest: ["docs/x", "--json"], versionFlag: false,
    });
  });

  test("global options may precede the verb and stay in rest", () => {
    expect(splitCommand(["--json", "status"])).toEqual({ command: "status", rest: ["--json"], versionFlag: false });
    expect(splitCommand(["--actor", "bob", "status"])).toEqual({
      command: "status", rest: ["--actor", "bob"], versionFlag: false,
    });
    expect(splitCommand(["--config=x", "status"])).toEqual({
      command: "status", rest: ["--config=x"], versionFlag: false,
    });
    expect(splitCommand(["--json", "--database-url", "postgres://h/d", "--actor=a", "status", "x"])).toEqual({
      command: "status", rest: ["--json", "--database-url", "postgres://h/d", "--actor=a", "x"], versionFlag: false,
    });
  });

  test("a string option consumes its value even when the value looks like a verb or an option", () => {
    expect(splitCommand(["--actor", "status", "status"]).command).toBe("status");
    expect(splitCommand(["--actor", "--json", "status"])).toEqual({
      command: "status", rest: ["--actor", "--json"], versionFlag: false,
    });
  });

  test("--version among the leading tokens sets versionFlag, with or without a verb", () => {
    expect(splitCommand(["--version"])).toEqual({ command: undefined, rest: ["--version"], versionFlag: true });
    expect(splitCommand(["--json", "--version"]).versionFlag).toBe(true);
    expect(splitCommand(["--version", "status"])).toMatchObject({ command: "status", versionFlag: true });
  });

  test("--version after the verb is not a version request", () => {
    expect(splitCommand(["status", "--version"])).toEqual({
      command: "status", rest: ["--version"], versionFlag: false,
    });
  });

  test("no tokens, or only globals, means no verb", () => {
    expect(splitCommand([])).toEqual({ command: undefined, rest: [], versionFlag: false });
    expect(splitCommand(["--help"])).toEqual({ command: undefined, rest: ["--help"], versionFlag: false });
  });

  test("a non-global option where the verb should be is the command (and so unknown)", () => {
    expect(splitCommand(["--locale", "de", "status"]).command).toBe("--locale");
  });
});

describe("parseCommand", () => {
  test("a multiple option collects an array", () => {
    const s = spec({ locale: { type: "string", multiple: true } });
    expect(parseCommand(["--locale", "de", "--locale", "fr"], s).flags.locale).toEqual(["de", "fr"]);
    expect(parseCommand(["--locale", "de", "--locale=fr"], s).flags.locale).toEqual(["de", "fr"]);
  });

  test("a repeated single-value option is a UsageError naming it, in either spelling", () => {
    const s = spec({ locale: { type: "string" } });
    expect(() => parseCommand(["--locale", "de", "--locale", "fr"], s)).toThrow(UsageError);
    expect(() => parseCommand(["--locale", "de", "--locale", "fr"], s)).toThrow(/--locale given more than once/);
    expect(() => parseCommand(["--locale", "de", "--locale=fr"], s)).toThrow(/--locale given more than once/);
  });

  test("a repeated boolean is refused too, a repeated global as well", () => {
    expect(() => parseCommand(["--json", "--json"], spec())).toThrow(/--json given more than once/);
  });

  test("a boolean flag given a value is a UsageError", () => {
    expect(() => parseCommand(["--json=yes"], spec())).toThrow(UsageError);
  });

  test("an unknown option is a UsageError naming it", () => {
    expect(() => parseCommand(["--bogus"], spec())).toThrow(UsageError);
    expect(() => parseCommand(["--bogus"], spec())).toThrow(/--bogus/);
  });

  test("--version is not a global option: unknown unless the command defines it", () => {
    expect(GLOBAL_OPTIONS).not.toHaveProperty("version");
    expect(() => parseCommand(["docs/x", "--version", "3"], spec())).toThrow(UsageError);
    const s = spec({ version: { type: "string" } });
    expect(parseCommand(["docs/x", "--version", "3"], s)).toEqual({
      flags: { version: "3" }, positionals: ["docs/x"],
    });
  });

  test("global options parse for every command; positionals are returned", () => {
    const { flags, positionals } = parseCommand(["a", "--json", "--actor", "bob", "b"], spec());
    expect(flags).toMatchObject({ json: true, actor: "bob" });
    expect(positionals).toEqual(["a", "b"]);
  });
});

describe("intOption", () => {
  test("undefined passes through, plain digits parse", () => {
    expect(intOption("limit", undefined, 1)).toBeUndefined();
    expect(intOption("limit", "10", 1)).toBe(10);
    expect(intOption("limit", "007", 1)).toBe(7);
    expect(intOption("limit", "0", 0)).toBe(0);
    expect(intOption("limit", "5", 1, 5)).toBe(5);
  });

  test.each(["1e1", "0x10", " 3 ", "-1", "", "+3", "1.5", "abc", "99999999999999999999"])(
    "refuses %j",
    (text) => {
      expect(() => intOption("limit", text, 0)).toThrow(UsageError);
      expect(() => intOption("limit", text, 0)).toThrow(/--limit/);
    },
  );

  test("refuses a value below min and one above max", () => {
    expect(() => intOption("limit", "0", 1)).toThrow(/--limit/);
    expect(() => intOption("limit", "6", 1, 5)).toThrow(/--limit/);
    expect(() => intOption("limit", "6", 1, 5)).toThrow(UsageError);
  });
});

describe("usdOption", () => {
  test("undefined passes through; plain decimals parse", () => {
    expect(usdOption("budget", undefined)).toBeUndefined();
    expect(usdOption("budget", "0.5")).toBe(0.5);
    expect(usdOption("budget", "12")).toBe(12);
  });

  test.each(["0x10", "1e2", "0", "0.0", "-1", "", " 1 ", ".5", "1.", "abc"])("refuses %j", (text) => {
    expect(() => usdOption("budget", text)).toThrow(UsageError);
    expect(() => usdOption("budget", text)).toThrow(/--budget/);
  });
});
