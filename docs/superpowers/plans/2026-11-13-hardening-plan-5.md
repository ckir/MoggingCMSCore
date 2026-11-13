# Pre-ship hardening (plan 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six pre-ship items of the v0.1 ship order (U+0000, `pollMs`, `listProvenance` paging, rejected-draft resurfacing, `release remove`, `listDraftHeads` cursor docs) before the first publish, with no schema change.

**Architecture:** Six small, independent edits to existing code in `@mogging/core`, `@mogging/ai` and `@mogging/cli`; the only new public surface is the SDK function `removeFromRelease` and the CLI verb `release remove`. Each edit is test-first; documentation moves with the code it describes.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), pnpm workspace, vitest, postgres.js, a private test Postgres.

**Spec:** `docs/superpowers/specs/2026-11-13-v01-ship-sequencing-design.md` (the order and the admission rule); core design `docs/superpowers/specs/2026-11-11-moggingcms-core-design.md` (sections 8.1, 9.2, 9.3, 12.3). The owner's fork rulings of 2026-11-13 are recorded under "Decisions" below.

## Decisions (owner, 2026-11-13, after an agy-first consult; seam `.clavity/seams/plan5-forks-first.md`, reply `.clavity/scratch/plan5-forks/notes.md`)

- **F1:** `listProvenance` orders by `id` only; signature and return type unchanged.
- **F2:** `removeFromRelease(ctx, { releaseId, docId, locale })`, not licence-guarded, refuses a published release, `NotFoundError` when the item is absent, no `--stale` selector, an emptied release stays, a removal records nothing (the actor travels in `ctx` like every write; spec 9.3 gets an explicit exception).
- **F3:** the `recordAiDraft` base query admits only `is_head_draft or state <> 'DRAFT_AI'` rows.
- No fork: U+0000 is rejected in `nfcDeep` (strings and keys), `text`, `slug`, `reference`; `runWorker` validates `pollMs`; `listDraftHeads`' `after` is documented as opaque.

## Global Constraints

- `TODO.md` is edited by bullet text, never by line number: each task deletes a bullet, so line numbers move.
- No schema change: `packages/core/migrations/0001_engine.sql` is NOT edited in this plan.
- The licence-guarded set is exactly `saveDraft`, `recordAiDraft`, `approve` (and `approveClean`), `publish`, `publishRelease`, `compile` (design 12.3). `removeFromRelease` is NOT guarded.
- Every operation is an SDK function before it is a CLI verb. CLI exit codes: `0` ok, `1` error, `2` usage, `3` licence refusal, `4` partial failure (spec 9.2, plan 4).
- Error classes are matched by `name` in the CLI (`isRefusal`), never `instanceof`.
- Test command for one file: `DATABASE_URL=postgres://mogging:mogging@127.0.0.1:54329/mogging_test pnpm vitest run <file>`; whole suite: the same prefix with `pnpm test`; types: `pnpm typecheck`. Baseline measured on main at 40df90a: 1115 passed, 1 skipped (1116), typecheck clean.
- Work on a branch `feat/hardening-plan-5` in a worktree, never on `main`. Nothing is pushed.
- End every commit message with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Nothing may be added to this plan's scope without an owner ruling (design doc, admission rule).

## Review Focus

1. A U+0000 inside a `richText` object KEY (not only a leaf string): must be a `ValidationError`, not a database error (Task 1).
2. `removeFromRelease` on an item whose document was soft-deleted: this is the repair path, so it must succeed, in the SDK (Task 5) and through the CLI target syntax (Task 6).
3. A release emptied by removals, then published: `publishRelease` still refuses it with its existing "empty" error (Task 5).
4. Reject, then redraft, where the rejected draft had superseded an `APPROVED` draft: the next draft carries the approved text and none of the rejected text (Task 4).
5. `listProvenance` with `afterId: 0`, and rows whose `created_at` order differs from their `id` order: no row skipped, none repeated (Task 3).
6. `runWorker` `pollMs` of `0`, `NaN`, `-1`, `1.5`, `Infinity`, `2147483648`: each a `ValidationError`, never a busy loop (Task 2).

---

### Task 1: Reject U+0000 in normalizeValue

