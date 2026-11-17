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

/** The fenced shell blocks, each as its list of non-empty command lines. */
function commandBlocks(): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence !== null) {
      if (current === null) current = fence[1] === "sh" || fence[1] === "bash" ? [] : null;
      else { blocks.push(current); current = null; }
      continue;
    }
    if (current !== null && line.trim() !== "") current.push(line.trim());
  }
  return blocks;
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

  it("names where a key is bought and where it goes before the first install command", () => {
    const install = commandLines().find((l) => l.includes("npm install"));
    expect(install).toBeDefined();
    const before = text.slice(0, text.indexOf(install!));
    expect(before).toContain("https://mogging.dev/buy");
    expect(before).toContain("MOGGING_LICENSE_KEY");
  });

  it("has a section on adding a language", () => {
    expect(lines.some((l) => /^#{2,} /.test(l) && l.includes("language"))).toBe(true);
  });

  it("commits the manifest with the exported files", () => {
    const add = commandLines().filter((l) => l.includes("git add"));
    expect(add.length).toBeGreaterThan(0);
    expect(add.some((l) => l.includes(".mogging/manifest.json"))).toBe(true);
  });

  it("translates the language the 'Adding a language later' steps add", () => {
    const start = lines.findIndex((l) => /^## Adding a language later/.test(l));
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    const section = rest.slice(0, end < 0 ? undefined : end).join("\n");
    expect(section).toContain("chains: { fr:");
    expect(section).toContain("compile --locales fr ");
    expect(section).not.toContain("compile --locales it");
  });

  it("never lists `review` and `review --approve-clean` in one block (a literal reader runs one)", () => {
    for (const block of commandBlocks()) {
      const plain = block.some((l) => /mogging review$/.test(l));
      const clean = block.some((l) => l.includes("review --approve-clean"));
      expect(plain && clean, `one block lists both: ${JSON.stringify(block)}`).toBe(false);
    }
  });
});
