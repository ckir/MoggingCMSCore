import { expect, test } from "vitest";
import * as api from "../src/index.js";

// THE CONTRACT: the complete runtime surface of @mogging/markdown. Every task that adds an export updates
// this list in the same commit.
test("the runtime surface is exactly the contract", () => {
  expect(Object.keys(api).sort()).toEqual(["MARK_ORDER", "validateTree"]);
});
