# Post-plan-7 debt (plan 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four `TODO.md` items by three engine changes: the slug advisory lock follows the engine tables and skips collections it cannot guard (C), the next draft after a reject builds on the newest non-AI row (B), and a reviewer can see and supply a required localized field the AI never drafts (A).

**Architecture:** No DDL. C changes one internal helper and its three callers. B changes the same `order by` in two queries. A adds `DraftReview.missing` to core, one provenance row per reviewer-supplied field in `approve`, a remedy suffix on the publish error, and the CLI paths (render, edit file, notice) that read and write it.

**Tech Stack:** TypeScript (ESM, NodeNext), postgres.js, vitest; pnpm workspace `@mogging/core` and `@mogging/cli`.

**Spec:** `docs/superpowers/specs/2026-11-18-post-plan7-debt-design.md` (approved 2026-11-18; panel rounds 1 and 2 folded). Base: main `284335e`.

## Global Constraints

- No change to `packages/core/migrations/0001_engine.sql`. A `content_provenance` row with `field_path` set and `model_id` `'human:approve'` is legal (no check constraints, read from the migration).
- JSDoc (summary, params, returns, throws) on every exported function and type you add or change. Relative imports end in `.js`; type-only imports use `import type`.
- Commit subjects are `type(scope): summary`; end every commit message with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never insert `--` after `test` or `dev`. Run tests from the repo root. On the owner's machine export first: `export DATABASE_URL=postgres://mogging:mogging@127.0.0.1:54329/mogging_test` (a `password authentication failed` error means a wrong URL, not a regression).
- Baseline: `pnpm test` passes 1790 tests and `pnpm typecheck` is clean on `284335e`. After every task both stay green. Never push.
- A new type export needs no `api.test.ts` value pin, but Task 3 adds the type to `packages/core/test/api.test.ts` (the existing type-usage lines at `:4` and `:57-58`).
- Lock order is unchanged (AGENTS.md): `ai_budgets`, `ai_jobs`, `documents`, then the slug lock.

## Review Focus

1. A required localized field missing from a SOURCE-locale draft head: `missing` lists it, with `source` the source locale's own published value, or `undefined` when it has no published head (Task 3 test (c) uses the latter).
2. A document whose collection the config no longer declares: `missing` is `[]` and `lockSlugs` takes no lock (Tasks 1 and 3 tests).
3. A reviewer leaves a missing-field section untouched, or supplies `null`: no edit, and `null` is a `UsageError` (Task 4 tests).
4. A JSON edit file supplies `0`, `false` or `""` for a missing field: each is a value, none is dropped (Task 4 tests).
5. `approve` of a draft that still lacks a required field succeeds and prints the notice; `publish` then refuses with the remedy (Tasks 3 and 4 tests).

## Execution notes

Worktree `.worktrees/post-plan-8`, branch `feat/post-plan-8` off main `284335e`. Tasks run in order (3 consumes nothing from 1 and 2, but 4 consumes 3). Tier per CLAUDE.md: Tasks 1 and 2 Sonnet (contained edits with pinned tests); Tasks 3 and 4 Sonnet with an Opus whole-branch review at the end (money-free, but they change a public type and the reviewer-facing contract). Every implementer dispatch carries: Step 0 open the cited files and confirm the quoted lines, else reply `STATE_MISMATCH: <what>`; stop with `[original] -> [yours] because <reason>` if a stored or wire value would change shape; the named test is the oracle, never edit it to match the code.

---

### Task 1: Slug lock follows the engine tables and skips what it cannot guard (item C)

**Files:**
- Modify: `packages/core/src/documents/slugGuard.ts:16-20` (`lockSlugs`)
- Modify: `packages/core/src/documents/saveDraft.ts:98`, `packages/core/src/documents/publishCore.ts:98`, `packages/core/src/releases/releases.ts:215` (the three callers)
- Test: `packages/core/test/slugGuard.test.ts` (key helper at `:235-239`, holder at `:254`; new tests appended)
- Modify: `TODO.md` (delete the two bullets starting "the advisory slug-lock key" and "the slug lock is taken for slug-less collections too", under "Plan 6a follow-ups")

