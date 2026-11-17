import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const lines = text.split("\n");

/** The lines inside fenced shell blocks (```sh, ```bash): the commands a reader types. */
function commandLines(): string[] {
  const out: string[] = [];
  let shell = false;
  let inFence = false;
  for (const line of lines) {
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence !== null) {
      inFence = !inFence;
      shell = inFence && (fence[1] === "sh" || fence[1] === "bash");
      continue;
    }
    if (inFence && shell) out.push(line);
  }
  return out;
}

describe("the @mogging/starlight README", () => {
  it("puts the licence first", () => {
    const first = lines.find((l) => l.startsWith("## "));
    expect(first).toBeDefined();
    expect(first).toContain("Licence");
  });

  it("walks the first session in order", () => {
    const commands = commandLines();
    const needles = [
      "init --starlight",
      "migrate",
      "import",
      "compile --locales",
      "review",
      "release publish",
      "export",
    ];
    const at = needles.map((n) => commands.findIndex((l) => l.includes(n)));
    expect(at.every((i) => i >= 0), `a command is missing: ${JSON.stringify(Object.fromEntries(needles.map((n, i) => [n, at[i]])))}`).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(new Set(at).size).toBe(needles.length);
  });

  it("states the supported versions, the extra-fields hook and where the licence key goes", () => {
    expect(text).toContain(">=0.43.0 <0.44.0");
    expect(text).toContain("extraFields");
    expect(text).toContain("MOGGING_LICENSE_KEY");
  });

  it("has a section on adding a language", () => {
    expect(lines.some((l) => /^#{2,} /.test(l) && l.includes("language"))).toBe(true);
  });
});
