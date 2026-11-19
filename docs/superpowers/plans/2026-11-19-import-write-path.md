# Import write path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first Starlight import much faster by removing redundant statements per file (guard-once write run, within-transaction writers) and by writing locale files for independent documents concurrently.

**Architecture:** `@mogging/core` gains an unlisted `@mogging/core/internal` subpath exposing a lazy, memoized write run plus within-transaction writers; the public `saveDraft` and `publish` keep their behaviour and statements. `@mogging/markdown`'s Starlight import uses the run in both phases and writes the locale phase through a bounded worker pool grouped by document. `@mogging/cli` adds `--concurrency` and a bigger pool.

**Tech Stack:** TypeScript (ESM, NodeNext), postgres.js 4.1.0, vitest 5, pnpm workspaces, Postgres.

**Spec:** `docs/superpowers/specs/2026-11-18-import-write-path-design.md` (committed `0a293f3`). All code citations below were read against the repository at that commit; if a cited line has moved, find the symbol and say so in the task report, do not adapt silently.

## Global Constraints

- Node >= 22; ESM, relative imports use the `.js` extension, type-only imports use `import type`; JSDoc (summary, params, returns, throws) on every exported function and type; conventional commits `type(scope): summary` ending with the harness's `Co-Authored-By` line.
- Every test touches the database: `export DATABASE_URL=postgres://mogging:mogging@127.0.0.1:54329/mogging_test` first (port 5432 rejects the password on this machine). NEVER insert `--` after `test` or `dev`. The static gate is `pnpm typecheck`; there is no linter.
- Stored bytes, normalization and hashes do not change. The golden of Task 1 (generated from the unchanged code) must keep passing through every later task.
- Runtime export lists pinned by `packages/core/test/api.test.ts` and `packages/markdown/test/api.test.ts` do NOT change. The new surface is the subpath `@mogging/core/internal` only.
- Statement counts, pinned exactly per transaction kind: source page (save + publish) 25; day-one locale save + publish 12; tracked locale save + publish 13; day-one save-only 7; tracked save-only 8; publish-only 8. The last three are baseline minus 3 and must be confirmed against the baseline Task 2 records (stop and report on a mismatch). The whole import makes at most one licence read.
- Licence: checked ONCE per import, lazily at the first write (never for a dry run, an all-unchanged run or a prune-only run); the run handle carries `config` and `actor` only, never `sql`.
- Concurrency: SDK default 1; CLI default 4; CLI pool 4 -> 8; `--concurrency` is `intOption("concurrency", text, 1, 8)` with no parser default; effective = 1 for a transaction handle or when `sql.options.max` is not a positive integer, else `min(requested, sql.options.max)`.
- `StarlightImportDetails.concurrency` is always present: `{ requested, effective, limit: "pool" | "transaction" | "unknown", poolMax? }` (`poolMax` only for `"pool"`). The CLI prints `concurrency: <effective> of <requested> (<reason>)` only when `effective < requested`, directly after the optional `dry run: nothing was written` line; reasons are exactly `the pool allows <poolMax>`, `a transaction handle runs one write at a time`, `the pool size is unknown`. Nothing is added to `warnings`.
- Timing figures are measured by the controller at the top level only (backgrounded, no concurrent tool calls, two runs, quote the range, say the load was uncontrolled), never by a subagent.

## Review Focus

Failure modes the spec implies that most likely bite a user, most likely first; each has a pinning test in the owning task:
1. A licence that has expired: a dry run and an all-unchanged import must still succeed, and one write must fail before any write leaves a row (Task 5).
2. A pool smaller than the request, a pool of 1, a transaction handle as `ctx.sql`, and an unreadable `sql.options` (Task 6).
3. A hinted shared publish silently skipping the duplicate-slug lock and check (Task 3).
4. A write that fails for one file (a database error) under concurrency 4: that file becomes an `error` outcome and every other file, including that document's later locales, still commits (Task 6).
5. Tracked saves and publish-only items costing different statement counts than the day-one case the perf fixture exercises (Tasks 2 and 5).

---

### Task 1: Golden end state from the unchanged code