**Files:**
- Modify: `packages/core/src/values/normalize.ts` (`nfcDeep` at line 10, `normalizeAt` at line 26 with cases `text` 28-30, `slug` 31-33, `reference` 48-50)
- Test: `packages/core/test/values.test.ts`, `packages/core/test/saveDraft.test.ts`, `packages/markdown/test/import.test.ts` (the test at line 301 and one new test)

**Interfaces:**
- Consumes: `ValidationError` from `packages/core/src/errors.ts` (already imported in normalize.ts).
- Produces: `normalizeValue` throws `ValidationError` with a message ending `: contains U+0000` for any string value or object key containing `\u0000` in `text`, `slug`, `reference` and `richText` (every nested string and key). Other control characters stay legal. No signature change.

Why: Postgres `jsonb` rejects `\u0000`, so `saveDraft` fails at the database with a driver error instead of a `ValidationError` (TODO.md, captured 2026-11-12).

- [ ] **Step 1: Write the failing tests** in `values.test.ts`:

```ts
test("U+0000 is rejected in text, slug, reference and every richText string and key", () => {
  expect(() => normalizeValue(text(), "a\u0000b")).toThrow(/contains U\+0000/);
  expect(() => normalizeValue(slug(), "a\u0000b")).toThrow(/contains U\+0000/);
  expect(() => normalizeValue(reference("posts"), "a\u0000b")).toThrow(/contains U\+0000/);
  expect(() => normalizeValue(richText(), "a\u0000b")).toThrow(/contains U\+0000/);
  expect(() => normalizeValue(richText(), { children: [{ text: "a\u0000b" }] })).toThrow(/contains U\+0000/);
  expect(() => normalizeValue(richText(), { "k\u0000": 1 })).toThrow(/contains U\+0000/);
});
test("other control characters stay legal", () => {
  expect(normalizeValue(text(), "a\u0001b\tc")).toBe("a\u0001b\tc");
});
```

and in `saveDraft.test.ts` one test (same style as its neighbours) asserting `saveDraft(ctx, { docId, locale: "en", data: { title: "a\u0000b" } })` rejects with `ValidationError` and writes no row.

- [ ] **Step 2: Run both files; the new tests fail** (`Expected ... ValidationError`, the saveDraft one with a Postgres error).
- [ ] **Step 3: Implement** a module-private `rejectNul(s: string, path: string): void` in `normalize.ts` that throws `new ValidationError(`${path}: contains U+0000`)`; call it on every string in `nfcDeep` (before `normalize`), on every object key in `nfcDeep` (path `${path}.${k}`), and in the `text`, `slug` and `reference` cases.
- [ ] **Step 4: Update the markdown import test** `target-file error keeps the docId` (`packages/markdown/test/import.test.ts:301`). Its NUL title now fails in the SCAN (`import.ts:183`), before pass 2, so `de.docId` would be `null` and the test would pass for the wrong reason or fail. Keep its assertions (the `de` file's outcome is `"error"` and `de.docId` equals the source document's id) and change only how the pass-2 failure is forced: in the test body, before `importFolder`, create a database trigger through the `sql` the `setup` callback provides (the existing test names that parameter `_sql`: rename it to `sql`):

```ts
await sql`create function refuse_boom() returns trigger language plpgsql as $$ begin
  if new.data->>'title' = 'boom' then raise exception 'boom'; end if; return new; end $$`;
await sql`create trigger refuse_boom before insert on document_localized for each row execute function refuse_boom()`;
```

and give the `de` file the front matter `title: boom` instead of the NUL. The trigger lives in the test's own schema (`withTestDb`), so it cannot leak. Fix the comment above it to say the failure is a database refusal in pass 2. If `create function` lands outside the test schema (`select proname, pronamespace::regnamespace from pg_proc where proname = 'refuse_boom'`), STOP and report `STATE_MISMATCH`.
- [ ] **Step 4b: Pin the new import behaviour** with one more test in `import.test.ts`: `a U+0000 in a source file is a file error and creates no document`. Tree `{ "en/docs/a.md": '---\ntitle: "a\\0b"\n---\nx\n' }`; after `importFolder` the file's outcome is `"error"`, `r.errors[0].message` matches `/U\+0000/`, and `listDocuments(ctx, { collection: "docs" })` is empty (before this task the NUL was found only in pass 2, after pass 1 had created a document holding just its slug).
- [ ] **Step 5: Run** `pnpm vitest run packages/core/test/values.test.ts packages/core/test/saveDraft.test.ts packages/markdown/test/import.test.ts` (all pass) then `pnpm test` (whole suite green).
- [ ] **Step 6: Commit** `fix(core): reject U+0000 in normalizeValue with a ValidationError`. Delete the bullet that starts "`@mogging/core` `normalizeValue` accepts a `text`, `slug` or nested `richText` string containing U+0000" from `TODO.md` in the same commit.

