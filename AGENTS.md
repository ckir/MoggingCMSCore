# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, Gemini/Antigravity and others) when working
with code in this repository.

MoggingCMS is a multilingual content engine: a pnpm TypeScript monorepo over PostgreSQL, with no HTTP API, admin UI or
auth layer. Applications call the `@mogging/core` SDK or the `mogging` CLI directly. See `README.md` for setup and the
env-var table, `docs/CONTENT_ARCHITECTURE.md` for the data model and lifecycle, `docs/API_INTEGRATION.md` for SDK
consumers, and `docs/dev-setup.md` for the test database.

## Commands

Requires Node >= 22, pnpm, and Postgres. **Every test touches the database:** export `DATABASE_URL` first
(`postgres://mogging:mogging@localhost:5432/mogging_test`, created per `docs/dev-setup.md`). Nothing loads `.env`.
On the owner's dev machine the test database is the private Postgres on port 54329
(`postgres://mogging:mogging@127.0.0.1:54329/mogging_test`). There, port 5432 rejects the `mogging` password, and
almost every database test fails with `password authentication failed for user "mogging"`. Read that error as a
wrong `DATABASE_URL`, not as a code regression.

```bash
pnpm test                                    # all packages (vitest projects)
pnpm test api                                # file filter across all packages
pnpm --filter @mogging/core test saveDraft   # one package, files matching "saveDraft"
pnpm --filter @mogging/core test api -t "exactly the contract"   # one test by name
pnpm typecheck                               # tsc --noEmit per package: the static gate (no linter/formatter exists)
pnpm build                                   # tsc to packages/*/dist
pnpm smoke:pack                              # pack + install tarballs outside the repo, run `mogging` (needs network)
pnpm check:publish                           # pack all five packages (prepack rebuilds dist) and check each tarball; no database
pnpm --filter @mogging/cli dev <command> --config /abs/path/mogging.config.ts   # CLI from source via tsx
pnpm accept:starlight                        # acceptance run of templates/starlight against packed packages (needs DATABASE_URL and the npm registry)
pnpm accept:adopter                          # acceptance run of the existing-adopter Starlight fixture (same needs)
```

- **Never insert `--`** after `test` or `dev`. `pnpm --filter X test -- claim` passes `--` to vitest, which drops the
  filter and runs the whole suite. `pnpm --filter @mogging/cli dev -- init` fails with `unknown command --`.
- The CLI `dev` script runs with `packages/cli` as its cwd, so config and content paths must be absolute.
- `accept:starlight` and `accept:adopter` (`scripts/starlight-accept.mjs`, `scripts/starlight-adopter.mjs`) install
  from the npm registry and run `astro build`, so they are not part of `pnpm test`. `.github/workflows/ci.yml` has a
  `check` job (typecheck, test, smoke:pack) and a `starlight` job that runs both.
- The live OpenRouter test (`packages/ai/test/live.test.ts`) is skipped unless `MOGGING_LIVE=1` and
  `OPENROUTER_API_KEY` are set. It spends real money.

## Package layering

`core` <- `markdown` <- `ai` <- `cli`. `ai` depends on both `core` and `markdown`, and `cli` depends on all three.
`core` imports none of the others. `starlight` (`@mogging/starlight`) depends on `core` and `markdown` (types for the
preset); the CLI does not depend on it at run time, and a Starlight project's `mogging.config.ts` imports it. Its root
entry is a no-op Astro integration that imports nothing; the preset is the separate `@mogging/starlight/preset` entry.

- In the repo, every package's `main`/`exports` point at `./src/*.ts`, so vitest and tsx run from source with no build
  step. `publishConfig` swaps them to `dist` only at `pnpm pack`. `prepack` (`scripts/prepack.mjs`) deletes `dist` and rebuilds
  it, then verifies the published entry files, so a pack or publish never ships a stale `dist`.
- `core`, `ai` and `markdown` each have `test/api.test.ts`, which pins the exact public export surface. A new export
  must be added to that test deliberately. Don't leak internals through `src/index.ts`.
- `templates/starlight/` is the starter site; it sits outside the pnpm workspace and is exercised only by
  `accept:starlight`.
- Each package's `test/db.ts` has its own `withTestDb`. Each test gets a random `t_<hex>` schema, which is dropped
  afterwards. A killed run can leave stale schemas behind (see `TODO.md`).
- AI tests use `test/mockModel.ts`. The normal suite never calls a provider.

## Engine model (spans many files; read before changing core)

- **Schema:** the whole schema is `packages/core/migrations/0001_engine.sql`, FROZEN since v0.1 ship step 3 (2026-11-18,
  sha256 `a77665b7...`). Never edit it: a schema change is a new migration `0002_*.sql`. The runner applies files in name
  order and tracks them by name only. Two guards fail on an edit: the content pin in `packages/core/test/migrate.test.ts`
  and `pnpm check:frozen` (any commit after the freeze base that touches the file; CI runs it). Do not "fix" either by
  updating the pin or the freeze base: add `0002` instead. A database created before plan 7 (when `0001` was still
  edited in place) must be recreated once.
