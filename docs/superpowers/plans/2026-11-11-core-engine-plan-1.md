# MoggingCMSCore Plan 1: Scaffold, Rich-Text Spike, Core Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the repository, run the mandatory rich-text sentinel spike, and deliver `@mogging/core`: migrations, schema builders, hashing, document writes, publish, fallback reads, sync state, releases and approval, all tested against a real Postgres.

**Architecture:** A pnpm monorepo. `@mogging/core` is SQL-first over postgres.js with hand-written queries and numbered SQL migrations; every engine operation is a function taking a typed context `{ sql, config, actor }`. Storage is the document-locale snapshot layout from the spec (section 7): `document_shared` and `document_localized` carry one JSON snapshot per version with head flags, and staleness is computed from per-field hash vectors. The spike lives in `spikes/` and is throwaway; its result is a report, not code.

**Tech Stack:** TypeScript 5.x, Node 22+ (Node 24 locally), pnpm 12 workspaces, vitest 5, postgres.js 4 (`postgres`), `canonicalize` 5 (RFC 8785), node:crypto SHA-256, Postgres 16+ (18.6 locally). Spike only: `ai` 7, `@openrouter/ai-sdk-provider` 3, `mdast-util-from-markdown` 2, `mdast-util-to-markdown` 2, `mdast-util-gfm` 3, `mdast-util-mdx` 3.

**Spec:** `docs/superpowers/specs/2026-11-11-moggingcms-core-design.md` (approved 2026-11-11). Section numbers below refer to it.

**Plan series:** This is plan 1 of 4. Plan 2: `@mogging/markdown` (tree, converters, import and export). Plan 3: `@mogging/ai` (jobs, providers, validation, budgets), shaped by the spike result. Plan 4: `@mogging/cli` and the review surface. Plans 2 to 4 are written only after this plan is merged, because no code exists to cite yet.

## Global Constraints

- Node `>=22` (`engines` in every package.json); TypeScript throughout; ESM only.
- Postgres `>=16` is the only required service; tests run against a real database at `DATABASE_URL`.
- No LLM call anywhere in `@mogging/core` (spec 4). The spike is the only place this plan calls a model.
- Prompts, model ids and token counts never in content tables (spec 4): `document_shared` and `document_localized` carry only `data` and `source_hashes`.
- Locale codes are BCP 47, stored case-normalized as `language[-Script][-REGION]` (`de-CH`) (spec 6.2).
- Hash = SHA-256 hex over RFC 8785 canonical JSON of the typed-normalized value (spec 6.4).
- Top-level field is the unit of localization, fallback, hashing and null stripping (spec 6.1, 7.2).
- Licence: custom source-available text per spec 12.1, never called "open source"; scope `@mogging` (spec 10, 12).
- Licence verification is offline (spec 12.2); the engine makes no network call except to the adopter's Postgres and LLM provider (spec 4).
- Every write takes `actor: string` and records it (spec 8.7).
- Commit after every green task; conventional commit messages; the attribution trailer from the session.

## Review Focus

1. A locale given as `de-ch` or `DE-CH` must be accepted and stored as `de-CH`; a mismatch would silently create a second locale. Pinned in Task 3.
2. A draft containing a field the collection does not declare must be rejected, not stored; otherwise typos become orphaned data. Pinned in Task 5.
3. `resolve` with `asOf` earlier than the first publication must return no document, not the current head. Pinned in Task 7.
4. Two writers saving the same (document, locale) with the same `expectedVersion` must produce exactly one success and one `ConflictError`. Pinned in Task 5.
5. A list field whose elements include `null` must round-trip unchanged (nested null is a value, spec 7.2); only top-level null is stripped. Pinned in Task 4.

---

### Task 1: Repository scaffold and test database harness

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `LICENSE.md` (the custom source-available text of spec 12.1; until the lawyer-reviewed text exists, the file holds the PolyForm Noncommercial 1.0.0 text from `.clavity/scratch/licence/PolyForm-Noncommercial-1.0.0.txt` plus a clearly marked DRAFT evaluation-grant and anti-circumvention section, and `package.json` carries `"license": "SEE LICENSE IN LICENSE.md"`), `CLA.md` (contributor licence agreement per spec 12.5, DRAFT until lawyer-reviewed), `CONTRIBUTING.md` (states that external pull requests are not merged until the CLA tooling exists), `.gitignore` additions (`node_modules/`, `dist/`, `.env`), `.env.example`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/db.ts`, `packages/core/test/smoke.test.ts`
- Create: `docs/dev-setup.md`

**Interfaces:**
- Produces: `withTestDb(fn: (sql: Sql) => Promise<void>): Promise<void>` in `packages/core/test/db.ts`. Creates a schema named `t_<random8>` on the connection from `DATABASE_URL`, sets `search_path` to it, runs `fn`, drops the schema. Each test file gets isolation without a database per test.
- Produces: `DATABASE_URL` convention `postgres://mogging:mogging@localhost:5432/mogging_test`.