---

### Task 2: Validate pollMs in runWorker

**Files:**
- Modify: `packages/ai/src/worker.ts` (import at line 2, `runWorker` body near line 81), `packages/ai/README.md:180-183`
- Test: `packages/ai/test/worker.test.ts`

**Interfaces:**
- Produces: `runWorker` rejects with `ValidationError` (`pollMs must be an integer from 1 to 2147483647, got <value>`) when `options.pollMs` is defined and is not a safe integer in `[1, 2147483647]`; `undefined` keeps the 2000 ms default. The CLI's own `--poll-ms` range (100 to 2147483647) is unchanged.

- [ ] **Step 1: Write the failing test** in `worker.test.ts`, in the style of its neighbours (`migrateAndSeed`, `ctxFor`, `withTestDb`):

```ts
test("runWorker rejects an unusable pollMs with a ValidationError", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);               // returns the seeded docId (a string), not a ctx
  const ctx = ctxFor(sql, mockModel([identity]));   // as the test at line 81 builds its ctx
  for (const pollMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    await expect(runWorker(ctx, { once: true, pollMs })).rejects.toBeInstanceOf(ValidationError);
  }
  await expect(runWorker(ctx, { once: true, pollMs: 1 })).resolves.toMatchObject({ completed: 0 });
}));
```

(`ValidationError` from `@mogging/core`. The `pollMs: 1` line is a positive control: it pins that a valid value is accepted; the rejections above it are what fail before the fix.)
- [ ] **Step 2: Run** `pnpm vitest run packages/ai/test/worker.test.ts -t "unusable pollMs"`: fails (no rejection).
- [ ] **Step 3: Implement** the check at the very top of `runWorker` (before any query), importing `ValidationError` next to `NotFoundError` at `worker.ts:2`; update the README sentence ("it polls every `pollMs` (2000 by default)") to add "an integer from 1 to 2147483647 milliseconds".
- [ ] **Step 4: Run** the worker test file (all pass; existing tests use `pollMs` 1 and 50) and `pnpm typecheck`.
- [ ] **Step 5: Commit** `fix(ai): runWorker validates pollMs`. Delete the bullet that starts "`@mogging/ai` `runWorker` passes `options.pollMs`" from `TODO.md` in the same commit.

---

### Task 3: listProvenance orders by id

**Files:**
- Modify: `packages/ai/src/provenance.ts` (doc comment at line 44, `order by` at line 64), `packages/ai/README.md:139-143`
- Test: `packages/ai/test/provenance.test.ts` (next to `listProvenance afterId returns the next page with no overlap`, line 67)

**Interfaces:**
- Produces: `listProvenance(ctx, { docId?, locale?, discardedOnly?, limit?, afterId? }): Promise<ProvenanceRow[]>` unchanged in shape; rows are now ordered by `id`, so `afterId` (the last `id` of a page) is an exact page boundary for rows visible when the page is read. `listJobs` already orders by `id` (`packages/ai/src/jobs.ts:243`). CLI call sites (`packages/cli/src/commands/provenance.ts:53-55`, `jobs.ts:15-27`) need no change.

