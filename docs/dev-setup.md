# Development setup

Requirements: Node >= 22, pnpm, PostgreSQL.

## Test database

Standard setup (default port 5432):

```bash
sudo -u postgres psql -c "CREATE ROLE mogging LOGIN PASSWORD 'mogging';" -c "CREATE DATABASE mogging_test OWNER mogging;"
```

Expected: `CREATE ROLE` and `CREATE DATABASE`.

Then:

```bash
pnpm install
DATABASE_URL=postgres://mogging:mogging@localhost:5432/mogging_test pnpm test
pnpm typecheck
```

`DATABASE_URL` may point elsewhere, for example a private Postgres on another port such as
`postgres://mogging:mogging@127.0.0.1:54329/mogging_test`. See `.env.example`.

Each test uses `withTestDb` (`packages/core/test/db.ts`), which creates a schema `t_<random8>`,
runs the test inside it and drops it afterwards.

Databases created before plan 4 must be recreated (drop and create the database, then run `migrate` again): migration
`0001` was edited in place (the `field_warnings` column and the unique release name), and `migrate` tracks applied
migrations by name only. An old database therefore reports "up to date", and `approve` then fails on the missing column.

## Running one test file

Put the file filter directly after `test`: `pnpm --filter @mogging/ai test claim` runs only the matching file.
Do not write `pnpm --filter @mogging/ai test -- claim`: the `--` is passed to vitest literally, the filter is lost,
and the whole package suite runs (measured 2026-11-13: 17 files, 278 tests instead of 1 file, 32 tests).

## Build and pack smoke

`pnpm build` compiles each package with plain `tsc` into `packages/*/dist` (`.js` and `.d.ts`; `dist` is git-ignored).
In the repository every package keeps `main`/`exports` at `./src/index.ts` (the CLI at `./src/run.ts`), so vitest and
`tsx` run from source; the `publishConfig` of each manifest points them at `dist`, and `pnpm pack` applies that override.

```bash
pnpm build
DATABASE_URL=postgres://mogging:mogging@localhost:5432/mogging_test pnpm smoke:pack
```

`pnpm smoke:pack` (`scripts/pack-smoke.mjs`, not part of `pnpm test`) builds, packs the four packages into a temporary
directory, installs the tarballs with `npm install` into an empty project outside the repository, and runs the installed
`mogging` binary (`--version`, `init`, `import --publish`, `status`, `query`) against a throwaway schema `smoke_<random>`
of the test database. It also checks that every tarball contains `LICENSE.md`. The schema is dropped at the end, even
after a failure. Expected: one `OK` line per step, then `smoke:pack passed`, and exit code 0. `mogging jobs` is skipped
because it needs the optional `ai` configuration.

`pnpm smoke:pack` needs network access: `npm install` fetches the registry dependencies of the tarballs (`jiti`,
`postgres`, `ai` and the rest). Without it the step fails with an npm error, not with a test failure.

Each package's `prepack` copies the root `LICENSE.md` into the package directory (`scripts/copy-licence.mjs`); these
copies are git-ignored.

## Live provider test (optional)

`packages/ai/test/live.test.ts` translates the seeded document through the real OpenRouter API with
`openai/gpt-4o-mini` and checks the outcome and the recorded cost (under 2000 micro-dollars, a fraction of a cent).
It is skipped unless both variables are set, so the normal suite never calls a provider and never spends money:

```bash
MOGGING_LIVE=1 OPENROUTER_API_KEY=... DATABASE_URL=postgres://mogging:mogging@localhost:5432/mogging_test \
  pnpm --filter @mogging/ai test live
```

`MOGGING_LIVE` opts in to the call. `OPENROUTER_API_KEY` is your own key, read only by the provider the way production
reads it; the test never prints or stores it. Keep the key in your shell or an untracked `.env`, never in a tracked file.
Expected: one passing test. A `FAILED` job whose provenance rows all say `validation:` also passes, because the model
is rejected by the validator about one time in ten.

### Spend limit on the key

Give the OpenRouter key a credit limit in the OpenRouter dashboard, for the live test and above all in production.
The application's monthly cap only counts calls that returned usage; calls the worker aborted may still be billed
(see the `@mogging/ai` README, Known limits). The key's own limit is the real circuit breaker. `GET /api/v1/key`
(bearer auth) returns `usage`, `limit` and `limit_remaining` for the key, which is also how to reconcile the bill with
`listProvenance`. Run such a check from your shell with the key in the environment; never write the key into a file or a
command line that is logged.