**Files:**
- Create: `packages/markdown/test/starlight/endState.ts`, `packages/markdown/test/starlight/endState.test.ts`, `packages/markdown/test/starlight/golden/import-end-state.json`

**Interfaces:**
- Produces: `dumpEndState(sql: Sql): Promise<EndState>` where `EndState = { documents: Array<{ slug: string; scopes: Array<{ scope: string; version: number; state: string; headDraft: boolean; headPublished: boolean; data: unknown; sourceHashes: unknown; createdBy: string; publishedBy: string | null; hasPublishedAt: boolean; hasUnpublishedAt: boolean }> }> }` (no ids, no timestamps; documents sorted by slug, scopes by scope then version; `scope` is `"shared"` or the locale; `sourceHashes` is `null` for the shared scope).
- Produces: `runScenario(sql: Sql, ctx: Ctx, extra?: Partial<StarlightImportOptions>): Promise<Array<{ name: string; report: NormalizedReport; state: EndState }>>` where `NormalizedReport` is the `ImportReport` with ids removed and files, warnings and errors sorted by path; `starlight.concurrency` is left out of it (that field does not exist when the golden is generated, and later tasks assert it separately).

- [ ] **Step 1: Write `endState.ts` and `endState.test.ts`.** The scenario uses the existing fixtures (`withTestDb`, `ctxFor`, `layout`, `project`, `docs`) and runs these phases on one schema, each a `importFolder(ctx, { dir, publish, starlight: { layout, ...extra } })`: **A** `publish: false`, three new English pages (`a`, `b`, `c`) with German and `zh-CN` files for all three, except `c`'s German file has an empty `title` (an incomplete translation, saved but not published); **B** `publish: false`, edit `a`'s German file (tracked save-only); **C** `publish: true`, edit `b`'s German file (tracked save + publish) and leave `a`'s German file as phase B left it (a pending draft, publish-only). Model the file edits on the existing `importLocale.test.ts` tests "classes: published, pending and behind write nothing; hand work is a human draft" and "not day one: a hand-work file is saved and published in one run with publish". The test asserts: A creates three pages, publishes both English and all complete translations and does not publish `c` German; B reports `a` German `updated` with `published: false`; C reports `b` German `published: true` and `a` German `published: true`; then `expect(actual).toEqual(golden.phases)` where the golden file is `{ generatedFromCommit: string, phases }` and only `phases` is compared. When `UPDATE_GOLDEN=1` the test writes the golden instead of comparing.
- [ ] **Step 2: Run it without a golden.** Run: `pnpm --filter @mogging/markdown test endState`. Expected: FAIL (golden missing).
- [ ] **Step 3: Generate the golden from the unchanged code.** Run: `UPDATE_GOLDEN=1 pnpm --filter @mogging/markdown test endState`, set `generatedFromCommit` to `git rev-parse HEAD`, and open the JSON to check it holds three documents with the expected scopes. Expected: the file exists and is non-empty.
- [ ] **Step 4: Run it again.** Run: `pnpm --filter @mogging/markdown test endState`. Expected: PASS. Run `pnpm typecheck`; expected: no output.
- [ ] **Step 5: Commit.** `git add packages/markdown/test/starlight && git commit -m "test(markdown): golden end state of the Starlight import from the unchanged code"`

### Task 2: Statement capture and the pre-change baseline per transaction kind

**Files:**
- Modify: `packages/markdown/test/starlight/fixtures.ts` (add `capturingSql` next to `countingSql`, line 104)
- Create: `packages/markdown/test/starlight/statementKinds.ts`, `packages/markdown/test/starlight/statementCounts.test.ts`