- [ ] **Step 1: Write the failing test.** Insert two `content_provenance` rows directly with `sql` so that the lower `id` has the LATER `created_at` (the fixture in the neighbouring test shows the required columns; `model_id`, `prompt_version`, `prompt_tokens`, `completion_tokens`, `cost_micros` are not null). Assert: `listProvenance(ctx, {})` returns the ids in ascending order; `listProvenance(ctx, { limit: 1 })` followed by `listProvenance(ctx, { limit: 1, afterId: first.id })` returns both rows with none skipped; `listProvenance(ctx, { afterId: 0 })` returns both rows.
- [ ] **Step 2: Run** `pnpm vitest run packages/ai/test/provenance.test.ts`: the order test fails (rows come back by `created_at`).
- [ ] **Step 3: Implement** `order by id` at `provenance.ts:64` and rewrite the doc comment ("Provenance rows ordered by id"). In `README.md:139-143` replace "ordered by creation time, then id" and the sentence "Rows written by concurrent transactions can be created in a different order than their ids, so treat `afterId` as a way to reach rows beyond the cap, not as an exact page boundary" with: rows are ordered by `id`; `afterId` returns only rows with a greater id (pass the last `id` of a page); a transaction that commits after a page was read can add a row with a lower id than that page's last, which a later `afterId` page does not return.
- [ ] **Step 4: Run** `pnpm vitest run packages/ai/test/provenance.test.ts packages/cli/test/provenance.test.ts` (the CLI test with 1005 rows must still pass) then `pnpm test`.
- [ ] **Step 5: Commit** `fix(ai): listProvenance orders by id so afterId is an exact page boundary`. In `TODO.md` delete the sub-bullet that starts "`listProvenance` orders by `(created_at, id)` but pages by" and, in the plan 3 bullet ("`@mogging/ai` deferred Minor review findings"), the clause "`afterId` cursor on `listProvenance` pages by id while ordering is `(created_at, id)`;".

---

### Task 4: A rejected AI draft is never the base of the next draft

**Files:**
- Modify: `packages/core/src/documents/recordAiDraft.ts` (base query at lines 86-88, comment at 80-81)
- Test: `packages/core/test/rejectDraft.test.ts` (next to the test at line 108; reuse its `setup`, `prov`, `rows` helpers)

**Interfaces:**
- Produces: the base row of `recordAiDraft` is chosen by `where doc_id = ... and locale = ... and (is_head_draft or state <> 'DRAFT_AI') order by is_head_draft desc, is_head_published desc, version desc limit 1`. A non-head `DRAFT_AI` row is either superseded (its successor carried its data) or rejected; neither is a base. Behaviour for a published locale, an unpublished-after-publish locale (the `PUBLISHED` row keeps `state = 'PUBLISHED'`, `publish.ts:44`) and a draft head is unchanged. `superseded` (line 92) keeps its meaning.

- [ ] **Step 1: Write the failing tests** (three, in `rejectDraft.test.ts`):
  1. `redraft after reject carries no rejected text`: `setup` leaves a `DRAFT_AI` de v1 (`title` "Hallo", `body` "Welt"); `rejectDraft`; `recordAiDraft` with `fields: { title: "Neu" }` only; the new head's `data` is `{ title: "Neu" }` (no `body`) and its `field_warnings` is `{}`.
  2. `redraft after reject restarts from the approved predecessor`: draft v1, `approve` (v2 `APPROVED`), `recordAiDraft` `{ title: "AI" }` (v3, supersedes v2), `rejectDraft` (v3), `recordAiDraft` `{ body: "B2" }` (v4): v4's `data` is `{ title: "Hallo", body: "B2" }` (v2's title, not v3's "AI"), and its provenance row has `superseded_version = null`.
  3. `redraft after unpublish still starts from the published row`: draft, `approve`, `publish` de, `unpublish` de, `recordAiDraft` `{ title: "X" }`: the new head's `data` keeps the published `body`.
  Read the file's helper and `unpublish` signatures first; if a helper does not fit, write the rows with the SDK, not SQL, and keep the assertions above verbatim.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/rejectDraft.test.ts`: tests 1 and 2 fail, test 3 passes already (it pins existing behaviour; keep it).
- [ ] **Step 3: Implement** the `where` clause change in the base query and rewrite the comment at lines 80-81 to say why a non-head `DRAFT_AI` row is excluded.
- [ ] **Step 4: Run** `pnpm vitest run packages/core packages/ai` (recordAiDraft is exercised by many tests; all must pass) then `pnpm test`.
- [ ] **Step 5: Commit** `fix(core): a rejected or superseded AI draft is never the base of the next draft`. Delete the sub-bullet that starts "rejected-draft text can resurface in the next AI draft" from `TODO.md`.

---

### Task 5: removeFromRelease (SDK)

