import type { Sql } from "postgres";
import postgres from "postgres";
import {
  defineCollection, defineConfig, list, number, richText, slug, text,
} from "../src/index.js";
import type { Ctx } from "../src/index.js";

export const posts = defineCollection("posts", {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
  legal: text({ localized: true, fallback: ["en"] }),
  price: number({ localized: true, fallback: "none" }),
  tags: list(text(), { localized: true }),
});

export const config = defineConfig({
  collections: [posts],
  locales: { source: "en", chains: { "de-CH": ["de", "en"], de: ["en"] } },
});

export const ctxFor = (sql: Sql, actor = "tester"): Ctx => ({ sql, config, actor });

/**
 * Opens an extra, independent connection bound to the same per-test schema as `sql`
 * (withTestDb pins one connection). Caller must `end()` it.
 */
export async function extraConnection(sql: Sql): Promise<Sql> {
  const [{ s }] = (await sql`select current_schema() as s`) as unknown as [{ s: string }];
  return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: s } });
}

/**
 * Task 6A (publish) is not built yet: this inserts a PUBLISHED head directly, exactly as the
 * publish flip will leave it (state PUBLISHED, is_head_published true, no draft head).
 */
export async function insertPublishedLocalized(
  sql: Sql, docId: string, locale: string, version: number, data: Record<string, unknown>,
  sourceHashes: Record<string, string> = {},
): Promise<void> {
  await sql`insert into document_localized
      (doc_id, locale, version, state, data, source_hashes, is_head_published, created_by, published_at, published_by)
    values (${docId}, ${locale}, ${version}, 'PUBLISHED', ${sql.json(data as never)}, ${sql.json(sourceHashes)},
            true, 'fixture', now(), 'fixture')`;
}

/** Inserts a DRAFT_AI draft head directly (recordAiDraft does not exist yet). Localized only. */
export async function insertAiDraftLocalized(
  sql: Sql, docId: string, locale: string, version: number, data: Record<string, unknown>,
): Promise<void> {
  await sql`update document_localized set is_head_draft = false where doc_id = ${docId} and locale = ${locale} and is_head_draft`;
  await sql`insert into document_localized (doc_id, locale, version, state, data, is_head_draft, created_by)
    values (${docId}, ${locale}, ${version}, 'DRAFT_AI', ${sql.json(data as never)}, true, 'ai')`;
}