**Interfaces:**
- Produces: `capturingSql(sql: Sql): Promise<{ sql: Sql; statements(): string[]; reset(): void }>`: a connection on the same schema as `sql` (`max: 1`, `connection: { search_path }`) whose postgres.js `debug` callback is `(connection, query) => statements.push(query)` (the statement text is the SECOND argument; the first is the connection number), so it records each statement's text (`countingSql` only counts, `fixtures.ts:108`).
- Produces: `type TxKind = "source" | "locale-dayone-save-publish" | "locale-tracked-save-publish" | "locale-dayone-save-only" | "locale-tracked-save-only" | "locale-publish-only"` and `transactionsOf(statements: string[]): Array<{ kind: TxKind; statements: string[] }>`: splits the log at each `begin` .. `commit`, and classifies by content: contains `insert into documents` is `source`; else contains `insert into document_localized` and `set state = 'PUBLISHED'`, with `select data from document_localized where doc_id = $1 and locale = $2 and is_head_published` present (the tracked source-head read, `saveDraft.ts:151`) is tracked, absent is day-one; contains the insert but no flip is save-only; the flip without the insert is publish-only. Statement text is whitespace-normalized before matching.

- [ ] **Step 1: Write the failing test.** `statementCounts.test.ts` runs the Task 1 scenario through `capturingSql`, groups transactions with `transactionsOf`, and asserts one `EXPECTED` table of exact statement counts per kind (use `.toBe`). Put the BASELINE numbers in it now: source 39, day-one save + publish 19, and the other four kinds as measured in Step 2.
- [ ] **Step 2: Run it and record the baseline.** Run: `pnpm --filter @mogging/markdown test statementCounts`. Expected: source 39 and day-one 19 PASS (they are the traced counts); for the other four kinds copy the measured counts into the table (hand-derived expectation: tracked save + publish 20, day-one save-only 10, tracked save-only 11, publish-only 11; if source or day-one differ, report `STATE_MISMATCH: <what>` and stop).
- [ ] **Step 3: Run it again.** Expected: PASS. Run `pnpm typecheck`; expected: no output.
- [ ] **Step 4: Commit.** `git add packages/markdown/test/starlight && git commit -m "test(markdown): pin the statement counts per transaction kind before the change"`

### Task 3: Core refactor without behaviour change (`saveDraftWithinTx`, `publishWithinTx` hint)

**Files:**
- Modify: `packages/core/src/documents/saveDraft.ts:55-168`, `packages/core/src/documents/publishCore.ts:9,47-132` (`resolveLocale`, `publishWithinTx`), `packages/core/src/documents/slugGuard.ts:21,42` (`lockSlugs`, `assertSlugFree`)
- Test: `packages/core/test/saveDraft.test.ts`, `packages/core/test/publish.test.ts`, `packages/core/test/releases.test.ts`, `packages/core/test/slugGuard.test.ts` (existing, must pass unchanged); Create: `packages/core/test/publishHint.test.ts`

**Interfaces:**
- Produces (in `saveDraft.ts`, not exported from `index.ts`): `saveDraftWithinTx(tx: Tx, run: Pick<Ctx, "config" | "actor">, input: SaveDraftInput, collection: string): Promise<{ version: number }>`: the same validation as `saveDraft`, in the same order (locale and `untracked` checks, UUID, then normalization against the named collection), then the body from the `documents ... for update` select (`saveDraft.ts:92`) to the insert, run on the caller's `tx` with no savepoint, no licence read and no collection probe.
- Produces: `publishWithinTx(tx: Tx, ctx: Pick<Ctx, "config" | "actor">, input: PublishInput, stamp: string, opts?: { collection?: string }): Promise<void>`; `resolveLocale`, `lockSlugs` and `assertSlugFree` take `Pick<Ctx, "config">` (a widening). `Tx` is re-exported from `publishCore.ts:19`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test** `publishHint.test.ts`: reuse the `slugGuard.test.ts` scenario in which `publish` of a shared draft is refused because another live document of the collection holds the slug; call `publishWithinTx(tx, ctx, input, stamp, { collection: "<the collection>" })` inside `sql.begin` (import it from `../src/documents/publishCore.js`) and assert it rejects with `ValidationError` matching `/already used by another document/`; a second test asserts the advisory slug lock statement is issued when a hint is passed (capture statements with the `debug` option of a dedicated connection on the test schema).
- [ ] **Step 2: Run it to see it fail.** Run: `pnpm --filter @mogging/core test publishHint`. Expected: FAIL (the hint argument does not exist / the guard is skipped).
- [ ] **Step 3: Implement.** In `publishWithinTx` take the collection name from `opts.collection` when given, else from the existing `select collection` (`publishCore.ts:80`); key the shared-scope slug lock and uniqueness check (`publishCore.ts:101-104`) on that NAME, not on `docRow`; the required-field check keeps using the config collection found by that name. Split `saveDraft` into pure validation, the existing probe (public path only) and the transactional body, so the public function is guards + validation + probe + `sql.begin(tx => body)` and `saveDraftWithinTx` is validation + body. State the precedence caveat in `saveDraftWithinTx`'s JSDoc: it trusts the caller's collection and document id, so a document invalid in two ways, or deleted concurrently, can report a different first error than the public path.
- [ ] **Step 4: Run the whole core suite.** Run: `pnpm --filter @mogging/core test`. Expected: all PASS, including `api.test.ts` unchanged (the runtime surface does not change). Run `pnpm typecheck`; expected: no output.
- [ ] **Step 5: Commit.** `git add packages/core && git commit -m "refactor(core): within-tx save body and a collection hint for publishWithinTx"`

