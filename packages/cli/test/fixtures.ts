import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MockLanguageModelV3 } from "ai/test";
import type { Sql } from "postgres";
import type { LanguageModel } from "ai";
import { defineAiConfig } from "@mogging/ai";
import type { AiConfigInput, AiCtx } from "@mogging/ai";
import { defineCollection, defineConfig, richText, slug, text } from "@mogging/core";
import type { Deps, Io } from "../src/types.js";

export const docs = defineCollection("docs", {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
});

export const config = defineConfig({
  collections: [docs],
  locales: { source: "en", chains: { de: ["en"], fr: ["en"] } },
});

export const ai = defineAiConfig({
  provider: { kind: "custom", models: { "mock/translate": new MockLanguageModelV3() } },
  models: { translate: "mock/translate" },
  prices: { "mock/translate": { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 8000 } },
  budgets: { monthlyCapUsd: 1 },
});

/** A function, because the model object differs per test (copy of packages/ai/test/fixtures.ts). */
export function aiConfigFor(model: LanguageModel, overrides: Partial<AiConfigInput> = {}) {
  return defineAiConfig({
    provider: { kind: "custom", models: { "mock/translate": model } },
    models: { translate: "mock/translate" },
    prices: { "mock/translate": { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 8000 } },
    budgets: { monthlyCapUsd: 1 },
    ...overrides,
  });
}

/** An `AiCtx` over `sql` for the fixture config, for seeding jobs and calling the ai SDK from a test. */
export function ctxFor(sql: Sql, model: LanguageModel, overrides: Partial<AiConfigInput> = {}): AiCtx {
  return { sql, config: structuredClone(config), actor: "test", ai: aiConfigFor(model, overrides) };
}

/**
 * The test `sql` seen through `connect`: the same connection, but `end` is replaced (a no-op by default) because
 * `withTestDb` still needs the real connection after the command under test has closed its project.
 */
export function connectionOver(sql: Sql, end: () => Promise<void> = async () => {}): Sql {
  return new Proxy(sql, {
    get: (target, prop, receiver) => (prop === "end" ? end : Reflect.get(target, prop, receiver)),
  });
}

export type TestDeps = Deps & {
  /** Everything written through `io.out` / `io.err` so far. */
  stdout(): string;
  stderr(): string;
  /** Every argument `deps.exit` was called with. */
  exits: number[];
};

const tempDirs: string[] = [];
process.once("exit", () => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh `mkdtemp` directory holding an empty `mogging.config.ts` (the stubbed `loadModule` never reads it). */
export function tempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mogging-cli-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "mogging.config.ts"), "");
  return dir;
}

/** `Deps` for in-process runs against the per-test schema `sql`; `overrides` replace any default. */
export function testDeps(sql: Sql, overrides: Partial<Deps> = {}): TestDeps {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const io: Io = {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    stdin: Readable.from([]),
    isTTY: false,
    width: undefined,
    color: false,
  };
  const deps: Deps = {
    io,
    env: { DATABASE_URL: process.env.DATABASE_URL },
    cwd: tempProjectDir(),
    loadModule: async () => ({ config, ai }),
    connect: () => connectionOver(sql),
    now: () => new Date(),
    editor: () => Promise.reject(new Error("editor was not stubbed")),
    exit: (code) => void exits.push(code),
    ...overrides,
  };
  return Object.assign(deps, { stdout: () => out.join(""), stderr: () => err.join(""), exits });
}
