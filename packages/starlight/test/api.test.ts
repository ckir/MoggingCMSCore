import { describe, expect, it } from "vitest";

describe("the @mogging/starlight public surface", () => {
  it("the root entry exports exactly the default integration", async () => {
    expect(Object.keys(await import("../src/index.js")).sort()).toEqual(["default"]);
  });

  it("the preset entry exports exactly starlightPreset", async () => {
    expect(Object.keys(await import("../src/preset.js")).sort()).toEqual(["starlightPreset"]);
  });
});