**Interfaces:**
- Produces: `lockSlugs(tx: Tx, ctx: Ctx, collections: string[]): Promise<void>`. For each distinct name in `collections`, sorted, that `ctx.config.collections` declares AND whose `fields` has an own key `slug` (the predicate of `assertSlugFree`, `slugGuard.ts:41`), it runs
  ``select pg_advisory_xact_lock(hashtext('mogging_slug:' || 'documents'::regclass::oid::text || ':' || ${name}::text))``. Other names are skipped. Not exported from `index.ts`.

- [ ] **Step 1: Update the two existing key expressions and write the failing tests.** In `slugGuard.test.ts` change `keyOf` (`:235`) and the holder statement (`:254`) to the new expression above. Append four tests, using `extraConnection(sql)` from `fixtures.ts` for same-schema connections, and these helpers:

```ts
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** "blocked" while `p` is still pending after `ms`, else "done". */
const settled = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => "done" as const), sleep(ms).then(() => "blocked" as const)]);
const LOCK = (name: string) =>
  `select pg_advisory_xact_lock(hashtext('mogging_slug:' || 'documents'::regclass::oid::text || ':' || '${name}'))`;
/** Holds the slug lock of `name` on `conn` until `release()`; resolves once it is held. */
async function hold(conn: Sql, name: string): Promise<{ release: () => void; done: Promise<unknown> }> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let held!: () => void;
  const holding = new Promise<void>((r) => { held = r; });
  const done = conn.begin(async (tx) => { await tx.unsafe(LOCK(name)); held(); await gate; });
  await holding;
  return { release, done };
}
```

Tests (each wraps in `withTestDb`, `setup(sql)`, ends its extra connections and drops any schema it created in `finally`):
  1. `"the slug lock key follows the table a search_path resolves, not current_schema()"`: create schema `${s}_e` (empty, `s` from `select current_schema()`); open a connection with `postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: \`${s}_e,${s}\` } })`; `hold(thatConnection, "A")`; open a dedicated saver connection `saver = await extraConnection(sql)` and read its pid FIRST (`select pg_backend_pid()`, because a busy connection cannot run another query); start `saveSlug(ctxFor(saver), docOfA, "x")` on collection `"A"` (a document made with `newDoc(ctx, "A")`); poll from `sql`, every 50 ms for at most 5 s, until `pg_locks` shows that pid waiting (`granted = false`, `locktype = 'advisory'`) for the new key of `"A"` (the `lockState` query at `:236-247`, with the key of Step 1), and `expect` it did; `release()`; `await saving`. Waiting is observed in Postgres, so a slow machine cannot turn the wrong key into a pass.
  2. `"engines in different schemas do not wait on each other"`: create schema `${s}_o`, a connection on it, `migrate` it, `createDocument` of `"A"` there; `hold(sql-side extraConnection, "A")` in schema `s`; `saveSlug(ctxFor(otherConn), otherDoc, "x")` must satisfy `expect(await settled(it, 10000)).toBe("done")`; then release.
  3. `"a collection with no slug field takes no slug lock"`: `hold(extra, "plain")`; `saveDraft(ctx, { docId: plainDoc, locale: "shared", data: { code: "c" } })` with `plainDoc = await newDoc(ctx, "plain")`; `expect(await settled(it, 10000)).toBe("done")`; release.
  4. `"a collection the config does not declare takes no slug lock"`: `rawDraft(sql, uid(9, 1), "gone", "g")` (`:34`, `uid` at `:41`); `hold(extra, "gone")`; `publish(ctx, { docId: uid(9, 1), locale: "shared" })`; `expect(await settled(it, 10000)).toBe("done")`; release.

- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @mogging/core test slugGuard`. Expected: the existing lock-order test and the four new ones FAIL (the old key does not match the new expression; tests 3 and 4 hang to "blocked").
- [ ] **Step 3: Implement** the signature above in `slugGuard.ts` (update the JSDoc: key scoped by the `documents` table oid, skip rule, `@param ctx`) and pass `ctx` at the three call sites (`saveDraft.ts` and `publishCore.ts` have `ctx` in scope; in `releases.ts:215` `ctx` is `publishRelease`'s argument).
- [ ] **Step 4: Run** `pnpm --filter @mogging/core test slugGuard` then `pnpm --filter @mogging/core test releases` then `pnpm --filter @mogging/core test publish`. Expected: all pass (the existing 10-round opposite-order release test still passes).
- [ ] **Step 5: Delete the two TODO bullets, run `pnpm typecheck`, commit** `fix(core): scope the slug lock to the engine tables and skip slug-less collections`.

---

### Task 2: The next draft after a reject builds on the newest non-AI row (item B)

**Files:**
- Modify: `packages/core/src/documents/recordAiDraft.ts:91` and the comment above it (`:81-84`)
- Modify: `packages/core/src/documents/saveDraft.ts:124` and the comment above it (`:118-120`)
- Test: `packages/core/test/rejectDraft.test.ts` (two tests appended after the test at `:186-197`)
- Modify: `docs/CONTENT_ARCHITECTURE.md:388-390`, `docs/superpowers/specs/2026-11-11-moggingcms-core-design.md:207-209`, `TODO.md` (delete the bullet starting "`@mogging/core` `recordAiDraft` in a PUBLISHED locale")

**Interfaces:** no signature changes. Both queries become `order by is_head_draft desc, version desc limit 1` over the same candidates (`is_head_draft or state <> 'DRAFT_AI'`).

- [ ] **Step 1: Write the two failing tests** in `rejectDraft.test.ts` using its `setup`, `draft`, `headData` helpers. Sequence (measured on the current code on 2026-11-18, `"Hallo"` today where `"Neu"` is wanted):

```ts
/** de: v2 PUBLISHED (title Hallo), v3 AI (title Neu, hash "h-old"), v4 APPROVED, v5 AI supersedes v4, v5 rejected. */
async function approvedNewerThanPublished(sql: Sql) {
  const s = await setup(sql);                                    // v1 DRAFT_AI
  await approve(s.ctx, { docId: s.docId, locale: "de" });        // v2 APPROVED
  await publish(s.ctx, { docId: s.docId, locale: "de" });        // v2 PUBLISHED head
  await recordAiDraft(s.ctx, { docId: s.docId, locale: "de", fields: { title: "Neu" }, sourceVersion: 1,
    sourceHashes: { title: "h-old" }, provenance: [prov("title")] });   // v3
  await approve(s.ctx, { docId: s.docId, locale: "de" });        // v4 APPROVED, newer than the published v2
  await s.draft({ title: "AI2" });                               // v5 supersedes v4
  await rejectDraft(s.ctx, { docId: s.docId, locale: "de" });    // no draft head; v4 is a non-head APPROVED row
  return s;
}
```
  1. `"redraft after reject in a published locale starts from the approved row that is newer than the published head"`: `await draft({ body: md("B2") })` returns `{ version: 6 }`; `(await headData(sql, docId)).data` equals `{ title: "Neu", body: md("B2") }`; the v6 `source_hashes.title` is `"h-old"`; the v6 provenance rows all have `superseded_version` null.
  2. `"saveDraft after that reject carries the approved row's hash forward"`: `saveDraft(ctx, { docId, locale: "de", data: { title: "Neu", body: md("Welt") } })`; the draft head `source_hashes` equals `{ title: "h-old", body: hashes.body }` (before the change: `{ title: hashes.title, body: hashes.body }`).
- [ ] **Step 2: Run** `pnpm --filter @mogging/core test rejectDraft`. Expected: the two new tests FAIL, all others pass.
- [ ] **Step 3: Change both queries** as in Interfaces; update both comments to say "the newest row that is not a DRAFT_AI by version (a draft head wins), so a published and a never-published locale behave alike (spec 8.1)".
- [ ] **Step 4: Run** `pnpm --filter @mogging/core test rejectDraft`, `... test saveDraft`, `... test approve`, `... test lifecycle`. Expected: all pass, including `"redraft after reject restarts from the approved predecessor"`, `"redraft after unpublish still starts from the published row"` and `"redraft after reject and unpublish still starts from the published row"`.
- [ ] **Step 5: Docs.** `CONTENT_ARCHITECTURE.md:388-390` gains: the next draft after a reject starts from the newest non-AI row (the superseded APPROVED draft when one exists), never from a rejected AI row. The design doc `:207-209` gets the same sentence after "regenerate it". Delete the TODO bullet. `pnpm typecheck`. Commit `fix(core): build the next draft on the newest non-AI row after a reject`.

---

### Task 3: Core: `DraftReview.missing`, reviewer-supplied provenance, publish remedy (item A, core half)

**Files:**
- Modify: `packages/core/src/read/review.ts` (`DraftReview` type at `:32-43`, `getDraftReview` at `:122-204`)
- Modify: `packages/core/src/index.ts:38` (export `ReviewMissing`)
- Modify: `packages/core/src/documents/approve.ts:151-165` (provenance loop)
- Modify: `packages/core/src/documents/publishCore.ts:83-92` (message)
- Modify: `packages/core/test/fixtures.ts` (add `catalog`, `catalogConfig`, `catalogCtx`)
- Test: `packages/core/test/review.test.ts`, `packages/core/test/approve.test.ts`, `packages/core/test/publish.test.ts`, `packages/core/test/api.test.ts`
- Modify: `docs/API_INTEGRATION.md:205-211`, `docs/CONTENT_ARCHITECTURE.md:94` and `:401`

**Interfaces:**
- Produces: `export type ReviewMissing = { path: string; source: unknown }`; `DraftReview` gains `missing: ReviewMissing[]` (never absent; `[]` when nothing is missing).
- Rule: for the draft head of `(doc, locale)`, `missing` holds every field of the document's collection that satisfies the predicate of `publishCore.ts:86` with `isShared = false` (`f.required && f.localized`) and has no own key in the head's `data`; sorted by path; `source` is the source head's value for that path, else `undefined`; `[]` when the config does not declare the collection. Any locale `getDraftReview` accepts, the source locale included.
- Produces (approve): for each key of `edits` with no `content_provenance` row of the AI version (`field_path = key`), one extra row after the existing loop: `version` = the new version, `field_path` = key, `model_id` `'human:approve'`, `prompt_version` `''`, tokens and cost `0`, `edited` true, `discarded` false, `warnings` bound as the empty array `[]` (as `recordAiDraft.ts:136` binds `p.warnings ?? []`; the column is `text[]`), `acknowledged_warnings` = `ack`, `bulk_id` = `input.bulkId ?? null`, `approved_by` = actor, `approved_at` and `created_at` = `t`; `superseded_version`, `call_id`, `job_id` null.
- Produces (publish): when the scope is a target locale (`!isShared && locale !== ctx.config.locales.source`) the message gets the suffix ` (an AI draft never carries a field it cannot translate; supply it with an approve edit or saveDraft)` after the field list. Source-locale and shared messages are unchanged.
- `catalog` fixture: `defineCollection("items", { slug: slug(), title: text({ localized: true }), price: number({ localized: true, required: true }) })`; `catalogConfig = defineConfig({ collections: [catalog], locales: { source: "en", chains: { de: ["en"] } } })`; `catalogCtx(sql, actor = "tester"): Ctx` = `{ sql, config: catalogConfig, actor }`.

- [ ] **Step 1: Failing tests.**
  - `review.test.ts`: (a) `"getDraftReview lists a required localized field the draft lacks, with its source value"`: catalog doc, `saveDraft` en `{ title: "Intro", price: 10 }`, publish en, AI draft de `{ title: "Einleitung" }` with `sourceHashes: { title: hashValue("Intro") }`; `review.missing` toEqual `[{ path: "price", source: 10 }]` and `review.fields.map((f) => f.path)` toEqual `["title"]`. (b) `"missing is empty once the field is in the draft"`: AI draft de `{ title, price: 12 }` gives `[]`. (c) `"a source-locale draft head lists its missing required field, source undefined"`: `saveDraft` en `{ title: "Intro" }` only; `getDraftReview(ctx, { docId, locale: "en" })` gives `[{ path: "price", source: undefined }]`. (d) `"a collection the config no longer declares has no missing list"`: same doc as (a) read with `{ ...ctx, config }` (the fixtures `config`, which lacks `items`): `missing` toEqual `[]`.
  - `approve.test.ts`: `"approve with an edit for a field the draft lacks writes an edited human:approve provenance row"`: draft as (a); `approve(ctx, { docId, locale: "de", edits: { price: 12 } })`; the APPROVED head `data.price` is `12`; `content_provenance` rows of the new version: exactly one `field_path = 'price'` row matching `{ model_id: "human:approve", prompt_version: "", prompt_tokens: 0, completion_tokens: 0, cost_micros: "0", edited: true, approved_by: "<actor>", bulk_id: null }` and exactly one `field_path = 'title'` row with `edited: false`; `getDraftReview` of the APPROVED head has `missing` `[]` and `fields.find(f => f.path === "price")!.edited` true. Second test `"approve edits an AI-drafted field without an extra row"`: edit `title` only, one row per field_path.
  - `publish.test.ts`: `"publish of a target-locale draft names the remedy for a field the AI never drafts"`: draft as (a), `approve` with no edits, `publish(ctx, { docId, locale: "de" })` rejects with a `ValidationError` whose message contains `missing required field price` and `approve edit or saveDraft`; and the source-locale message of the existing test at `:248-258` (re-read its message) does not contain `approve edit`. Also an end-to-end test `"supplying the field through approve lets the locale publish"`: approve with `edits: { price: 12 }` then `publish` resolves, `getDocument` shows `de` published with `price` 12.
  - `api.test.ts`: add `ReviewMissing` to the type import at `:4` and `const missing: Pick<ReviewMissing, "path"> = { path: "price" };` next to `:58`; extend the `Pick<DraftReview, "fields">` at `:57` to `"fields" | "missing"`.
- [ ] **Step 2: Run** `pnpm --filter @mogging/core test review`, `... approve`, `... publish`, `... api`. Expected: the new tests FAIL (compile or assertion), everything else passes.
- [ ] **Step 3: Implement** the three Interfaces. In `getDraftReview` reuse `srcData` (`:158`) and `data` (`:155`); look the collection up with `config.collections.find((c) => c.name === doc.collection)`. Update JSDoc of `getDraftReview`, `approve` (its remarks list the new provenance row) and the `DraftReview` fields.
- [ ] **Step 4: Run** `pnpm --filter @mogging/core test` (whole package). Expected: all pass; the existing exact-substring assertions at `publish.test.ts:252,264,287,315,334` and `releases.test.ts:675` still pass (the suffix follows the field list).
- [ ] **Step 5: Docs.** `API_INTEGRATION.md:205-211`: add `missing` to the per-field comment and one sentence (what it lists, `[]` when none, source locale included). `CONTENT_ARCHITECTURE.md:94`: after "Drafts may be incomplete." add that the review lists a required localized field a draft lacks and that an AI draft never carries a field it cannot translate; `:401`: add that the refusal names the remedy for a target locale. `pnpm exec tsc --noEmit -p packages/core` (the root `pnpm typecheck` fails in `packages/cli` until Task 4 gives the CLI tests' `DraftReview` builders the new required `missing`). Commit `feat(core): list a required localized field a draft lacks and record a reviewer-supplied one`.

---

### Task 4: CLI: show, fill and announce the missing fields (item A, CLI half)

**Files:**
- Modify: `packages/cli/src/render.ts` (`renderDraftReview` at `:90` to the end of the file; new `missingNotice`)
- Modify: `packages/cli/src/editFile.ts` (`fieldNames` `:11-15`, `serializeEditFile` `:21-37`, `edited` `:39-48`, `parseEditFile` `:54-81`, `parseJsonEditFile` `:83-103`, `applyEdits` `:105-110`)
- Modify: `packages/cli/src/commands/review.ts` (interactive `attempt` at `:256`; flag-form approve result at `:531`; new helper `missingLines`)
- Modify: `packages/cli/test/fixtures.ts` (add `catalogConfig`, `catalogDoc`)
- Test: `packages/cli/test/editFile.test.ts`, `render.test.ts`, `review.test.ts`, `reviewInteractive.test.ts`
- Modify: `packages/cli/README.md:116-135` ("The edit file") and the JSON note at `:183`, `docs/superpowers/specs/2026-11-11-moggingcms-core-design.md:635` (F4 note), `TODO.md`

**Interfaces:**
- Consumes (Task 3): `DraftReview.missing: ReviewMissing[]`.
- Produces `missingNotice(missing: ReadonlyArray<{ path: string }>): string[]` in `render.ts`: `[]` when empty, else one line `! required, not drafted: <paths joined ", ">; publish refuses this locale until they are supplied` (each path through `escapeControl`).
- Produces in `renderDraftReview`: after the field blocks, for each `review.missing` entry in order the lines `""` then `! required, not drafted: <path> (source: <text>)` where `<text>` is `valueText(source, kindOf(kinds, path))` with every whitespace run collapsed to one space, trimmed, then `escapeControl`ed (an absent source prints `(none)`).
- Produces edit-file behaviour: `fieldNames` returns a third set `missing` (the paths of `review.missing`). The text file ends with one section `=== <path> ===` followed by an empty body for each missing path, in `review.missing` order, never prefilled. A header is recognised when the name is in `all` or `missing`; the duplicate-header and header-lookalike checks cover both. For a missing path: an empty or whitespace-only body is no edit; kind `text` gives the body as a string; kind `richText` gives `markdownToTree(body, { mode: "md" })`; any other kind gives `JSON.parse(body)` and an invalid body throws `UsageError` whose message matches `/field <path>.*JSON/`. In the JSON form a missing path of kind `text` or `richText` must be a string (`""` is a value), any other kind takes any JSON value except `null`, and `null` throws `UsageError`; existing editable fields keep today's rules. A present non-text field stays `not an editable field of this draft`.
- Produces `applyEdits(review, edits)`: a key that is a missing path becomes a `ReviewField` (`source` from the missing entry, `previous` undefined, `previousFrom` null, `warnings` `[]`, `edited` true, `sourceChanged` false, `draft` the value), is removed from `missing`, and `fields` stays sorted by path.
- Produces `missingLines(ctx: Ctx, docId: string, locale: string): Promise<string[]>` in `commands/review.ts`: `missingNotice(review.missing)` of `getDraftReview(ctx, { docId, locale })`; `[]` when it throws a `NotFoundError` (by `name`, as `nameOf` at `:109` does).

- [ ] **Step 1: Failing tests.** First give both `DraftReview` builders `missing: []` (`editFile.test.ts:14`, `render.test.ts:15`, with an `over`/parameter to override). Then:
  - `editFile.test.ts`, new `describe("missing required fields")` with `kinds = { title: "text", price: "number", note: "richText" }`: (1) `serializeEditFile` of a review with `missing: [{ path: "price", source: 10 }]` ends with a `=== price ===` section with no body text, and `parseEditFile(serialize(...), review, kinds)` returns `{}`. (2) A `price` body `12` returns `{ price: 12 }`; a body `0` returns `{ price: 0 }`; `false` returns `{ price: false }`; `abc` throws `UsageError` matching `/field price.*JSON/`. (3) A missing `title` (text) body `Hallo` returns `{ title: "Hallo" }`; a missing `note` (richText) body `Hi` returns `{ note: markdownToTree("Hi", { mode: "md" }) }`. (4) JSON form: `{"price":12}`, `{"price":0}`, `{"price":false}` return those values; `{"title":""}` returns `{ title: "" }`; `{"price":null}` and `{"title":5}` throw `UsageError`; `{"price":12}` against a review where `price` is NOT missing and not in `fields` throws "not an editable field". (5) `applyEdits` with `{ price: 12 }` moves `price` from `missing` to `fields` (edited true, source 10) and keeps `fields` sorted.
  - `render.test.ts`: `renderDraftReview` of a review with `missing: [{ path: "price", source: 10 }, { path: "sku", source: undefined }]` contains exactly the lines `! required, not drafted: price (source: 10)` and `! required, not drafted: sku (source: (none))`; `missingNotice([])` is `[]`; `missingNotice([{ path: "price" }, { path: "sku" }])` is `["! required, not drafted: price, sku; publish refuses this locale until they are supplied"]`.
  - `review.test.ts` (end to end, `testDeps(sql, { loadModule: async () => ({ config: catalogConfig, ai }) })`, a `catalogDoc(sql)` helper that publishes an `items` document in `en` with `price: 10` and records an AI draft for `de` with only `title`): (a) `review show --json` `data.missing` toEqual `[{ path: "price", source: 10 }]`; (b) `review approve ... --edit-file x.json` with `{"price":12}` exits 0, prints the `approved` line and no `required, not drafted` line, and a following core `publish` of `de` succeeds; (c) `review approve` with no edit exits 0 and prints the `approved` line followed by the notice line for `price`.
  - `reviewInteractive.test.ts`: modelled on the test at `:147`, answering `a` for a draft that lacks `price` prints `approved ...` then the notice line.
- [ ] **Step 2: Run** `pnpm --filter @mogging/cli test editFile`, `... render`, `... review`. Expected: new tests FAIL, others pass (after the builders gain `missing: []`).
- [ ] **Step 3: Implement** the Interfaces. Reuse `kindOf` and `valueText` from `render.ts`. Call `missingLines` after a successful `approve` in the interactive `attempt` (only when `done === "approved"`, appended via `say`) and in the flag-form result's `lines` (`data` stays `{ version }`).
- [ ] **Step 4: Run** `pnpm --filter @mogging/cli test` then the whole suite `pnpm test` and `pnpm typecheck`. Expected: every test passes (1790 baseline plus the new tests), typecheck clean.
- [ ] **Step 5: Docs and TODO.** README "The edit file": a paragraph on missing required fields (sections appear for them, empty means no change, a number or boolean is JSON, an empty string needs the JSON form, `null` is refused) and the JSON-output note gains `missing`. Design doc `:635` F4 note gains "a required one is supplied by the reviewer (plan 8)". `TODO.md`: delete the bullet starting "`@mogging/ai` an AI draft carries only translatable fields"; add `- [ ] \`@mogging/core\` \`approveClean\` approves a warning-free draft that lacks a required localized field without surfacing it (the review lists it, bulk approval does not), so \`publish\` refuses it later: decide whether \`review --approve-clean\` should skip or report such drafts. Recorded 2026-11-18, plan 8.`. Commit `feat(cli): show, fill and announce a required field the AI never drafted`.
- [ ] **Step 6: Final gate.** `pnpm smoke:pack` is NOT required (no packaging change). Run the whole-branch review, then the capstone and test audit per the project's gates (owner-triggered).