### Task 4: Core write run, `publishWithinRun` and the `@mogging/core/internal` subpath

**Files:**
- Create: `packages/core/src/internal.ts`, `packages/core/test/internal.test.ts`
- Modify: `packages/core/src/documents/publish.ts` (add `publishWithinRun` after `publish`, line 49), `packages/core/package.json` (`exports` and `publishConfig.exports`)

**Interfaces:**
- Consumes: `saveDraftWithinTx`, `publishWithinTx` (Task 3), `assertLicensed` (`licence/guard.ts:93`), `assertActor` (`ctx.ts:13`).
- Produces (all re-exported from `internal.ts`): `type WriteRun = Readonly<Pick<Ctx, "config" | "actor">>`; `beginWriteRun(ctx: Ctx): Promise<WriteRun>` (`assertLicensed` then `assertActor`, in that order, returns a frozen `{ config, actor }`); `saveDraftWithinTx` (Task 3); `publishWithinRun(tx: Tx, run: WriteRun, input: PublishInput, opts: { collection: string; alreadyLocked: boolean }): Promise<void>` (UUID and locale validation, then the `documents ... for update` select with the `NotFoundError` unless `alreadyLocked`, then the clock read `select date_trunc('milliseconds', clock_timestamp())`, then `publishWithinTx(tx, run, input, stamp, { collection })`); types `Tx`, `SaveDraftInput`, `PublishInput`.

- [ ] **Step 1: Write the failing tests** in `internal.test.ts`: (a) the exact export list of `src/internal.ts` (`beginWriteRun`, `publishWithinRun`, `saveDraftWithinTx`) and that `import("@mogging/core")` has none of them; (b) `beginWriteRun` rejects with `LicenceError` when the first migration is older than 30 days (set it with `update migrations set applied_at = applied_at - interval '31 days'`, as `packages/cli/test/fixtures.ts:83` does) and rejects with `ValidationError` for an actor containing U+0000, licence refusal first; (c) the returned run has no `sql` property and is frozen; (d) equivalence: for a document with a published English head, `saveDraftWithinTx` + `publishWithinRun(tx, run, input, { collection, alreadyLocked: true })` in one `sql.begin` leaves the same rows (state, data, source hashes, heads, actors) as public `saveDraft` + `publish` on a twin document, for `untracked: true` and for a tracked save; (e) `publishWithinRun` with `alreadyLocked: false` on a document that does not exist throws `NotFoundError` with the message the public `publish` gives.
- [ ] **Step 2: Run to see it fail.** Run: `pnpm --filter @mogging/core test internal`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `publishWithinRun` in `publish.ts`, create `internal.ts` with `beginWriteRun` and the re-exports, and add `"./internal": "./src/internal.ts"` to `exports` and `"./internal": { "types": "./dist/internal.d.ts", "import": "./dist/internal.js" }` to `publishConfig.exports`. Every exported symbol gets JSDoc.
- [ ] **Step 4: Run the core suite and the pack gate.** Run: `pnpm --filter @mogging/core test`, then `pnpm check:publish`. Expected: PASS and one `OK   @mogging/core@...` line per package (the prepack gate already verifies every `publishConfig.exports` target exists, `scripts/prepack.mjs` via `entryFiles`). Run `pnpm typecheck`; expected: no output.
- [ ] **Step 5: Commit.** `git add packages/core && git commit -m "feat(core): guard-once write run and within-tx writers on an internal subpath"`

