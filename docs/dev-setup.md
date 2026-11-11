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
