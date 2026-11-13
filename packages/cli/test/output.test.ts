import { describe, expect, test } from "vitest";
import type { LicenceState } from "@mogging/core";
import { describeError, jsonDocument, licenceInfo, licenceLines, maskSecrets, table } from "../src/output.js";
import type { LicenceInfo } from "../src/types.js";

describe("maskSecrets", () => {
  test("replaces the password of a database URL", () => {
    expect(maskSecrets("postgres://u:secret@h/db")).toBe("postgres://u:***@h/db");
    expect(maskSecrets("connect postgresql://admin:p%40ss@db.example.com:5432/x?sslmode=require failed")).toBe(
      "connect postgresql://admin:***@db.example.com:5432/x?sslmode=require failed",
    );
  });

  test("masks every URL in the text", () => {
    expect(maskSecrets("a postgres://u:one@h/d and b postgres://v:two@g/e")).toBe(
      "a postgres://u:***@h/d and b postgres://v:***@g/e",
    );
  });

  test("leaves text without a password alone", () => {
    for (const s of ["postgres://u@h/db", "postgres://h:5432/db", "http://host:8080/x@y", "user@example.com", "a: b@c"]) {
      expect(maskSecrets(s)).toBe(s);
    }
  });

  test("masking a serialized JSON document keeps it parseable", () => {
    const json = JSON.stringify({ a: "postgres://u:secret@h/db", b: "x@y", c: "postgres://u:p" });
    const masked = maskSecrets(json);
    expect(masked).not.toContain("secret");
    expect(JSON.parse(masked)).toEqual({ a: "postgres://u:***@h/db", b: "x@y", c: "postgres://u:p" });
  });
});

describe("table", () => {
  test("pads columns by the longest cell and separates them by two spaces", () => {
    expect(table([["a", "bbb", "c"], ["dddd", "e", "f"]])).toEqual(["a     bbb  c", "dddd  e    f"]);
  });

  test("a header is the first row", () => {
    expect(table([["x", "1"]], ["name", "n"])).toEqual(["name  n", "x     1"]);
  });

  test("no rows and no header is no lines; no trailing whitespace", () => {
    expect(table([])).toEqual([]);
    expect(table([["a", "b"], ["cc", ""]]).every((l) => l === l.trimEnd())).toBe(true);
  });
});

describe("describeError", () => {
  test("code is the error's string code, else its name; message is err.message", () => {
    expect(describeError(Object.assign(new Error("boom"), { code: "E_X" }))).toEqual({ code: "E_X", message: "boom" });
    const named = new Error("nope");
    named.name = "NotFoundError";
    expect(describeError(named)).toEqual({ code: "NotFoundError", message: "nope" });
    expect(describeError(Object.assign(new Error("n"), { code: 42 })).code).toBe("Error");
  });

  test("an AggregateError with an empty message joins its sub-messages", () => {
    const d = describeError(
      new AggregateError([new Error("connect ECONNREFUSED ::1:1"), new Error("connect ECONNREFUSED 127.0.0.1:1")]),
    );
    expect(d.message).toContain("connect ECONNREFUSED ::1:1");
    expect(d.message).toContain("connect ECONNREFUSED 127.0.0.1:1");
    expect(d.message).toBe("connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1");
  });

  test("an empty message with no errors falls back to the code", () => {
    expect(describeError(Object.assign(new Error(""), { code: "ECONNREFUSED" }))).toEqual({
      code: "ECONNREFUSED", message: "ECONNREFUSED",
    });
    expect(describeError(new Error("")).message).toBe("Error");
  });

  test("a thrown non-Error still gives a code and a message", () => {
    expect(describeError("plain text")).toEqual({ code: "Error", message: "plain text" });
  });

  test("the result is masked", () => {
    const d = describeError(Object.assign(new Error("cannot reach postgres://u:secret@h/db"), { code: "E" }));
    expect(d.message).toBe("cannot reach postgres://u:***@h/db");
  });
});

const info = (over: Partial<LicenceInfo> = {}): LicenceInfo => ({
  state: "evaluation", daysLeft: 20, warn: false, plan: null, licensee: null, keyError: null, ...over,
});

