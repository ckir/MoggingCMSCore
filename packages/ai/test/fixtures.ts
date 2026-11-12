import type { LanguageModel } from "ai";
import postgres from "postgres";
import type { Sql } from "postgres";
import {
  createDocument, defineCollection, defineConfig, list, migrate, number, publish, richText, saveDraft, slug, text,
} from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { defineAiConfig } from "../src/config.js";
import type { AiConfigInput, AiCtx } from "../src/config.js";

const posts = defineCollection("posts", {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
  legal: text({ localized: true, fallback: ["en"] }),
  price: number({ localized: true, fallback: "none" }),
  tags: list(text(), { localized: true }),
});

const docs = defineCollection("docs", {
  body: richText({ localized: true, body: true }),
  summary: richText({ localized: true }),
});

export const config = defineConfig({
  collections: [posts, docs],
  locales: { source: "en", chains: { "de-CH": ["de", "en"], de: ["en"] } },
});

/** A function, because the model object differs per test. */
export function aiConfigFor(model: LanguageModel, overrides: Partial<AiConfigInput> = {}) {
  return defineAiConfig({
    provider: { kind: "custom", models: { "mock/translate": model } },
    models: { translate: "mock/translate" },
    prices: { "mock/translate": { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 8000 } },
    budgets: { monthlyCapUsd: 1 },
    ...overrides,
  });
}

/**
 * A fresh ctx per call: the core config is a structured clone of the shared one (plain data), and `ai` is built
 * anew (it holds model objects, which must not be cloned), so tests that mutate `collections` or `ai.budgets`
 * never leak into other tests. `overrides` are passed to aiConfigFor.
 */
export function ctxFor(sql: Sql, model: LanguageModel, overrides: Partial<AiConfigInput> = {}): AiCtx {
  return { sql, config: structuredClone(config), actor: "test", ai: aiConfigFor(model, overrides) };
}

/**
 * Opens an extra, independent connection bound to the same per-test schema as `sql` (withTestDb pins one
 * connection); a copy of packages/core/test/fixtures.ts `extraConnection`. Caller must `end()` it.
 */
export async function extraConnection(sql: Sql): Promise<Sql> {
  const [{ s }] = (await sql`select current_schema() as s`) as unknown as [{ s: string }];
  return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: s } });
}

/** Migrates the schema and publishes one `posts` document in `en`; returns its docId. */
export async function migrateAndSeed(sql: Sql): Promise<string> {
  await migrate(sql);
  const ctx = { sql, config, actor: "seed" };
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, {
    docId,
    locale: "en",
    data: {
      title: "Hello",
      body: markdownToTree("# Hi\n\nHello `x` {name}\n"),
      legal: "Terms apply",
      tags: ["a", "b"],
      price: 5,
    },
  });
  await publish(ctx, { docId, locale: "en" });
  return docId;
}
