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
