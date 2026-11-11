import { defineConfig } from "vitest/config";

// Root runs delegate to each package's own vitest.config.ts (vitest reads only vitest.config / vite.config).
export default defineConfig({
  test: { projects: ["packages/*"] },
});
