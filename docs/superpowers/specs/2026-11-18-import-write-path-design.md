# Import write path: fewer statements and concurrent locale writes (design)

Status: IMPLEMENTED on branch `feat/import-write-path`. Written 2026-11-18; revised after a builder check, a solo
adversarial panel and agy panel rounds 1 to 5 (findings folded below).
Origin: the owner asked "Add support for bun runtime and Rust to improve speed". Measuring first showed that neither
touches the slow part, so this design covers what does. Bun and Rust are recorded as rejected for the write path (see
Approaches).

## 1. Intent and why

Make the FIRST import of a large Starlight project much faster. The measured baseline (the perf fixture, 2,000 pages x 6
locales = 12,000 files, local Postgres) is 271 s and 301 s for two runs, 268,001 SQL statements, 22.34 statements per
file, linear in file count. The unchanged re-import (about 10 s, 42 statements) and the export (about 11 to 13 s, 40 to
50 statements) are a different path and are NOT part of this design.

The owner has not said which workload hurts them (one-time first import versus the repeated unchanged import and
export). The order below was chosen by the owner on 2026-11-18: first cut statements per file, then run locale writes
concurrently, then profile the 10 s unchanged-import path. This design covers the first two; the profile is a separate
measurement and decides whether any Rust or Bun work is justified at all.

## 2. Evidence (raw outputs in `.clavity/scratch/import-write-path/evidence/`, gitignored, local)

- Perf test, two runs: first import 271.2 s and 300.9 s (`perf-run1.log`, `perf-run2.log`).
- Exact statement trace at 10 and 20 pages (`trace.out`). A source page with a save and a publish per scope is one
  transaction of 39 statements: licence reads 4, `select collection` 4, savepoints 4, `for update` row locks 4 (2 of them
  in publish), `begin`/`commit` 2, clock reads 2, existence probes 2, slug advisory lock 2, document insert 1, content 14.
  A locale file (save + publish) is one transaction of 19: licence reads 2, `select collection` 2, savepoints 2, `for update`
  2, `begin`/`commit` 2, clock 1, existence probe 1, content 7. 12 of the 19 carry no content.
- A bare round trip costs about 0.57 ms on the dev machine; the import averages 1.0 to 1.1 ms per statement
  (`prof.out`, `timing.out`). `synchronous_commit=off` made no separable difference: fsync is not the bottleneck.
- Markdown parsing is about 3% of wall time in a CPU profile of a 600-file import.
- Concurrency scaling in one Node process (`conc.out`): the JS thread is 48 to 51% busy at one connection, so the client
  waits half the time. The real `saveDraft` + `publish` transaction per locale file, documents partitioned across
  workers, scales 2.3x (2 workers), 2.9x (4, noisy, 2.0 to 4.0x) and 4.8x (8, range 4.2 to 5.6x), error-free; the JS thread
  saturates (96 to 99% busy) at 8.