**Files:**
- Modify: `packages/core/src/releases/releases.ts` (new function after `addToRelease`, which ends at line 117; its comment at lines 103-104 stops saying "nothing removes an item"), `packages/core/src/index.ts` (exports at lines 41, 43-44)
- Test: `packages/core/test/releases.test.ts`, `packages/core/test/api.test.ts` (the `FUNCTIONS` array, line 14-19, is an exact-surface pin)

**Interfaces:**
- Consumes: the file's own `resolveLocale`, `releaseIdOf`, `UUID` (as `addToRelease` uses them).
- Produces: `type RemoveFromReleaseInput = { releaseId: string; docId: string; locale: string | "shared" }` (exported as a type from `releases.ts` and the type list at `index.ts:43-44`, like `AddToReleaseInput`, `releases.ts:8`) and `removeFromRelease(ctx: Ctx, input: RemoveFromReleaseInput): Promise<void>`. `locale` is a declared locale or `"shared"`. Semantics: one transaction; lock the release row `for update` (the documents row is NOT locked, so an item of a soft-deleted document can be removed); `NotFoundError` for an unknown or malformed release id and for a non-UUID `docId` (same messages as `addToRelease`); `ValidationError("release already published")` for a published release; `NotFoundError(`${docId}/${locale} is not in release ${releaseId}`)` when no item matches `(release_id, doc_id, coalesce(locale, ''))`; otherwise delete that one row. Not licence-guarded. Records nothing.

