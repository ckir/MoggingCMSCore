import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { keywords?: string[] };

describe("the @mogging/starlight package.json", () => {
  it("carries the astro-integration keyword, without which `astro add` refuses the package", () => {
    // Astro 7.4.4 src/cli/add/index.ts:950-958 rejects a package whose keywords lack "astro-integration".
    expect(pkg.keywords).toContain("astro-integration");
  });
});