---

## Self-review (done before handoff)

- **Spec coverage:** item C (key, skip, signature, undeclared collection) is Task 1; item B (both queries, null `superseded_version` pinned by Task 2 test 1) is Task 2; item A points 1 to 4 and 3a are Tasks 3 and 4 (point 1 `missing` incl. source locale and `[]` default; point 2 CLI show, notice, empty-section rule, empty string via JSON, present list/object not editable, the `editFile.ts` sites `edited`, `fieldNames`, `applyEdits`, renderer, `parseJsonEditFile`; point 3 remedy; 3a provenance row; point 4 docs). The design's "Left to the plan" items: edit-file syntax (Task 4 Interfaces), `review show` layout (Task 4 render lines), test names and oracles (each task), api pin (Task 3), TODO ticks (Tasks 1, 2, 4).
- **Citations:** every `file:line` here was read on `284335e`; the B sequence and the `"Hallo"` baseline were measured with a throwaway test on 2026-11-18, and the lock-key behaviour (table oid constant across `search_path`, `current_schema()` not) was measured on Postgres in the same session.
- **Placeholders:** none. Remaining judgement calls for the implementer, all inside a named contract: exact wording of JSDoc, the `UsageError` message tails beyond the matched fragments, and the order of the two new `describe` blocks.
- **Known gaps recorded:** `approveClean` surfacing is a TODO bullet (Task 4 Step 5), not in scope.