- **Snapshots and heads:** a document's content is immutable, full (never delta) snapshot rows per scope. There is one
  `shared` scope (`document_shared`, non-localized fields) and one scope per locale (`document_localized`). Each scope
  has at most one published head and one draft head, enforced by partial unique indexes. `state` records how a row
  was produced, not whether it is a head. `publish` flips the draft row in place. Republishing an old version inserts
  a copy.
- **States:** `DRAFT_HUMAN` and `APPROVED` are publishable. `DRAFT_AI` is never publishable and must go through
  `approve`. AI code never overwrites a `DRAFT_HUMAN` head. Full transition table: `CONTENT_ARCHITECTURE.md` section 3.
- **Storage contracts (changing any of them forces a re-track or re-translation of existing data):**
  - top-level `null` means "absent" and is stripped before writing; empty values are present and suppress fallback;
  - values are normalized at write time (`values/normalize.ts`), then hashed as SHA-256 over RFC 8785 canonical JSON
    (`values/hash.ts`);
  - `source_hashes` on target-locale rows drive staleness, which `sync/state.ts` computes on read against the
    source's published head.
- **Reads:** `resolve` sees only published heads. It applies a per-field fallback chain (field `fallback`, else
  `config.locales.chains`) in a single SQL query.
- **Data-safety invariants:**
  - U+0000 is rejected at every text boundary before any query;
  - no caller string is interpolated into SQL text (bind everything; field names and locales bind as JSONB);
  - money is integer micro-dollars;
  - deletes are soft (`deleted_at`).
- **Entry-guard order for writes:** call `assertLicensed(ctx)` first (on licence-guarded writes only), then
  `assertActor(ctx)` (`src/ctx.ts`). Never call either inside an internal helper that a loop calls. The list of
  guarded writes is in `CONTENT_ARCHITECTURE.md` section 6.2. `ctx = { sql, config, actor }`, and `actor` is
  attribution only.
  A write loop guards once through `beginWriteRun` (`@mogging/core/internal`, unlisted) and then calls the
  within-transaction writers (`saveDraftWithinTx`, `publishWithinRun`); that is the sanctioned form of the "never
  inside a loop helper" rule.
- **AI pipeline (`packages/ai`; the design spec has the full implementation notes):**
  - no LLM/provider call inside a database transaction;
  - one lock order everywhere: `ai_budgets` (global first), then the `ai_jobs` row, then `documents` (through
    `recordAiDraft`), then the collection slug lock (a transaction-scoped advisory lock taken after the `documents`
    rows of the same transaction, `packages/core/src/documents/slugGuard.ts`);
  - jobs are claimed with `FOR UPDATE SKIP LOCKED` and leases;
  - leases, back-off and budget months use the **database clock**, not the host's;
  - the AI SDK is called with `maxRetries: 0`, so every attempt is counted and paid once.
- **CLI (`packages/cli/src/run.ts`):** errors map to exit codes by `name`/`code`, never `instanceof`, because a user
  config may load a second copy of core. Usage errors exit 2, licence errors exit 3, anything else exits 1. Every
  stdout/stderr write passes through `maskSecrets`. Commands are thin layers over the SDKs, registered in
  `commands/index.ts`.

## Conventions

- Write standard JSDoc on every exported function, with a summary and documented params, returns and throws. The
  existing doc comments show the style. Write JSDoc on exported types too.
- ESM with `NodeNext` resolution and `verbatimModuleSyntax`: relative imports use the `.js` extension, and type-only
  imports use `import type`.
- Commit subjects use a conventional `type(scope): summary`, for example `fix(core,ai): ...`, `test: ...` or
  `docs: ...`.

## Design docs and tracked debt

- `docs/superpowers/specs/2026-11-11-moggingcms-core-design.md` is the authoritative engine design. Code comments cite
  it as "spec N.N".
- Plans live in `docs/superpowers/plans/`. The Starlight integration spec is implemented: plan 6a built the SDK half (the core slug guard and `untracked` saves, `includeUntracked` in `ai`, the Starlight mode of `markdown`'s import, export and `renamePage`), and plan 6b built the CLI commands (`init --starlight`, the Starlight modes of `import` and `export`, `rename`, `track --collection`, `compile --include-untracked`), the `@mogging/starlight` package, the starter template, the two acceptance runs and CI. The ship steps after it (publishing, freezing migration 0001) are the owner's.
- `TODO.md` holds tracked debt and accepted limits. Some items are deliberate decisions, not bugs. For example, aborted
  provider calls record no spend, and tests must not pin that behaviour with a spend assertion. Read the item before
  "fixing" one.
- `docs/agy-capstone-ledger.md` and `docs/agy-test-audit-ledger.md` record completed review gates, one row per gate,
  newest at the bottom.
