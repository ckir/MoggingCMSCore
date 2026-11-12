import type { LanguageModel } from "ai";
import postgres from "postgres";
import type { Sql } from "postgres";
import {
  createDocument, defineCollection, defineConfig, list, migrate, number, publish, richText, saveDraft, slug, text,
  type DocumentRecord, type Snapshot,
} from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { defineAiConfig } from "../src/config.js";
import type { AiConfigInput, AiCtx } from "../src/config.js";
import type { JobRow } from "../src/jobs.js";

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

const headFixture = (data: Record<string, unknown>): Snapshot => ({
  version: 1, state: "PUBLISHED", data, sourceHashes: {}, createdAt: new Date(0), createdBy: "seed",
  publishedAt: new Date(0), publishedBy: "seed",
});

/**
 * An in-memory `posts` record (no database): a published `en` head (version 1) holding title, body (a tree), legal,
 * tags and price, no `de` heads, not deleted. `overrides` replace top-level keys.
 */
export function docFixture(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    collection: "posts",
    createdAt: new Date(0),
    deletedAt: null,
    shared: { published: headFixture({ slug: "hello" }), draft: null },
    locales: {
      en: {
        published: headFixture({
          title: "Hello",
          body: markdownToTree("# Hi\n\nHello `x` {name}\n"),
          legal: "Terms apply",
          tags: ["a", "b"],
          price: 5,
        }),
        draft: null,
      },
    },
    ...overrides,
  };
}

/** A RUNNING in-memory `posts` job for `de` over title, body, legal and tags at source version 1. */
export function jobFixture(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1, docId: "00000000-0000-4000-8000-000000000001", collection: "posts", locale: "de",
    fieldPaths: ["title", "body", "legal", "tags"], sourceVersion: 1, state: "RUNNING", attempts: 1, maxAttempts: 3,
    runAfter: new Date(0), lockedUntil: new Date(0), lockedBy: "w#1", costEstimateMicros: 0, budgetScope: "global",
    errorMessage: null, createdAt: new Date(0), updatedAt: new Date(0),
    ...overrides,
  };
}
