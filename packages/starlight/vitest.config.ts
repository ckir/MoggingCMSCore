import { defineConfig } from "vitest/config";

// Database-backed tests (race tests especially) can exceed vitest's 5 s default on a busy machine.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