describe("licenceInfo", () => {
  test("maps an evaluation state", () => {
    const s: LicenceState = { state: "evaluation", daysLeft: 5, warn: true };
    expect(licenceInfo(s)).toEqual({
      state: "evaluation", daysLeft: 5, warn: true, plan: null, licensee: null, keyError: null,
    });
  });

  test("a licensed state carries plan and licensee and a null daysLeft", () => {
    const s: LicenceState = {
      state: "licensed", warn: false, payload: { licensee: "Acme", license_id: "l1", expiry: "2099-01-01", plan: "solo" },
    };
    expect(licenceInfo(s)).toEqual({
      state: "licensed", daysLeft: null, warn: false, plan: "solo", licensee: "Acme", keyError: null,
    });
  });

  test("carries a key error", () => {
    const s: LicenceState = { state: "expired", daysLeft: 0, warn: true, keyError: "LICENCE_INVALID" };
    expect(licenceInfo(s)).toMatchObject({ state: "expired", daysLeft: 0, keyError: "LICENCE_INVALID" });
  });
});

describe("licenceLines", () => {
  test("evaluation: days left, plain until 7 days, a warning from 7 days", () => {
    expect(licenceLines(info({ daysLeft: 20 }))).toEqual(["MoggingCMS evaluation: 20 days left"]);
    expect(licenceLines(info({ daysLeft: 7, warn: true }))).toEqual(["warning: MoggingCMS evaluation: 7 days left"]);
    expect(licenceLines(info({ daysLeft: 3, warn: true }))).toEqual(["warning: MoggingCMS evaluation: 3 days left"]);
  });

  test("expired names that reads keep working and writes are paused", () => {
    const lines = licenceLines(info({ state: "expired", daysLeft: 0, warn: true }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^warning: /);
    expect(lines[0]).toMatch(/evaluation has ended/);
    expect(lines[0]).toMatch(/reads keep working/);
    expect(lines[0]).toMatch(/paused/);
  });

  test("a paid key prints nothing", () => {
    expect(licenceLines(info({ state: "licensed", daysLeft: null, plan: "solo", licensee: "Acme" }))).toEqual([]);
  });

  test("a noncommercial key prints the notice and then the licensee", () => {
    expect(licenceLines(info({ state: "licensed", daysLeft: null, plan: "noncommercial", licensee: "Club e.V." }))).toEqual([
      "MoggingCMS noncommercial licence: commercial use is not permitted",
      "licensee: Club e.V.",
    ]);
  });

  test("a rejected key comes first, naming the state the run falls back to", () => {
    expect(licenceLines(info({ keyError: "LICENCE_INVALID", daysLeft: 20 }))).toEqual([
      "warning: licence key rejected (LICENCE_INVALID); running as evaluation",
      "MoggingCMS evaluation: 20 days left",
    ]);
    const expired = licenceLines(info({ state: "expired", daysLeft: 0, warn: true, keyError: "LICENCE_EXPIRED" }));
    expect(expired[0]).toBe("warning: licence key rejected (LICENCE_EXPIRED); running as expired");
    expect(expired).toHaveLength(2);
  });
});

describe("jsonDocument", () => {
  test("exit 0 and 4 are ok, partial exactly for 4", () => {
    expect(jsonDocument({ result: { data: [1], lines: [] }, licence: null })).toEqual({
      ok: true, partial: false, data: [1], licence: null,
    });
    expect(jsonDocument({ result: { data: 1, lines: [], exitCode: 4 }, licence: info() })).toEqual({
      ok: true, partial: true, data: 1, licence: info(),
    });
  });

  test("a returned exit 1 keeps data and carries the result's error", () => {
    const error = { code: "X", message: "m" };
    expect(jsonDocument({ result: { data: { stale: [] }, lines: [], exitCode: 1, error }, licence: null })).toEqual({
      ok: false, partial: false, data: { stale: [] }, error, licence: null,
    });
  });

  test("a throw has no data and no partial", () => {
    const error = { code: "UsageError", message: "m" };
    const doc = jsonDocument({ error, licence: null });
    expect(doc).toEqual({ ok: false, error, licence: null });
    expect(doc).not.toHaveProperty("data");
    expect(doc).not.toHaveProperty("partial");
  });

  test("a result's own licence wins over the opened project's", () => {
    const own = info({ state: "licensed", daysLeft: null });
    expect(jsonDocument({ result: { data: null, lines: [], licence: own }, licence: info() }).licence).toEqual(own);
  });
});