- Caveats: background load was uncontrolled (desktop session, the agent's own process at 50%); two samples per arm;
  100 documents in the concurrency probe, not 2,000; localhost database; the figures are one machine's.
- Review: an agy consult (seam `.clavity/seams/import-write-path-first.md`) agreed on direction and was corrected on its
  arithmetic; agy panel rounds 1 to 5 (`.clavity/seams/import-write-path-panel-r1.md` to `-r5.md`) found 22 further findings; 21 were
  folded and 1 was rejected by measurement. Round 5 was the fifth of a default cap of six, and it still found three small
  contract-level defects, so the panel has NOT closed GREEN; the owner decides whether a sixth round is worth running.
- Measured after implementation (controller, top level, 2,000 pages x 6 locales = 12,000 files, 0 errors, two runs each,
  commit `7bc830c`, perf test `MOGGING_PERF=1 pnpm --filter @mogging/markdown test perf --reporter=verbose`; background
  load uncontrolled: a desktop session at about 8% CPU, no other agent or test running; the baseline figures above were
  taken on the same machine in an earlier session, so the ratio is between sessions):
  first import at concurrency 1 (F1 alone): 141.0 to 156.5 s, 170,002 statements (baseline 271.2 to 300.9 s, 268,001),
  that is 1.7x to 2.1x; first import at concurrency 8 on a pool of 8: 66.1 to 68.2 s, 170,002 statements, 4.0x to 4.6x
  against that baseline and about 2.1x against concurrency 1; unchanged import 9.7 to 10.3 s / 42 statements (baseline
  about 10.2 s), export 10.6 to 10.7 s / 40 to 50 statements (baseline 11 to 13 s): not slower. The success bar (at least
  2.5x at concurrency 8) is met. Not measured: concurrency 4 (the bar of at least 2x), because the perf test has no arm for
  it. The derived estimates in section 6 (about 1.5x for F1, 75 to 95 s at 8) were conservative.

## 3. Goals, non-goals, anti-goals

Goals
- G1. Statements per transaction, for a scope that is saved and then published: day-one locale file 19 to 12, source page 39 to
  25, so overall 22.34 to about 14.2 per file on the fixture (268,001 to about 170,000), with no change to stored data.
- G2. An opt-in concurrent locale phase: independent documents written in parallel on separate pool connections.
- G3. Expected result, DERIVED not measured: with 8 workers and a pool of 8, the first import is about 3.6x faster (about
  75 to 95 s on the fixture); at the CLI default of 4 workers about 2.4 to 3.4x (about 80 to 125 s, wide because the
  4-worker arm was noisy).
- G4. A committed, non-gated test that pins the statement counts per transaction kind exactly, so the saving cannot
  silently regress.

Non-goals (recorded, not rejected forever)
- Bun runtime support and Rust anywhere. They cannot change the 270 to 300 s; revisit only after the unchanged-import
  profile.
- Fusing save and publish into one insert (a possible 5 to 6 statements per locale file; equivalence of the final row is
  unverified), concurrency in the source phase (it serializes on the collection slug lock), a set-based bulk path,
  worker threads or processes (the single JS thread saturates near 5x), the generic `importFolder` and `renamePage`
  call sites (same helpers, mechanical follow-up, unmeasured), and anything about export or the unchanged import.

Anti-goals (a failure even if the numbers improve)
- Any change to stored bytes, normalization or hashes (storage contracts in `AGENTS.md`).
- Weakening the licence gate by accident or through the supported API. A deliberate bypass stays exactly as possible
  as today (direct SQL; the licence terms forbid it, `CONTENT_ARCHITECTURE.md` 6.2), so a forgeable run handle is not
  a regression, but no supported entry may write without a licence check having been made for the run.
- Changing when a licence is required: a dry run and an import that writes nothing must keep working without a licence.
- Non-deterministic reports: the same input must give the same files, warnings and errors in the same order.
- A speed-up that only exists on localhost: round trips are what is being removed, and a remote database makes each one
  cost more, so the per-kind statement count, not wall time, is the pinned property.

## 4. Constraints (all from `AGENTS.md`, verified in code)

- Entry guards: `assertLicensed(ctx)` first, then `assertActor(ctx)`; "Never call either inside an internal helper that
  a loop calls". Today `saveDraft` (`saveDraft.ts:56-57`) and `publish` (`publish.ts:35-36`) each guard, and the import
  loops call them per file (`importStarlight.ts:324-327`, `:637-640`), which is the repeated licence read. The guard is
  reached only when a write is attempted: `saveDraft` runs only for `act === "save"`, and a dry run skips the apply phase
  (`importStarlight.ts:673-676`).
- Public functions validate, then open their own transaction (`saveDraft.ts:91`, `publish.ts:41`). Inside a caller's
  transaction that becomes a savepoint, which lets a caller catch an error and continue. The public behaviour and
  statements must not change.
- `publishWithinTx` requires its caller to hold the `documents` row lock and to pass the clock instant
  (`publishCore.ts:21-25`); its only callers are `publish` and `releases` (`releases.ts:264`).
- Lock order: `documents` rows, then the collection slug advisory lock (`slugGuard.ts:21`). Locale writes take only their
  own `documents` row (trace: no slug lock in a locale transaction), so documents are independent.
- `packages/core/test/api.test.ts` pins the public export surface; a new public export is a deliberate edit.
- Per-file failure isolation: each file is its own transaction and a failure becomes that file's `error` outcome
  (`importStarlight.ts:643-647`); later files, including later locales of the same document, still run.
- A killed run must resume idempotently (the existing unchanged-file skip covers it).

## 5. Approaches considered

- A. Bun and/or Rust. Rejected for the write path: the cost is round trips (about half the wall time is the bare
  statement latency), parsing is about 3%. A Bun compatibility pass could still be done separately with no speed claim.
- B. Cut statements per file (F1). Chosen, first.
- C. Concurrent locale writes (F3). Chosen, second.
- D. A bulk set-based write path. Largest change, touches the storage contracts and the no-caller-string-in-SQL rule;
  deferred.
- E. Fused save and publish. A good follow-up once B is in; equivalence unverified.
Owner decision (2026-11-18): B then C, then profile the unchanged path. Why: B is cheap and reduces the work C
parallelizes; C's gain was measured.

## 6. The design

### 6.1 Part 1: statements per file (F1)

A "write run" in `@mogging/core`. Names are the builder's; the contract is:
- Creating the run performs `assertLicensed` then `assertActor` once. Creation is LAZY and memoized: it happens at the
  first write of an apply phase, before any worker starts, never at the start of the import. A dry run, a run whose
  files are all unchanged, and a prune-only run therefore never touch the guard, as today.
- The run handle carries `config` and `actor` only, NOT `sql`: the within-tx writers use the transaction handle they are
  given, so no code path can reach the root pool from inside a transaction (that would need a second connection and could
  deadlock a fully used pool).
- `saveDraftWithinTx(tx, run, input, { collection })`: the same validation as `saveDraft`, in the same order relative to
  the row lock (validation first, then `for update`), with no savepoint, no licence read and no collection probe; the
  importer passes the collection it already knows. It keeps its own `documents ... for update` select (that select is also
  the existence and soft-delete check) and the rest of the statements unchanged.
- `publishWithinTx` gains an OPTIONAL `collection` argument (omitted by `publish` and `releases`, so they are
  unchanged). The hint stands in for `docRow.collection` EVERYWHERE the function uses it, including the shared-scope slug
  lock and uniqueness check, which today are guarded by `docRow` (`publishCore.ts:101-104`): a hinted shared publish must
  still take the slug lock and refuse a duplicate slug, pinned by a test. `publishWithinTx` itself keeps requiring a caller-held row lock and the
  caller's stamp, so `publish` and `releases` (which lock every item and pass one shared stamp, `releases.ts:262-268`) are
  unchanged. The importer instead calls a NEW function (the builder's name, say `publishWithinRun`) that wraps it: it takes
  the row lock and the clock instant itself unless the caller says the same
  transaction already locked that document (a save just ran), in which case it skips only the duplicate lock.
- The public `saveDraft` becomes a thin wrapper over the new inner `saveDraftWithinTx` (one implementation of the rule);
  `publish` already wraps `publishWithinTx` (`publish.ts:47`) and is not modified. Their observable behaviour and statements
  are unchanged and pinned by the existing suites.
- Savings per transaction: 2 savepoints, 2 licence reads, 2 collection reads, 1 duplicate row lock = 7, so a locale file
  is 19 to 12 and a source page 39 to 25 (4 + 4 + 4 + 2). A publish-only transaction (an item whose `act` is `publish`,
  `importStarlight.ts:31,597`) has no earlier save, so it keeps its own lock and clock; its count is measured at plan time
  and pinned like the others. The transaction kinds the importer produces, each pinned separately: (1) source page,
  save + publish: 25; (2) locale file, day-one (`untracked`) save + publish: 12, the kind the perf fixture measures;
  (3) locale file, tracked save + publish: 13, because a tracked save also reads the source's published head
  (`saveDraft.ts:148-152`); (4) locale file, day-one save only; (5) locale file, tracked save only (the importer sets `untracked` and `publish`
  independently, `importStarlight.ts:594`, so a save has four variants); (6) locale file, publish only. Kinds 4 to 6 are
  measured at plan time. The
  existence probe and the clock read stay in this design.
- Validation precedence: the within-tx path trusts the importer's collection and document id, so a document that is
  invalid in two ways at once, or deleted concurrently, can report a different first error than the public path. The
  importer's inputs are produced by its planner, so this is accepted and documented in the writer's JSDoc.
- The importers create the run lazily and use the within-tx writers inside their existing per-file `ctx.sql.begin`
  transaction. Per-file transactions, error capture and outcomes stay as they are. Both phases of the Starlight import use
  it. Errors propagate out of the per-file callback today, so the removed inner savepoints isolated nothing at these call
  sites.

### 6.2 Part 2: concurrent locale writes (F3)

- Option `starlight.concurrency` (SDK default 1, so behaviour and single-connection pools are unchanged). The SDK validates it before any
  write: anything but an integer of at least 1 throws a `ValidationError` (as `importFolder` already does for a missing
  directory, `import.ts:191`). The CLI gets
  `--concurrency <n>`: parsed with the existing `intOption("concurrency", text, 1, 8)` (`args.ts`), with NO parser
  default (the default of 4 is applied in code, so a default cannot be mistaken for a user-supplied value), and listed as a
  Starlight-only flag whose detection (`given()`, today `flags[name] === true`) is extended to string values, so a generic
  project that passes it gets the same usage error as `--prune`.
- Effective concurrency is 1 when `ctx.sql` is a transaction handle (it has `savepoint`; concurrent savepoints on one
  connection would interleave) or when `sql.options.max` is not a positive integer (`options` is not in the postgres.js
  README, so it is read defensively); otherwise it is `min(requested, sql.options.max)`. Both the requested and the effective
  value are ALWAYS reported (also when they are equal, and in a dry run) in the `starlight` details (an additive field on `StarlightImportDetails`, a type
  change and not a change of the runtime export list) so a test can assert them. Nothing is added to `warnings`: it is
  file-scoped (`FileMessage`) and the CLI prints it as `warning: <file>: <message>` (`commands/import.ts:70`), so a
  run-level note would print as `warning: : ...`; when, and only when, the effective value is lower than the requested one the CLI prints one
  line from the details, `concurrency: <effective> of <requested> (<reason>)`, in `starlightLines`
  (`commands/import.ts:50-73`) directly after the optional `dry run` line and before the per-file lines, pinned by an output
  test; `--json` carries the details. `starlightLines` is a pure function of the report (`commands/import.ts:50`), so the
  details carry everything the line needs: `concurrency: { requested, effective, limit, poolMax? }`, where `limit` is `"pool"`,
  `"transaction"` or `"unknown"` (a discriminator, because a transaction handle and an unreadable pool size would otherwise
  look identical), and `<reason>` is `the pool allows <poolMax>` for `pool` (the only case that carries `poolMax`),
  `a transaction handle runs one write at a time` for `transaction`, and `the pool size is unknown` for `unknown`.
- Every query inside a worker's transaction uses the transaction handle only (the run handle has no `sql`), so a worker
  never needs a second connection and cannot deadlock the pool.
- A sequential pre-pass keeps today's order for everything that has side effects on the report (resolving the document id,
  the "English page was not imported" warning at `importStarlight.ts:625`, skipping `none`). Only the writes are dispatched.
  If at least one item survives the pre-pass (a `none` item is skipped at `importStarlight.ts:632`), the memoized run is
  obtained here, created only if the source phase did not already create it, before the first worker starts; when nothing
  survives it is never created.
- Items are grouped by the document id RESOLVED by the pre-pass (a page created in this run gets its id from the source
  phase's outcome); workers take whole groups from a shared queue, so one document's locales are written by one worker, in
  order, and two workers never contend for a `documents` row. Inside a group a failed locale does not stop the later ones.
- Workers never reject. Every error is recorded as that file's `error` outcome exactly as today, and all workers have
  settled before `importStarlight` returns, so a caller's `finally { sql.end() }` never races an in-flight transaction.
  After the run is created no licence error can occur mid-run (D3), so there is no abort path.
- Outcome and error maps are keyed by path and the report is sorted by path (`importStarlight.ts:677-678`), so the result
  does not depend on completion order. Warnings are produced only in the pre-pass.
- The source phase stays sequential: it takes the collection slug lock for about 85% of its statements.
- Ceiling: about 5x per process at 8 connections; beyond that is out of scope.

## 7. Decisions

Owner decisions so far: approach and order (section 5), and on 2026-11-19: D1 = (a), the unlisted subpath
`@mogging/core/internal`; D2 = accepted as written; D3 = accepted (the licence is checked once per run, lazily at the first
write); no sixth panel round. The positions that led to them are kept below for the record.

Decisions (RESOLVED on 2026-11-19):
- D1. Visibility of the write-run entry. This is an open design fork; the two positions below were reached
  independently and are NOT reconciled. Neither choice protects the licence gate (`assertLicensed` is already public and
  direct SQL bypasses it either way), so the choice is about commitment and packaging.
  - (a) An unlisted subpath `@mogging/core/internal` [driver's recommendation]: no new public API promise before the first
    publish (v0.1 is not published yet, so a public commitment now is the expensive direction); not listed in
    `api.test.ts`. Costs: core's `exports` and `publishConfig`, a pin test for the subpath's export list, coverage in
    `check-publish-ready.mjs`, and an exact `@mogging/core` pin in `@mogging/markdown` (`workspace:*` is rewritten to the exact sibling version and
    `scripts/lib/pack-checks.mjs:54` already fails any other value) because a version skew would break at run time. Markdown and ai exports are unchanged.
  - (b) A public root export [agy's recommendation]: one formal, versioned surface that bulk-ingestion adopters can also use;
    no packaging fragility. Costs: an `api.test.ts` edit and a stability promise on a shape not yet proven.
- D2. SDK default concurrency 1; CLI default 4; the CLI default pool raised from 4 to 8 (`packages/cli/src/run.ts:45`),
  which agy and the driver both recommend. Measured: a pool with `max: 8` held 1 backend after 40 sequential queries and 8
  only under concurrent demand, so the raise costs nothing at rest. Alternative: size the pool from the flag (feasible,
  `loadProject` has the flags in scope, but it changes the generic project loader).
- D3. The licence is checked once per run, at the first write, instead of at every write. Today an evaluation window that
  ends mid-import aborts the run at the next write; after this change a run that started licensed finishes. Agy and the
  driver both accept it provided the check is lazy (6.1). It is a visible behaviour change in the paid product, so it is the
  owner's call.

My calls (change them if you disagree): scope is the Starlight import only; the generic `importFolder` and `renamePage`
follow; the existence probe and clock read are left alone; the CLI maximum is 8, the pool size (a larger request could only ever clamp; the SDK may ask for more with a bigger pool); `AGENTS.md` and
`CONTENT_ARCHITECTURE.md` 6.2 get a note "guarded once per write run"; the concurrency measurement is kept as a
`MOGGING_PERF`-gated arm of the existing perf test.

## 8. Verification

Oracles and checks the plan must carry:
- All existing suites pass unchanged (public behaviour is pinned).
- Statement counts, pinned EXACTLY per transaction kind with a counting connection in a non-gated test.
  `countingSql` (`packages/markdown/test/starlight/fixtures.ts:104-111`) only increments a counter, so a sibling helper that
  also records each statement's text (its `debug` callback receives it) is part of the work. Source page (save + publish)
  25, day-one locale file (save + publish) 12, tracked locale file (save + publish) 13, day-one save-only, tracked save-only
  and publish-only (measured at plan time), plus the statement SEQUENCE of each as a golden. A per-locale
  transaction contains no savepoint and no licence read; the whole import makes at most one licence read (the
  memoized run is shared by the source and locale phases). An aggregate ceiling is not enough: a regression confined to source pages would pass it.
- Differential check: before the change, dump the end state of a fixed project from the current HEAD (per slug, locale,
  version, state, data, source hashes, `created_by`, `published_by`, head flags; ids and timestamps excluded) and commit it
  as a golden; the changed implementation must reproduce it at concurrency 1.
- Concurrency equivalence: the same project at concurrency 1 and 4 into two schemas gives equal dumps (the fields above)
  and equal sorted reports. The pool for these tests is built with `connection: { search_path }` and `max >= c`, NOT
  `withTestDb` (`packages/markdown/test/db.ts:10-13` uses `max: 1` and a session-level `set search_path`, so a concurrency
  test on it would silently clamp to 1 and pass vacuously). Each test asserts the reported effective concurrency.
- Failure isolation at concurrency 4: a file that fails to publish becomes an `error` outcome, its later-locale siblings in
  the same document still run, and other documents stay committed. A pool with `max: 2` and concurrency 8 clamps (the details report requested 8,
  effective 2) and finishes within a timeout. A transaction handle as `ctx.sql` runs at 1. A run with an expired licence and
  nothing to write, and a dry run, still succeed; an expired licence with one write fails before any write.
- CLI: `--concurrency 0`, `9` and `x` are usage errors; on a generic project the flag is a usage error. The clamp line is pinned by an output
  test (its text, its position, and its absence when nothing is clamped), and `--json` is asserted to carry
  `concurrency: { requested, effective, limit, poolMax? }`. SDK: a `starlight.concurrency` of `0`, `-1`, `0.5` or `NaN`
  throws `ValidationError` before any write.
- A pin test for the new surface chosen in D1, and a test that the other export lists did not change.
- Measurement protocol (top-level only, backgrounded, no concurrent tool calls, two runs, quote the range, say the load was
  uncontrolled), using the existing gated perf test (`packages/markdown/test/starlight/perf.test.ts`) plus the new
  concurrency arm. Success bar: the first import at least 2.5x faster than the 271 to 301 s baseline (about 115 s or
  better) at 8 workers and a pool of 8; at the CLI default of 4 at least 2x; the unchanged import and export not slower than
  10 to 13 s. Expected 75 to 95 s (8 workers).
- Mechanism-gamer note: the statement counts are pinned as counts, not times, so they cannot be satisfied by moving the
  cost elsewhere; wall time is reported but not asserted.

## 9. Risks and unknowns

- Not measured: scale (2,000 documents), contention beyond independent documents, a remote database, and the interaction of
  F1 with F3 (the per-statement cost of what remains is likely higher than the average, so the combined figure is a
  ceiling-ish estimate).
- The in-process ceiling (about 5x) and the serial source phase (about 29% of statements) bound the whole-import gain at
  roughly 2.2 to 2.4x for F3 alone and 3 to 4x with F1.
- D3 is a product-behaviour change; D1(a) touches the package export map just before the first publish.
- The day-one save-only, tracked save-only and publish-only transaction kinds, and source pages that mix saved and
  publish-only scopes, are not yet measured.

## 10. Left to the builder

Names of the new functions and the subpath (if any); the fixtures; how the CLI threads the pool size; whether to also merge
the existence probe; the commit split between the core refactor, the importer change and the concurrency.

## Stand-downs

None discarded below the floor in rounds 1 to 5. One round-2 finding was REJECTED by measurement: that `workspace:*` permits
range resolution (`scripts/lib/pack-checks.mjs:54` fails any workspace dependency whose value is not exactly the sibling's
version). D1 was an owner decision and is resolved (section 7). The panel stopped after round 5 at the owner's choice and did NOT close
GREEN.

End of design: import write path.