- [ ] **Step 1: Create the local test role and database** (owner's machine; document in `docs/dev-setup.md`)

```bash
sudo -u postgres psql -c "CREATE ROLE mogging LOGIN PASSWORD 'mogging';" -c "CREATE DATABASE mogging_test OWNER mogging;"
```
Expected: `CREATE ROLE` and `CREATE DATABASE`.

- [ ] **Step 2: Write the workspace files.** Root `package.json` is private with scripts `test` (`vitest run`), `typecheck` (`tsc -b`), `lint` (optional, builder's choice). `pnpm-workspace.yaml` lists `packages/*` and `spikes/*`. `tsconfig.base.json`: `strict`, `module: NodeNext`, `target: ES2022`, `verbatimModuleSyntax`. `packages/core/package.json`: name `@mogging/core`, `type: module`, `engines.node: ">=22"`, deps `postgres@^4`, `canonicalize@^5`; devDeps `vitest@^5`, `typescript@^5`, `tsx@^4`.

- [ ] **Step 3: Write `withTestDb` in `packages/core/test/db.ts`** with the signature above. It reads `process.env.DATABASE_URL` and throws a clear error naming `docs/dev-setup.md` when unset.

- [ ] **Step 4: Write the failing smoke test** `packages/core/test/smoke.test.ts`:

```ts
test("connects and runs inside an isolated schema, and drops it afterwards", async () => {
  let name = "";
  await withTestDb(async (sql) => {
    const [{ schema }] = await sql`select current_schema() as schema`;
    expect(schema).toMatch(/^t_[a-z0-9]{8}$/);
    name = schema;
  });
  const sql = postgres(process.env.DATABASE_URL!);
  const rows = await sql`select 1 from pg_namespace where nspname = ${name}`;
  expect(rows).toHaveLength(0);
  await sql.end();
});
```

- [ ] **Step 5: Run it** with `DATABASE_URL=postgres://mogging:mogging@localhost:5432/mogging_test pnpm test`. Expected: PASS, 1 test.

- [ ] **Step 6: Commit** `chore: scaffold monorepo, core package and Postgres test harness`.

---

### Task 2: Rich-text sentinel spike (throwaway, report only)

Required by spec section 10 before plan 3 is written. Needs `OPENROUTER_API_KEY` from the owner.

**Files:**
- Create: `spikes/rich-text-sentinel/package.json`, `spikes/rich-text-sentinel/run.ts`, `spikes/rich-text-sentinel/corpus/*.md`, `spikes/rich-text-sentinel/README.md`
- Create: `docs/superpowers/spikes/2026-11-DD-rich-text-sentinel-results.md` (DD = run date)

**Interfaces:**
- Produces: a results report with the numbers plan 3 needs. No importable code.

- [ ] **Step 1: Assemble a corpus** of 20 real documentation pages in `corpus/`: at least 5 with admonitions (`:::note` style), 5 with GFM tables, 5 with MDX components or raw HTML, all with inline code, at least 5 with `{placeholder}` tokens added by hand. Use MIT-licensed docs (the builder picks, records the sources in `README.md`).

- [ ] **Step 2: Write `run.ts`** that, for each page and for each of two models (`openai/gpt-4o-mini` class and `anthropic/claude-sonnet` class, the exact current ids chosen at run time from the OpenRouter catalogue): parse with mdast + gfm + mdx; replace every `code`, `inlineCode`, `html`, `mdxJsxFlowElement`, `mdxJsxTextElement` and unknown block with `⟦MOGGING:n⟧` keeping the originals in an array; send the Markdown as data in a delimited user message with a system prompt that names the sentinels immutable and asks for German; receive structured output `{ markdown: string }` via `generateObject`; re-insert sentinels; parse; compare block type sequence, sentinel count and placeholder count to the source; classify each page as ACCEPTED, or REJECTED with one of `SENTINEL_MISSING`, `SENTINEL_DUPLICATED`, `SENTINEL_ALTERED`, `BLOCK_SEQUENCE`, `PLACEHOLDER`, `PARSE_ERROR`. Record tokens and cost from the response usage.

- [ ] **Step 3: Run it twice per model** (`OPENROUTER_API_KEY=... pnpm --filter rich-text-sentinel run`). Expected: a JSON results file per run under `spikes/rich-text-sentinel/out/` (gitignored).

- [ ] **Step 4: Write the report** with: rejection rate per model per run; failure kinds with one example each; how often admonition bodies carried translatable text (count of pages where an opaque block contained prose); total cost; and the decision per the spec's rule: if the strong model's rejection rate exceeds 10 percent, plan 3 uses per-block structured items instead of one Markdown string. Commit the report and the spike source; do not commit `out/`.

- [ ] **Step 5: Commit** `spike: rich-text sentinel results`.

---

### Task 3: Schema builders, config, locale normalization and fallback chains

**Files:**
- Create: `packages/core/src/schema/fields.ts`, `packages/core/src/schema/collection.ts`, `packages/core/src/schema/config.ts`, `packages/core/src/schema/locale.ts`, `packages/core/src/errors.ts`
- Test: `packages/core/test/schema.test.ts`

**Interfaces:**
- Produces field builders: `text(o?)`, `richText(o?)`, `number(o?)`, `boolean(o?)`, `dateTime(o?)`, `slug()`, `reference(collection: string, o?)`, `list(item: Field, o?)`, `object(fields: Record<string, Field>, o?)`. Options `o`: `{ localized?: boolean; fallback?: string[] | "none"; body?: boolean; required?: boolean }`. `slug()` is always shared. Exactly one `richText({ body: true })` per collection.
- Produces `defineCollection(name: string, fields: Record<string, Field>): Collection` and `defineConfig(c: { collections: Collection[]; locales: { source: string; chains: Record<string, string[]> }; }): MoggingConfig`. `defineConfig` throws `ValidationError` on: zero collections, no body field, more than one body field, a chain referencing an undeclared locale, a localized `slug`.
- Produces `normalizeLocale(code: string): string` (BCP 47 case rules; throws `ValidationError` on malformed).
- Produces `chainFor(config, locale: string, collection: string, field: string): string[]` returning the full ordered list to try, starting with `locale` itself, applying the per-field override and `"none"` (returns `[locale]`).
- Produces error classes in `errors.ts`: `ValidationError`, `ConflictError`, `NotPublishableError`, `StaleReleaseError`, `NotFoundError`, all extending `MoggingError` with a `code` string.

- [ ] **Step 1: Write failing tests** in `schema.test.ts`:

```ts
test("normalizeLocale canonicalizes case", () => {
  expect(normalizeLocale("de-ch")).toBe("de-CH");
  expect(normalizeLocale("DE-CH")).toBe("de-CH");
  expect(normalizeLocale("zh-hant-tw")).toBe("zh-Hant-TW");
  expect(() => normalizeLocale("de_CH")).toThrow(ValidationError);
});
test("chainFor applies locale chain, field override and none", () => {
  const cfg = defineConfig({ collections: [posts], locales: { source: "en", chains: { "de-CH": ["de", "en"], de: ["en"] } } });
  expect(chainFor(cfg, "de-CH", "posts", "body")).toEqual(["de-CH", "de", "en"]);
  expect(chainFor(cfg, "de-CH", "posts", "legal")).toEqual(["de-CH", "en"]);   // legal: fallback ["en"]
  expect(chainFor(cfg, "de-CH", "posts", "price")).toEqual(["de-CH"]);        // price: fallback "none"
});
test("defineConfig rejects a collection without exactly one body field", ...);
test("defineConfig rejects a localized slug", ...);
```
where `posts = defineCollection("posts", { slug: slug(), title: text({ localized: true }), body: richText({ localized: true, body: true }), legal: text({ localized: true, fallback: ["en"] }), price: number({ localized: true, fallback: "none" }), tags: list(text(), { localized: true }) })`.

- [ ] **Step 2: Run** `pnpm --filter @mogging/core test schema`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** the builders, `defineCollection`, `defineConfig`, `normalizeLocale`, `chainFor`, errors. `Field` is a discriminated union on `kind`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): schema builders, config validation, locale chains`.

---

### Task 4: Typed normalization, canonical hashing, null stripping

**Files:**
- Create: `packages/core/src/values/normalize.ts`, `packages/core/src/values/hash.ts`
- Test: `packages/core/test/values.test.ts`

**Interfaces:**
- Produces `normalizeValue(field: Field, value: unknown): unknown` (spec 6.4: text NFC; dateTime to ISO 8601 UTC with milliseconds; number must be a JSON number; boolean must be boolean; slug lower-cased; list and object recurse on their item or sub-field kinds). Throws `ValidationError` with the field path on a kind mismatch.
- Produces `hashValue(value: unknown): string` = SHA-256 hex over `canonicalize(value)`.
- Produces `stripTopLevelNulls(data: Record<string, unknown>): Record<string, unknown>`.
- Produces `isEmptyValue(field: Field, value: unknown): boolean` (empty string, empty list, empty object, empty tree; always false for scalar kinds).

- [ ] **Step 1: Write failing tests**:

```ts
test("dateTime normalizes to UTC with milliseconds", () => {
  expect(normalizeValue(dateTime(), "2026-11-11T08:00:00Z")).toBe("2026-11-11T08:00:00.000Z");
  expect(normalizeValue(dateTime(), "2026-11-11T10:00:00+02:00")).toBe("2026-11-11T08:00:00.000Z");
});
test("text normalizes NFC so composed and decomposed hash equal", () => {
  expect(hashValue(normalizeValue(text(), "é"))).toBe(hashValue(normalizeValue(text(), "é")));
});
test("hash is RFC 8785 canonical: key order does not matter", () => {
  expect(hashValue({ b: 1, a: [1, 2] })).toBe(hashValue({ a: [1, 2], b: 1 }));
});
test("number given as string is rejected", () => {
  expect(() => normalizeValue(number(), "3")).toThrow(ValidationError);
});
test("top-level null is stripped, nested null is kept", () => {
  expect(stripTopLevelNulls({ a: null, b: [1, null], c: { d: null } })).toEqual({ b: [1, null], c: { d: null } });
});
test("isEmptyValue is true for '' [] {} and false for 0 and false", ...);
```
- [ ] **Step 2: Run** `pnpm --filter @mogging/core test values`. Expected: FAIL.
- [ ] **Step 3: Implement** the four functions.
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): typed normalization and canonical hashing`.

---

### Task 5: Migration runner, engine migration 0001, document creation and draft saves

**Files:**
- Create: `packages/core/src/migrate.ts`, `packages/core/migrations/0001_engine.sql`, `packages/core/src/ctx.ts`, `packages/core/src/documents/create.ts`, `packages/core/src/documents/saveDraft.ts`
- Test: `packages/core/test/migrate.test.ts`, `packages/core/test/saveDraft.test.ts`

**Interfaces:**
- Produces `migrate(sql: Sql, dir?: string): Promise<string[]>` applying numbered `*.sql` files not yet in `migrations(name, applied_at)`, each in its own transaction, returning the names applied.
- Produces `0001_engine.sql`: exactly the tables and indexes of spec 7.1 (documents, document_shared, document_localized, content_provenance, ai_jobs, releases, release_items, glossary, ai_budgets, migrations), with the probe DDL in `.clavity/scratch/storage-layout/claude-probe.sql` as the starting point and spec 7.1 winning where they differ: `document_shared` gets `state`, `is_head_published`, `is_head_draft`, `published_at`, `published_by`, `unpublished_at`; `document_localized.state` check includes `APPROVED`; `content_provenance` gains `job_id`, `edited`, `discarded`, `discard_reason`, `warnings text[] not null default '{}'`, `acknowledged_warnings`, `bulk_id`, nullable `version` and `field_path`; `ai_jobs` is per (doc, locale) with `field_paths text[]`, `source_hashes jsonb`, `cost_estimate_micros`, `budget_scope`, plus the reaper index; `ai_budgets` without reservation column; `releases.allow_stale`.
- Produces `type Ctx = { sql: Sql; config: MoggingConfig; actor: string }` in `ctx.ts`.
- Produces `createDocument(ctx, { collection: string }): Promise<{ id: string }>` and
  `deleteDocument(ctx, { docId }): Promise<void>` (soft delete: sets `deleted_at = now()`; spec 6.3
  time-travel treats the document as absent from then on; hard delete is not in v0.1).
- Produces `saveDraft(ctx, { docId: string; locale: string | "shared"; data: Record<string, unknown>; expectedVersion?: number; }): Promise<{ version: number }>`. `data` is the **complete** snapshot for that locale (spec 6.3: a snapshot is never a delta): a field omitted from `data` is absent in the new version and will fall back. There is no partial-merge save in v0.1; callers that want to change one field read the head with `getDocument` (Task 7) and resubmit it. Behaviour (spec 7.2, 6.3, 6.4): lock the `documents` row; validate every key is a declared field of the right scope (localized vs shared) and normalize values; strip top-level nulls; allocate `version = max(version)+1` for that (doc, locale) or (doc, shared); if `expectedVersion` is given and differs from the current head version (draft head if any, else published head, else 0) throw `ConflictError`; clear the previous draft head flag; insert with `state = DRAFT_HUMAN`; for a non-source locale, set `source_hashes[field] = hash of the source locale's current published value` for every field saved (spec 6.4, "human save asserts sync"); for the source locale, `source_hashes[field] = hash of its own value`. Shared snapshots have no `source_hashes`.

- [ ] **Step 1: Write failing migration tests**:

```ts
test("migrate applies 0001 once and is idempotent", async () => withTestDb(async (sql) => {
  expect(await migrate(sql)).toEqual(["0001_engine.sql"]);
  expect(await migrate(sql)).toEqual([]);
  const tables = await sql`select tablename from pg_tables where schemaname = current_schema() order by 1`;
  expect(tables.map(t => t.tablename)).toEqual(["ai_budgets","ai_jobs","content_provenance","document_localized","document_shared","documents","glossary","migrations","release_items","releases"]);
}));
test("second published head for a (doc, locale) is rejected by the index", ...); // expect error code 23505
```
- [ ] **Step 2: Run** `pnpm --filter @mogging/core test migrate`. Expected: FAIL.
- [ ] **Step 3: Write `migrate.ts` and `0001_engine.sql`.** Run the test. Expected: PASS. Commit `feat(core): migration runner and engine schema 0001`.
- [ ] **Step 4: Write failing saveDraft tests** (fixture: the `posts` collection from Task 3 with chains `de-CH -> de -> en`, `en` source):

```ts
test("first save allocates version 1 and becomes draft head", ...);          // state DRAFT_HUMAN, is_head_draft true
test("undeclared field is rejected", async () => expect(saveDraft(ctx, { docId, locale: "en", data: { titel: "x" } })).rejects.toThrow(ValidationError));
test("shared field saved under a locale is rejected, and vice versa", ...);
test("top-level null is stripped before storage", ...);                      // data has no key
test("human save of a target records current source hashes", async () => {
  // publish en title "Hello"; save de title "Hallo"; expect source_hashes.title === hashValue("Hello")
});
test("stale expectedVersion throws ConflictError", ...);
test("two concurrent saves with the same expectedVersion: one succeeds, one conflicts", async () => {
  const results = await Promise.allSettled([saveDraft(ctx, a), saveDraft(ctx, a)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected" && r.reason instanceof ConflictError)).toHaveLength(1);
});
```
- [ ] **Step 5: Run**. Expected: FAIL. **Step 6: Implement** `ctx.ts`, `create.ts`, `saveDraft.ts`. **Step 7: Run**. Expected: PASS.
- [ ] **Step 8: Commit** `feat(core): document creation and draft saves with hash vectors`.

---

### Task 6A: Publish and unpublish

**Files:**
- Create: `packages/core/src/documents/publish.ts`
- Test: `packages/core/test/publish.test.ts`

**Interfaces:**
- Produces `publish(ctx, { docId; locale: string | "shared"; version?: number }): Promise<void>` (spec 6.3 flip rule), under the `documents` row lock. Without `version`: the current draft head is published; it must be `DRAFT_HUMAN` or `APPROVED`, and `DRAFT_AI` or no draft head throws `NotPublishableError`. With `version`: that row must be either the current draft head (same rule) or a previously published row (`state = PUBLISHED`, `is_head_published = false`), which is the republish case; any other row (a historical draft, a superseded AI draft) throws `NotPublishableError`. On success: `state = PUBLISHED`, `is_head_published = true`, `is_head_draft = false`, `published_at = now()`, `published_by = ctx.actor`, `unpublished_at = null`; the previous published head gets `is_head_published = false`, `unpublished_at = now()`.
- Produces `unpublish(ctx, { docId; locale }): Promise<void>`: clears the published head and sets `unpublished_at`; the row stays and can be republished by version.

- [ ] **Step 1: Write failing publish tests**: `publish flips flags and stamps published_at/published_by`; `previous head gets unpublished_at`; `DRAFT_AI cannot be published` (NotPublishableError); `a historical draft version cannot be published` (NotPublishableError); `unpublish then publish by version republishes the same row and clears unpublished_at`; `shared snapshot follows the same lifecycle`.
- [ ] **Step 2: Run** (FAIL). **Step 3: Implement** `publish.ts`. **Step 4: Run** (PASS). **Step 5: Commit** `feat(core): publish and unpublish as head flips`.

---

### Task 6B: AI-draft recording and approval

**Files:**
- Create: `packages/core/src/documents/recordAiDraft.ts`, `packages/core/src/documents/approve.ts`
- Test: `packages/core/test/approve.test.ts`

**Interfaces:**
- Consumes: `publish` from Task 6A, `saveDraft` from Task 5, `hashValue` and `normalizeValue` from Task 4.
- Produces `recordAiDraft(ctx, { docId; locale; fields: Record<string, unknown>; sourceVersion: number; sourceHashes: Record<string, string>; provenance: Array<{ fieldPath; modelId; promptVersion; promptTokens; completionTokens; costMicros; jobId?; warnings?: string[] }> }): Promise<{ version: number } | { cancelled: "DRAFT_HUMAN" | "SOURCE_MOVED" }>` (spec 8.1), all in one transaction **under the `documents` row lock** so it serializes with `saveDraft`: if the source locale's published head version is not `sourceVersion` return `SOURCE_MOVED`; if the draft head is `DRAFT_HUMAN` return `DRAFT_HUMAN`; if the draft head is `DRAFT_AI` or `APPROVED`, build the new snapshot from that draft's data with `fields` replacing the stale ones and clear its head flag (supersede); otherwise build from the published head's data; insert `DRAFT_AI` with `source_hashes` merged; write provenance rows.
- Produces `approve(ctx, { docId; locale; edits?: Record<string, unknown>; rejectFields?: string[]; acknowledgedWarnings?: string[]; bulkId?: string }): Promise<{ version: number }>` (spec 6.3), under the `documents` row lock: the draft head must be `DRAFT_AI`; rejected fields revert to the published head's value or are removed; `edits` are normalized and applied; a new `APPROVED` version is inserted as draft head; provenance rows copied from the AI version with `edited = true` for edited fields, `acknowledged_warnings`, `bulk_id`, `approved_by = ctx.actor`, `approved_at = now()`; the AI version loses its head flag and stays in history.
- Produces `approveClean(ctx, { collection?: string; locale?: string }): Promise<{ approved: number; skipped: Array<{ docId; locale; reason: string }> }>`: calls `approve` with one shared `bulkId` for every `DRAFT_AI` head in scope whose provenance rows all have an empty `warnings` array. `content_provenance.warnings text[] not null default '{}'` is declared in spec 7.1 (added 2026-11-11 for this); plan 3's validator fills it, and `recordAiDraft` accepts an optional `warnings: string[]` per provenance entry so this plan's test can create a draft with a warning.

- [ ] **Step 1: Write failing approve tests**: `recordAiDraft returns SOURCE_MOVED when source advanced`; `recordAiDraft returns DRAFT_HUMAN when a human draft exists and inserts nothing`; `recordAiDraft supersedes a stale APPROVED draft and keeps its non-stale field values` (edit `title` in APPROVED, make `body` stale, expect new draft title === edited title); `concurrent saveDraft and recordAiDraft on the same (doc, locale): the human draft is never overwritten` (run both with `Promise.allSettled`; whichever order, the final draft head is `DRAFT_HUMAN` or the AI call returned `DRAFT_HUMAN`); `approve with edits marks edited provenance and produces APPROVED head`; `approve rejectFields reverts to published value`; `approveClean approves only drafts without warnings and shares one bulk_id`.
- [ ] **Step 2: Run** (FAIL). **Step 3: Implement** `recordAiDraft.ts`, `approve.ts`. **Step 4: Run** (PASS). **Step 5: Commit** `feat(core): AI draft recording, supersede rule, approval and approve-clean`.

---

### Task 7: Fallback reads and time travel

**Files:**
- Create: `packages/core/src/read/resolve.ts`, `packages/core/src/read/query.ts`
- Test: `packages/core/test/resolve.test.ts`

**Interfaces:**
- Produces `resolve(ctx, { collection: string; locale: string; ids?: string[]; limit?: number; asOf?: Date }): Promise<Array<{ id: string; data: Record<string, unknown>; fellBack: Record<string, string>; missing: string[] }>>` (spec 7.3, 6.2, 6.3): one SQL statement joining the shared head and the published head of every locale in the union of all chains for the collection, merged in chain order per field by the query builder using `chainFor`; `fellBack[field]` names the locale a field came from when it is not `locale`; `missing` lists localized fields no locale in the chain had; with `asOf`, the head predicate becomes `published_at <= asOf and (unpublished_at is null or unpublished_at > asOf)` and documents with `deleted_at <= asOf` are absent.
- Produces `resolveReference(ctx, { docId; locale }): Promise<{ id; resolvedLocale: string } | null>` (spec 6.6).
- Produces `getDocument(ctx, { collection: string; docId?: string; slug?: string }): Promise<DocumentRecord | null>` where `DocumentRecord = { id; collection; createdAt; deletedAt: Date | null; shared: { published: Snapshot | null; draft: Snapshot | null }; locales: Record<string, { published: Snapshot | null; draft: Snapshot | null }> }` and `Snapshot = { version; state; data; sourceHashes: Record<string, string>; createdAt; createdBy; publishedAt: Date | null; publishedBy: string | null }`. Raw heads, no fallback applied; exactly one of `docId` or `slug` is required (`slug` looks up `document_shared` published-or-draft head `data->>'slug'`). This is what the importer (re-import match), the AI worker (source hashes and draft context) and the review surface (side-by-side) read.
- Produces `listDocuments(ctx, { collection: string; limit?: number; after?: string; includeDeleted?: boolean }): Promise<{ items: Array<{ id; slug: string | null; createdAt }>; next: string | null }>` ordered by `created_at, id` with keyset pagination (`after` is the last id seen).

- [ ] **Step 1: Write failing tests** (fixture: 3 docs; en published for all; de published with `legal` absent and `title` present; de-CH published for doc 1 only with `title`):

```ts
test("de-CH resolves title from de-CH, body from de, legal from en and reports fellBack", async () => {
  const [d] = await resolve(ctx, { collection: "posts", locale: "de-CH", ids: [doc1] });
  expect(d.fellBack).toEqual({ body: "de", legal: "en" });
});
test("price with fallback none is missing when de lacks it", ...);        // d.missing includes "price"
test("a field saved as JSON null in de falls back to en", ...);            // saved via saveDraft, stripped, then fallback
test("an empty string in de is returned as empty, not fallen back", ...);
test("asOf before first publication returns no documents", async () => {
  expect(await resolve(ctx, { collection: "posts", locale: "en", asOf: new Date("2000-01-01") })).toEqual([]);
});
test("asOf between two publications returns the first version", ...);
test("resolve of 50 documents issues one SQL statement", ...);            // count statements via a postgres.js debug hook
test("getDocument by slug returns raw heads per locale with sourceHashes and no fallback", ...);
test("getDocument returns null for an unknown slug", ...);
test("listDocuments paginates by keyset and excludes soft-deleted docs by default", ...);
```
- [ ] **Step 2: Run** (FAIL). **Step 3: Implement** `query.ts` (builds the statement; the merge is `coalesce(jsonb ||...)` in chain order, with per-field overrides selected in SQL by `->` on the specific locale rows) and `resolve.ts`. **Step 4: Run** (PASS).
- [ ] **Step 5: Commit** `feat(core): single-statement fallback resolve with time travel`.

---

### Task 8: Sync state (current, stale, untracked, missing, orphaned)

**Files:**
- Create: `packages/core/src/sync/state.ts`
- Test: `packages/core/test/sync.test.ts`

**Interfaces:**
- Produces `getSyncState(ctx, { collection?: string; docId?: string; locale?: string }): Promise<Array<{ docId; locale; field; state: "current" | "stale" | "untracked" | "missing" | "orphaned"; sourceVersion: number }>>` (spec 6.4): enumerates every (document, declared non-source locale, localized field) pair, so a locale with no snapshot yields `missing` for every field; compares the target head's `source_hashes` with the source head's; a target field with a value but no hash is `untracked`; a target field absent from the source is `orphaned`. Per document this is the measured per-doc query; without a filter it is the sweep.
- Produces `trackFields(ctx, { docId; locale; fields: string[] }): Promise<void>`: writes the current source hashes for the named fields into `source_hashes` of the target's current head row in place (published head if one exists, else the draft head), under the `documents` lock. No new version: hashes are sync metadata, not content, and forcing a republish to track a field would be wrong. Records one provenance row per field with `model_id = "human:track"` and `approved_by = ctx.actor` so the assertion is attributed.

- [ ] **Step 1: Write failing tests**: `new locale with no snapshot reports every localized field missing`; `source change on title makes de title stale and leaves body current`; `human save of de after the change makes it current`; `field present in de but absent from schema-declared source is orphaned`; `untracked field becomes current after trackFields`; `sweep over 200 docs x 3 locales returns the expected count` (count derived in the test, not hard-coded).
- [ ] **Step 2: Run** (FAIL). **Step 3: Implement**. **Step 4: Run** (PASS).
- [ ] **Step 5: Commit** `feat(core): sync state computation`.

---

### Task 9: Releases

**Files:**
- Create: `packages/core/src/releases/releases.ts`
- Test: `packages/core/test/releases.test.ts`

**Interfaces:**
- Produces `createRelease(ctx, { name }): Promise<{ id }>`, `addToRelease(ctx, { releaseId; docId; locale: string | "shared"; version }): Promise<void>` (the version must be a current draft head in `DRAFT_HUMAN` or `APPROVED`), `publishRelease(ctx, { releaseId; allowStale?: boolean }): Promise<void>` (spec 8.1, 7.2): in one transaction, lock the involved `documents` rows in ascending id, recompute sync state for every localized item, throw `StaleReleaseError` listing the stale items unless `allowStale`, record `allow_stale` on the release, flip every item with the `publish` rule, stamp `published_at`/`published_by`.

- [ ] **Step 1: Write failing tests**: `publishRelease flips all items atomically` (one item violating NotPublishable rolls back the others); `stale APPROVED item refuses the whole release and names it`; `allowStale publishes and records allow_stale = true`; `two overlapping releases published concurrently both complete without deadlock` (expect no error with SQLSTATE 40P01).
- [ ] **Step 2: Run** (FAIL). **Step 3: Implement**. **Step 4: Run** (PASS).
- [ ] **Step 5: Commit** `feat(core): releases with stale re-check and ordered locking`.

---

### Task 9B: Licence keys, evaluation window and guarded operations

**Files:**
- Create: `packages/core/src/licence/key.ts`, `packages/core/src/licence/guard.ts`, `packages/core/src/licence/publicKey.ts`
- Modify: `packages/core/src/documents/saveDraft.ts`, `packages/core/src/documents/approve.ts`, `packages/core/src/documents/publish.ts`, `packages/core/src/releases/releases.ts` (each guarded write calls `assertLicensed(ctx)` first)
- Test: `packages/core/test/licence.test.ts`
- Create (tooling, not shipped in the package): `tools/licence/sign.ts` (signs a payload with a private key from `MOGGING_LICENSE_PRIVATE_KEY`; used by the checkout function later and by tests)

**Interfaces:**
- Consumes: `Ctx` (Task 5), the `migrations` table (Task 5), `MoggingError` (Task 3).
- Produces `type LicencePayload = { licensee: string; license_id: string; expiry: string /* ISO date */; plan: string }` and `encodeKey(payload, privateKeyPem): string` / `verifyKey(token: string, publicKeyPem?: string): LicencePayload` (spec 12.2). Token format: `mog1.` + base64url(JSON payload) + `.` + base64url(Ed25519 signature over the payload bytes). `verifyKey` throws `LicenceError` (new error class, code `LICENCE_INVALID` or `LICENCE_EXPIRED`) on bad signature, malformed token or expiry in the past. The embedded public key in `publicKey.ts` is the owner's; tests use a test key pair and pass `publicKeyPem` explicitly.
- Produces `getLicenceState(ctx): Promise<{ state: "licensed" | "evaluation" | "expired"; daysLeft?: number; payload?: LicencePayload }>` (spec 12.3): reads `process.env.MOGGING_LICENSE_KEY` or `ctx.config.license`; if a valid key is present, `licensed`; otherwise evaluation window = 30 days from `min(applied_at)` in `migrations`; `evaluation` with `daysLeft` inside the window, `expired` after.
- Produces `assertLicensed(ctx): Promise<void>`: throws `LicenceError` with code `LICENCE_REQUIRED` and a message containing the purchase URL from `ctx.config.purchaseUrl` (default `https://mogging.dev/buy`, owner's call) and the sentence "Reads keep working; content updates, compiles and publishing are paused until a licence key is set." when state is `expired`. Reads never call it.
- Produces `license?: string` and `purchaseUrl?: string` fields on `MoggingConfig` (Task 3's `defineConfig` accepts them).

- [ ] **Step 1: Write failing tests**:

```ts
test("encodeKey then verifyKey round-trips the payload", ...);
test("a token signed with a different key is LICENCE_INVALID", ...);
test("an expired token is LICENCE_EXPIRED", ...);
test("a tampered payload with the original signature is LICENCE_INVALID", ...);
test("fresh database is in evaluation with 30 days left", async () => withTestDb(async (sql) => {
  const s = await getLicenceState(ctxWithoutKey);
  expect(s).toMatchObject({ state: "evaluation", daysLeft: 30 });
}));
test("evaluation expires 30 days after the first migration", ...);   // update migrations.applied_at to 31 days ago
test("expired without key: saveDraft, approve, publish, publishRelease throw LICENCE_REQUIRED naming the purchase URL; resolve and getDocument still work", ...);
test("expired with a valid key: everything works and state is licensed", ...);
```
- [ ] **Step 2: Run** `pnpm --filter @mogging/core test licence`. Expected: FAIL.
- [ ] **Step 3: Implement** `key.ts`, `guard.ts`, `publicKey.ts`, add `assertLicensed(ctx)` as the first statement of each guarded write, extend `defineConfig`. **Step 4: Run** the licence tests and the whole suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): offline licence keys, evaluation window and guarded writes`.

---

### Task 10: Public API surface and package check

**Files:**
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/README.md`
- Test: `packages/core/test/api.test.ts`

**Interfaces:**
- Produces the exported surface named in spec 9.3: `defineConfig`, `defineCollection`, field builders, `normalizeLocale`, `chainFor`, `migrate`, `createDocument`, `deleteDocument`, `getDocument`, `listDocuments`, `saveDraft`, `publish`, `unpublish`, `recordAiDraft`, `approve`, `approveClean`, `resolve`, `resolveReference`, `getSyncState`, `trackFields`, `createRelease`, `addToRelease`, `publishRelease`, `hashValue`, `normalizeValue`, `verifyKey`, `getLicenceState`, `assertLicensed`, the error classes including `LicenceError`, and the `Ctx`, `MoggingConfig`, `Field`, `DocumentRecord`, `Snapshot` and `LicencePayload` types. `encodeKey` is NOT exported from the package; it lives in `tools/licence/`.

- [ ] **Step 1: Write the failing test** that imports each name from `@mogging/core` and asserts `typeof === "function"` (or class).
- [ ] **Step 2: Run** (FAIL). **Step 3: Export everything from `index.ts`; write the README** (install, `DATABASE_URL`, a 15-line example that defines a collection, migrates, saves, publishes and resolves). **Step 4: Run the whole suite and typecheck**: `pnpm test && pnpm typecheck`. Expected: all PASS, no type errors.
- [ ] **Step 5: Commit** `feat(core): public API surface and README`.

---

## Self-review notes (run on 2026-11-11)

- Spec coverage for this plan's scope: 6.1 to 6.4, 6.6, 7.1 to 7.4, 8.1 (the core-side rules), 8.6 bulk approval, 8.7 trust model, 9.3 SDK: each has a task. Deferred to plans 2 to 4 by design: 6.5 and 9.4 (markdown), 8.2 to 8.5 (pipeline, providers, validation, budgets), 9.2 (CLI), 6.7 adopter-level migrations (engine migrations only here).
- Type consistency: `Ctx`, `Field`, `MoggingConfig`, `chainFor`, `hashValue`, `normalizeValue` are defined in Tasks 3 to 5 and used by the same names afterwards.
- Review Focus items 1 to 5 are pinned in Tasks 3, 5, 7, 5 and 4 respectively.
- Proportion: the plan is shorter than the spec; code appears only as test assertions.

## Review ledger

Agy panel round 1 on this plan (2026-11-11), five seats, 5 findings, all verified against the text:

- FOLDED: `getDocument` and `listDocuments` (spec 9.3) were missing, which would have blocked the
  importer, the AI worker and the CLI; added to Task 7 with `DocumentRecord` and `Snapshot` types,
  and to Task 10.
- FOLDED: `recordAiDraft` and `approve` did not name the `documents` row lock; added, with a
  concurrency test against `saveDraft` (Task 6B).
- FOLDED: `publish` rejected republishing an unpublished row and allowed any historical version;
  rule rewritten with the republish case and tests for both (Task 6A).
- FOLDED: Task 5's column list omitted `warnings`; added.
- FOLDED: `saveDraft` did not say replace or merge; it replaces (Task 5).
- FOLDED (open question): Task 6 split into 6A publish and 6B approval so a reviewer can accept one
  without the other.
- FOLDED (peer discarded it, Claude disagreed): `withTestDb` smoke test now asserts the schema is
  dropped (Task 1).
- DISCARDED-BELOW-FLOOR, accepted: `required` validation ergonomics (spec 10 leaves field-builder
  ergonomics to the builder).

Revision after the owner's ruling "every company pays" (spec section 12, 2026-11-11): Global
Constraints licence lines replaced; Task 1 ships `LICENSE.md` (draft custom text), `CLA.md` and
`CONTRIBUTING.md` instead of MIT; new Task 9B adds offline Ed25519 key verification, the 30-day
evaluation window from the migrations table, and `assertLicensed` as the first statement of every
guarded write; Task 10 exports the licence functions and types. Agy's round-8 amendment named
"Task 2" and "Task 6" for this work; those were the spike and the publish task, so the work is a
task of its own.