### Task 5: The Starlight import uses the write run (F1)

**Files:**
- Modify: `packages/markdown/src/starlight/importStarlight.ts` (imports at lines 4-8; `Plan` type and its construction in `planSource`, return at line 307; `applySource` at line 314; `applyLocales` at line 613); `packages/markdown/test/starlight/statementCounts.test.ts`
- Create: `packages/markdown/test/starlight/importLicence.test.ts`

**Interfaces:**
- Consumes: `beginWriteRun`, `saveDraftWithinTx`, `publishWithinRun`, types `WriteRun`, `Tx` from `@mogging/core/internal` (Task 4); `capturingSql`, `transactionsOf`, `runScenario` (Tasks 1, 2).
- Produces: `Plan.run: Promise<WriteRun> | null` and a local `writeRun(plan: Plan): Promise<WriteRun>` that creates the run on first use (`plan.run ??= beginWriteRun(plan.ctx)`) and returns the same promise afterwards.

- [ ] **Step 1: Write the failing tests.** (a) In `statementCounts.test.ts` change the `EXPECTED` table to the post-change counts from Global Constraints (source 25, 12, 13, 7, 8, 8) and add assertions that no transaction contains `savepoint` and that the whole scenario issues at most one statement matching `from migrations`. (b) `importLicence.test.ts` (set the first migration 31 days back and make sure `MOGGING_LICENSE_KEY` is unset in the test): a `dryRun` import of new files succeeds and writes nothing; an import where every file is unchanged (run the scenario's phase A first with a fresh licence, then expire it) succeeds; a prune-only run succeeds; an import with one new page rejects with `LicenceError` and leaves no `documents` row (the guard runs before the transaction opens); a valid licence yields exactly one `from migrations` statement for the whole import.
- [ ] **Step 2: Run to see it fail.** Run: `pnpm --filter @mogging/markdown test statementCounts importLicence`. Expected: FAIL on the counts and on the single licence read.
- [ ] **Step 3: Implement.** In `applySource` obtain `const run = await writeRun(plan)` inside the existing `try`, before `inTx` opens, and change `inTx` to hand the callback both the transaction handle and the `Ctx` over it (`createDocument` still takes the `Ctx`); inside it call `saveDraftWithinTx(tx, run, { docId, locale, data }, col.name)` for `act === "save"` scopes and `publishWithinRun(tx, run, { docId, locale }, { collection: col.name, alreadyLocked })` for `act !== "none"` scopes, where `alreadyLocked` is true exactly when this transaction already saved or published that document (a local `Set<string>`; a source scope can be publish-only, see `decide(...)` at `importStarlight.ts:290-291`). In `applyLocales` call `writeRun(plan)` once, only if at least one item survives the pre-pass (`act.kind !== "none"`, line 632), before the per-item loop; per item use `saveDraftWithinTx` (`untracked` as today) then `publishWithinRun(tx, run, { docId, locale }, { collection: plan.col.name, alreadyLocked: true })` for `save` + `publish`, or the same call with `alreadyLocked: false` for `publish` (`collection` is required, as Task 4 defines it). Drop `saveDraft` and `publish` from the `@mogging/core` import if nothing else in the file uses them. Remove the `LicenceError` rethrow only from the locale phase (the run is created before any item); keep it in `applySource`.
- [ ] **Step 4: Run the markdown suite.** Run: `pnpm --filter @mogging/markdown test`. Expected: all PASS, including `endState` (the golden still matches) and `api.test.ts` unchanged. Run `pnpm typecheck`; expected: no output.
- [ ] **Step 5: Commit.** `git add packages/markdown && git commit -m "perf(markdown): Starlight import uses a lazy guard-once write run"`

### Task 6: Concurrent locale writes (F3)

**Files:**
- Create: `packages/markdown/src/starlight/concurrency.ts`, `packages/markdown/test/starlight/concurrency.test.ts`, `packages/markdown/test/starlight/importConcurrent.test.ts`
- Modify: `packages/markdown/src/import.ts` (`StarlightImportOptions` at line 19 gets `concurrency?: number`; `StarlightImportDetails` gets `concurrency: ConcurrencyDetails`), `packages/markdown/src/starlight/importStarlight.ts` (`applyLocales` at line 613; `importStarlight` at line 668 and its returned details at lines 683-689), `packages/markdown/test/db.ts` (add `withPooledTestDb`)

**Interfaces:**
- Produces: `type ConcurrencyDetails = { requested: number; effective: number; limit: "pool" | "transaction" | "unknown"; poolMax?: number }`; `resolveConcurrency(sql: Sql, requested: number | undefined): ConcurrencyDetails` (throws `ValidationError` unless `requested` is `undefined` or an integer >= 1; undefined means 1; `limit: "transaction"` when `typeof sql.savepoint === "function"`; `"unknown"` when `sql.options?.max` is not a positive integer; else `"pool"` with `poolMax` and `effective = min(requested, poolMax)`); `runGroups<T>(groups: T[][], concurrency: number, work: (item: T) => Promise<void>): Promise<void>` (at most `concurrency` workers pull whole groups from a shared queue; items of a group run in order on one worker; every worker has settled before it resolves; if `work` rejects it still finishes the rest and then rethrows the first rejection).
- Produces: `withPooledTestDb(max: number, fn: (sql: Sql) => Promise<void>): Promise<void>` in `test/db.ts`: a random `t_<hex>` schema created on a separate admin connection (`max: 1`), then a pool created with `{ max, connection: { search_path: schema }, onnotice }` and passed to `fn`; in a `finally` the pool is ended BEFORE the schema is dropped on the admin connection, which is then ended. Migrations are NOT applied (callers call `migrate(sql)`, as with `withTestDb`). `withTestDb` is unchanged (it is `max: 1` with a session-level `set search_path`, `test/db.ts:10-13`, so it cannot test concurrency).
- Consumes: `writeRun` and the within-run writers (Task 5).

- [ ] **Step 1: Write the failing unit tests** in `concurrency.test.ts`: `resolveConcurrency` for a fake pool `{ options: { max: 8 } }` (requested 4 -> effective 4 `"pool"`; requested 8 on `max: 4` -> effective 4; `max: 1` -> 1), a fake transaction `{ savepoint() {}, options: {} }` (-> 1, `"transaction"`), `{ options: {} }` and `{}` (-> 1, `"unknown"`), and `ValidationError` for `0`, `-1`, `0.5`, `NaN`; `runGroups` never has more than `concurrency` items in flight (counter), keeps a group's items in order, resolves only after every worker has settled, and rethrows a rejection after the others finished.
- [ ] **Step 2: Write the failing import tests** in `importConcurrent.test.ts`, all on `withPooledTestDb(8, ...)` unless noted, each starting with `await migrate(sql)`: (a) equivalence: the Task 1 scenario at `concurrency: 1` and `4` (two fresh schemas) gives equal `state` dumps and equal normalized reports, and both equal the golden; each run's `report.starlight.concurrency` is asserted (`{ requested: 4, effective: 4, limit: "pool", poolMax: 8 }`); (b) pool of 2 with `concurrency: 8` clamps to `{ requested: 8, effective: 2, limit: "pool", poolMax: 2 }` and finishes (test timeout 20 s); (c) `withTestDb` (max 1) clamps to 1; (d) `ctx.sql` as a transaction handle (`sql.begin(tx => importFolder({ ...ctx, sql: tx }, ...))`) runs at 1 with `limit: "transaction"`; (e) failure isolation at 4: in the test schema create a trigger function that raises an exception and a `before insert` trigger on `document_localized` with `when (new.data->>'title' = 'boom')`; one German file has the front-matter title `boom`; assert that file is an `error` outcome (its message contains the raised text), the same document's later locales and every other document are committed (compare the end-state dump with the run without that file), and the import returns normally; (f) a dry run and `starlight.concurrency: 0` both behave: dry run still reports `concurrency`, `0` throws `ValidationError` before any statement; (g) an empty project of unchanged files at concurrency 8 reports `effective` and writes nothing.
- [ ] **Step 3: Run to see them fail.** Run: `pnpm --filter @mogging/markdown test concurrency importConcurrent`. Expected: FAIL (modules and option missing).
- [ ] **Step 4: Implement.** Create `concurrency.ts`. In `importStarlight` call `resolveConcurrency(ctx.sql, input.starlight.concurrency)` first (before planning, so an invalid value throws before any statement) and put the result in the returned `starlight` details, including for a dry run. Restructure `applyLocales` (parameter `effective: number`): keep the sequential pre-pass in the current order (resolve `docId`, the "English page was not imported" warning at line 625, skip `none`), build `work` entries, call `writeRun(plan)` once if `work` is non-empty, group by the RESOLVED `docId` (first-appearance order), and run `runGroups(groups, effective, writeOne)` where `writeOne` is the existing per-item try/catch (errors become that file's `error` outcome; it never rejects). Document `concurrency` in the `StarlightImportOptions` JSDoc.
- [ ] **Step 5: Run the markdown suite.** Run: `pnpm --filter @mogging/markdown test`. Expected: all PASS. Run `pnpm typecheck`; expected: no output.
- [ ] **Step 6: Commit.** `git add packages/markdown && git commit -m "feat(markdown): opt-in concurrent locale writes grouped by document"`

### Task 7: CLI `--concurrency`, pool 8 and the clamp line

**Files:**
- Create: `packages/cli/src/pool.ts` (`export const CLI_POOL_MAX = 8;` with JSDoc)
- Modify: `packages/cli/src/run.ts:45`, `packages/cli/src/commands/import.ts` (`USAGE` line 11, `STARLIGHT_FLAGS` line 14, `given` line 23, `starlightLines` line 50, `importSpec.options`, `checkLoaded`, `run`), `packages/cli/test/importStarlight.test.ts`, `packages/cli/README.md`

**Interfaces:**
- Consumes: `intOption(name: string, text: string | undefined, min: number, max?: number)` from `../args.js`; `StarlightImportDetails.concurrency` (Task 6).
- Produces: `CLI_POOL_MAX`; the `--concurrency <n>` flag.

- [ ] **Step 1: Write the failing tests** in `importStarlight.test.ts`: `--concurrency 0`, `9` and `x` exit 2 with a usage message and connect nothing (they are raised in `checkLoaded`, before `deps.connect`, `project.ts:122`); `--concurrency 3` on a generic (non-Starlight) project exits 2 with the same wording as `--prune`; `--json` data carries `starlight.concurrency`; with the test pool (`max: 1`) the output contains the line `concurrency: 1 of 4 (the pool allows 1)` directly after the `dry run: nothing was written` line for `--dry-run` and as the first line otherwise, and an import with `--concurrency 1` prints no such line.
- [ ] **Step 2: Run to see them fail.** Run: `pnpm --filter @mogging/cli test importStarlight`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `concurrency: { type: "string" }` to `importSpec.options` (no `default`); add `"concurrency"` to `STARLIGHT_FLAGS` and extend `given` so a string flag counts as given when it is a string; validate with `intOption("concurrency", ..., 1, CLI_POOL_MAX)` in `checkLoaded` for Starlight projects and use `?? 4` in `run`; pass `concurrency` into `starlight`; render the clamp line in `starlightLines` from `report.starlight.concurrency` (a pure function of the report) with the three exact reasons from Global Constraints; set the pool to `max: CLI_POOL_MAX` at `run.ts:45`; add `[--concurrency <n>]` to `USAGE` and document the flag in `packages/cli/README.md`.
- [ ] **Step 4: Run the CLI suite and fix expectations that are consequences, not defects.** Run: `pnpm --filter @mogging/cli test`. Existing Starlight import tests use a `max: 1` pool, so they now print `concurrency: 1 of 4 (the pool allows 1)`; update only the expectations that compare the full line list, and say which in the commit body. Expected afterwards: all PASS. Run `pnpm typecheck`; expected: no output.
- [ ] **Step 5: Commit.** `git add packages/cli && git commit -m "feat(cli): --concurrency for the Starlight import and a pool of 8"`

### Task 8: Documentation, tracked debt and the gated perf arm

**Files:**
- Modify: `AGENTS.md` ("Engine model", entry-guard bullet), `docs/CONTENT_ARCHITECTURE.md` (section 6.2, the "Guarded writes" bullet), `TODO.md`, `packages/markdown/test/starlight/perf.test.ts` (add a `MOGGING_PERF`-gated test), `docs/superpowers/specs/2026-11-18-import-write-path-design.md` (status line)

**Interfaces:**
- Consumes: `withPooledTestDb` (Task 6).

- [ ] **Step 1: Write the docs.** `AGENTS.md`: one sentence that a write loop guards once through `beginWriteRun` (`@mogging/core/internal`, unlisted) and calls the within-tx writers, which is the sanctioned form of the "never inside a loop helper" rule. `CONTENT_ARCHITECTURE.md` 6.2: Markdown import is guarded once per run, at its first write, so a dry run or an import that writes nothing needs no licence, and a run that started licensed finishes. `TODO.md`: add one line each for adopting the write run in the generic `importFolder` and `renamePage`, the fused save + publish insert, concurrency in the source phase, and profiling the unchanged-import path (Rust or Bun only after that profile).
- [ ] **Step 2: Add the gated perf arm.** A second test in `perf.test.ts`, skipped unless `MOGGING_PERF` is set, that runs the same 2,000 x 6 first import on `withPooledTestDb(8, ...)` with `starlight: { layout, concurrency: 8 }`, prints `PERF import 1 (concurrency 8): wall ..., queries ...`, and asserts `0` errors and `12000` files.
- [ ] **Step 3: Verify.** Run `pnpm typecheck`, `pnpm --filter @mogging/markdown test perf` (the new test must be reported skipped), and `pnpm test` for the whole repo. Expected: no output from typecheck; all PASS.
- [ ] **Step 4: Commit.** `git add -A docs AGENTS.md TODO.md packages/markdown/test && git commit -m "docs: record the guard-once write run and track the follow-ups"`

### Task 9: Whole-branch verification, measurement and the owner's review gates

**Files:** none (verification and ledger rows only).

- [ ] **Step 1: Static and test gates.** Run `pnpm typecheck`, `pnpm test`, `pnpm check:frozen`, `pnpm check:publish`. Expected: typecheck prints nothing; every test passes; the frozen gate and the publish gate print OK for all five packages (the tarball of `@mogging/core` must contain `dist/internal.js` and `dist/internal.d.ts`). Then `pnpm smoke:pack` (needs the network); expected: the packed CLI runs.
- [ ] **Step 2: Controller-only measurement (never a subagent).** On an otherwise idle machine, backgrounded with no other tool call until it finishes, run twice each: `MOGGING_PERF=1 pnpm --filter @mogging/markdown test perf --reporter=verbose` (the existing 2,000 x 6 test at concurrency 1, which is F1 alone) and the new concurrency-8 arm. Record the ranges and the uncontrolled background load in the spec's evidence section. Success bar from the spec: first import at least 2.5x faster than the 271 to 301 s baseline at concurrency 8 with a pool of 8 (about 115 s or better, expected 75 to 95 s); at concurrency 4 at least 2x; the unchanged import and export (42 / 40-50 statements) not slower than 10 to 13 s. Report any miss; do not tune the bar.
- [ ] **Step 3: The owner's review gates.** Run the agy capstone on the committed implementation (`clavity:agy-capstone`, rounds until green), then `clavity:agy-test-audit`; record one row each in `docs/agy-capstone-ledger.md` and `docs/agy-test-audit-ledger.md`.
- [ ] **Step 4: Finish.** Use `superpowers:finishing-a-development-branch`; the owner publishes by hand.