- [ ] **Step 1: Write the failing tests** in `releases.test.ts` (names are the contract; reuse `docWithSource`, `setup`):
  - `removeFromRelease removes an item and the pair can be added again at a newer version`: add de v1; `saveDraft` de (v2); `publishRelease` refuses (existing behaviour); `removeFromRelease`; `addToRelease` at v2; `publishRelease` succeeds.
  - `removeFromRelease removes a shared item` (`locale: "shared"`).
  - `removeFromRelease of an item that is not in the release throws NotFoundError` (message matches `/is not in release/`).
  - `removeFromRelease on a published release throws ValidationError "release already published"` and leaves the item.
  - `removeFromRelease validates the release id and the document id` (`"999999"`, `"abc"`, `"nope"` each `NotFoundError`; locale `"fr"` `ValidationError`).
  - `removeFromRelease works after the document was soft-deleted` (`deleteDocument`, then remove succeeds, `publishRelease` of the remaining items no longer fails on it).
  - `a release emptied by removal stays and publishRelease still refuses it` (`listReleases` shows `itemCount` 0; `publishRelease` rejects with `ValidationError` with the message `release is empty`, `releases.ts:138`).
  - `removeFromRelease is not licence-guarded` (copy the arrangement of `rejectDraft is not licence-guarded`, `rejectDraft.test.ts:101`).
  Extend the exposure test at `releases.test.ts:302` and the `FUNCTIONS` array in `api.test.ts` with `"removeFromRelease"`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/releases.test.ts packages/core/test/api.test.ts`: fails (`removeFromRelease` is not exported).
- [ ] **Step 3: Implement** `removeFromRelease` per the Interfaces block in `releases.ts`, mirroring `addToRelease`'s transaction shape (`sql.begin`, `select ... for update` on the release); export it from `index.ts` next to `addToRelease`; reword the `addToRelease` comment at lines 103-104.
- [ ] **Step 4: Run** the two files, then `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(core): removeFromRelease takes an item out of an unpublished release`.

---

### Task 6: `mogging release remove` (CLI) and the spec and README edits for it

**Files:**
- Modify: `packages/cli/src/commands/release.ts` (`VERBS` line 12, `OPTIONS_OF` 15-20, `releaseSpec` 99-170), `packages/cli/README.md` (lines 55-56 usage, 146 and 173 command lists, 248 the "No `release remove`" bullet), `docs/superpowers/specs/2026-11-11-moggingcms-core-design.md` (9.2 verb list at line 560 and the syntax block at line 593, 9.3 Writes list and the "Every write takes an actor and is recorded" sentence, 12.3 "Not guarded" list near line 712, the "Not built in v0.1" sentence at line 636)
- Test: `packages/cli/test/release.test.ts` (reuse `withDb`, `cli`, `items`, `approved`, `humanDraft`, `publishedDoc`), including the usage-error table near line 342

**Interfaces:**
- Consumes: `removeFromRelease` (Task 5); `releaseIdOf`, `resolveTarget`, `getDocument`, `labelOf`, `scopeLocale`, `isRefusal`, `refusal`, `itemsResult`, `Item` as `release add` uses them.
- Modifies: `resolveTarget(ctx, text, options?: { allowDeleted?: boolean })` in `packages/cli/src/target.ts`. Today it throws `NotFoundError` for a soft-deleted document (`target.ts`, the `doc.deletedAt !== null` check), so a release item of a deleted document, the case `publishRelease` refuses at `releases.test.ts:398`, could not be named. With `allowDeleted: true` that check is skipped; every other caller keeps the default (false) and its behaviour. `release remove` passes `allowDeleted: true`.
- Produces: `mogging release remove <name> <collection>/<slug> ... [--locale <l>] [--json]`. Exactly one `<name>` and at least one target; the only option is `--locale`; any other verb option (`--all-approved`, `--collection`, `--allow-stale`) is `release remove: --<option> does not apply` (exit 2). Per target and scope the outcome is `removed` (line `removed <target> <locale>`), `not in release` (a NotFoundError whose message matches `/is not in release/`; not a failure), or `refused` (any other refusal, e.g. a published release). Scopes: with `--locale`, that one (`scopeLocale`); without it, every scope in `[...new Set(["shared", source, ...Object.keys(chains)])]` of `ctx.config.locales`; a scope that is not in the release is silent when `--locale` is absent, and a target with no item in any scope yields one `not in release` item with locale `-`. A refusal other than `not in release` ends that target's remaining scopes (so a published release prints one `refused:` line per target, not one per scope). `data` is `{ items }` via `itemsResult(items, "ReleaseRemoveFailed", ["nothing to remove"])`; `removed` and `not in release` count as done for the exit rule.

- [ ] **Step 1: Write the failing tests** (names are the contract):
  - `release remove takes an item out`: add de, then `release remove r1 posts/<slug> --locale de` exits 0, prints `removed <target> de`, `items(sql)` is empty; the `--json` document has `data.items` `[{ target, locale: "de", outcome: "removed" }]`.
  - `release remove repairs a release whose draft moved on`: add de, `humanDraft` again, `release publish` fails (exit 1), `release remove`, `release add`, `release publish` exits 0.
  - `release remove without --locale removes every item of the document` (two scopes in the release; both gone; scopes without an item print nothing).
  - `release remove of an absent item reports not in release and exits 0` (with and without `--locale`).
  - `release remove on a published release exits 1 with one refused line per target`.
  - `release remove: an unknown release or an unknown target exits 1 like release add`.
  - `release remove names a soft-deleted document's item` (`deleteDocument` after adding; `release remove r1 posts/<slug> --locale de` exits 0 and prints `removed`); and, in `packages/cli/test/target.test.ts`, that the default still refuses a soft-deleted document.
  - usage errors, as rows in the existing table at line 342: `["remove without a release name", ["release","remove"], "release remove"]`, `["remove without a target", ["release","remove","r1"], "release remove"]`, `["remove with --all-approved", ...]`, `["remove with --allow-stale", ...]`, each exit 2.
- [ ] **Step 2: Run** `pnpm vitest run packages/cli/test/release.test.ts`: the new tests fail (`unknown verb "remove"`).
- [ ] **Step 3: Implement** the verb in `release.ts`: add `"remove"` to `VERBS`, `remove: ["locale"]` to `OPTIONS_OF`, the validate branch (`release remove: expected <name> and at least one <collection>/<slug> target`), the usage line `mogging release remove <name> <collection>/<slug> ... [--locale <l>] [--json]` and the summary `create, list, fill, trim and publish releases`; a `remove(ctx, name, targets, flags)` function next to `add` following the Interfaces block; the `switch` case in `run`. Resolve every target first, before removing anything (as `add` does), so an unknown target fails the run with nothing half done.
- [ ] **Step 4: Edit the docs.** `packages/cli/README.md`: add `mogging release remove <name> <collection>/<slug> ... [--locale <l>]` after the `release add` lines; add `release remove` beside `release add` at lines 146 and 173; replace the "No `release remove`" bullet at line 248 with a one-sentence note that removal is by (document, locale), needs an unpublished release and records nothing. Core design: 9.2 verb list `create|add|remove|publish` and a syntax line; 9.3 add `removeFromRelease` to Writes and append to the actor sentence "`removeFromRelease` takes the actor but records nothing: release membership is staging, and what is audited is what publishes."; 12.3 add `removeFromRelease` to the "Not guarded" list (the guarded set is unchanged); line 636 delete `release remove` from "Not built in v0.1" and say it shipped in plan 5.
- [ ] **Step 5: Run** `pnpm vitest run packages/cli` then `pnpm test` and `pnpm typecheck`.
- [ ] **Step 6: Commit** `feat(cli): release remove`. Delete the bullet that starts "`@mogging/cli` and `@mogging/core` `release remove`" from `TODO.md`.

---

### Task 7: Document the listDraftHeads cursor as opaque; close out the TODO

**Files:**
- Modify: `packages/core/src/read/review.ts` (doc comment at lines 49-52), `docs/superpowers/specs/2026-11-11-moggingcms-core-design.md` (9.3 Reads sentence), `TODO.md`

**Interfaces:** none (documentation only; behaviour of `listDraftHeads` is unchanged).

- [ ] **Step 1: Edit.** In `review.ts` rewrite the comment so it no longer spells the cursor's format: "`after` is an opaque cursor: pass back the `next` of the previous page; its format is not part of the contract." In core design 9.3 add after the Reads list: "`listDraftHeads` returns `{ items, next }`; `after` is an opaque cursor, to be passed back only as the `next` the previous page returned." In `TODO.md` delete the bullet that starts "`@mogging/core` `listDraftHeads` cursor"; remove any remaining plan 5 item still listed (U+0000, `pollMs`, `listProvenance`, rejected text, `release remove`) and confirm none is left with `grep -n "U+0000\|pollMs\|afterId\|resurface\|release remove\|listDraftHeads" TODO.md` (the plan 3 bullet "`@mogging/ai` deferred Minor review findings" keeps its other findings).
- [ ] **Step 2: Run** `pnpm typecheck` and `pnpm test` (whole suite green, count = baseline + the tests this plan added).
- [ ] **Step 3: Commit** `docs: listDraftHeads cursor is opaque; TODO closed for plan 5`.

## Review ledger

Round 1 (2026-11-13, persona relentless-adversarial-auditor; seats Axiom Breaker, Cascade Analyst, State Corruptor, Protocol Pedant, Literal Implementer, Mechanism Gamer; dropped Boundary Smuggler, Resource Vampire, Dependency Cynic, Activation Auditor, Blindspot Auditor, none of whose triggers the plan met), solo panel plus the agy escalation:
- FOLDED: the CLI could not name a soft-deleted document's release item (`resolveTarget` refuses it, `target.ts`), so Task 6 gained `allowDeleted`; `TODO.md` is edited by bullet text, not line number; Task 1 gained an import test for a NUL in a source file; Task 5 defines `RemoveFromReleaseInput`.
- FOLDED (agy, each verified): Task 2's snippet took `migrateAndSeed`'s return (a docId string, `packages/ai/test/fixtures.ts:62`) for a ctx; Task 1 Step 4 used `sql` where the existing test names the callback parameter `_sql` (`import.test.ts:302`); Task 1's scalar assertions lacked the message regex.
- REJECTED: a race between `removeFromRelease` and `publishRelease`: both lock the release row `for update` (`releases.ts:131`), so they serialize. REJECTED (agy F3, "the `pollMs: 1` assertion passes if `pollMs` is ignored"): true (`worker.ts:109` exits before the sleep) but it is a positive control for acceptance; the rejections are what fail before the fix, and the scheduling use of `pollMs` is unchanged code.
- DEFERRED-TO-ANOMALIES: `saveDraft.ts:74` carry-forward base * 2026-11-13 * unverified; `releases.ts:33` NUL in text columns * 2026-11-13.
- agy's collision check (TODO.md, `packages/ai/README.md`, design 9.3 edited by several tasks): no conflict, the edits are to different bullets or sentences.

## Stand-downs

None. No finding was discarded below the floor.
