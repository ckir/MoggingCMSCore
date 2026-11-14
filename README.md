# MoggingCMS

MoggingCMS is a multilingual content engine for TypeScript teams: a Postgres-backed content store
with per-field localization, draft/publish versioning, translation staleness tracking, an AI
translation pipeline, Markdown/MDX import and export, and a `mogging` command line.

It is a **custom engine, not a framework wrapper**. There is no Payload, Strapi, Sanity, Keystatic
or Directus underneath it, and there is no HTTP API, GraphQL endpoint, admin UI, user account
system or media library. Applications use the `@mogging/core` SDK directly from Node.js (or the
CLI), and render the returned data themselves. The monorepo is the product.

> **Status:** v0.1 pre-release. Every package is version `0.0.0`, private, and not published to npm
> yet. MoggingCMS is source-available under a commercial/noncommercial licence; it is **not open
> source**. See [LICENSE.md](LICENSE.md).

## What is in the repository

| Package | Purpose |
| --- | --- |
| [`@mogging/core`](packages/core/README.md) | The engine: collection/config definitions, versioned document snapshots, draft/publish/release lifecycle, per-locale field resolution, translation sync state, licences, and the Postgres schema. |
| [`@mogging/ai`](packages/ai/README.md) | Translation jobs on top of core: stale-field discovery, OpenRouter (or custom AI SDK) calls, budgets, leases, validation, glossary checks and provenance. |
| [`@mogging/markdown`](packages/markdown/README.md) | Markdown/MDX ↔ portable rich-text tree conversion, plus whole-folder import and export against core. |
| [`@mogging/cli`](packages/cli/README.md) | The `mogging` executable: init/migrate, import/export, status/track, compile/worker/jobs, review/approve, publish/release, query. |

There are no other deployable services. The repository also contains design documents
(`docs/superpowers/`) and the offline licence signing tool (`tools/licence/sign.ts`).

## Requirements

- **Node.js 22 or newer** (tested with Node 24.21.0).
- **pnpm 12.8.1** (the lockfile and workspace commands assume pnpm).
- **PostgreSQL 16 or newer** (tested with PostgreSQL 18). The `postgres` npm driver is a dependency
  of `@mogging/core`; no ORM or migration framework is used.

## Local setup

### 1. Install dependencies

```bash
git clone <this repository>
cd MoggingCMSCore
pnpm install
```

`pnpm install` links the four workspace packages. The root has no runtime dependencies of its own.

### 2. Create the database

The commands from [docs/dev-setup.md](docs/dev-setup.md) create the role and test database used by
the suite:

```bash
sudo -u postgres psql \
  -c "CREATE ROLE mogging LOGIN PASSWORD 'mogging';" \
  -c "CREATE DATABASE mogging_test OWNER mogging;"
```

Point the process at it. The repository's [.env.example](.env.example) contains only the URL; no
code loads `.env` automatically, so export the variable in your shell (or use your process
manager's environment):

```bash
export DATABASE_URL=postgres://mogging:mogging@localhost:5432/mogging_test
```

### 3. Run the checks

```bash
pnpm test        # vitest across packages; needs DATABASE_URL (tests create/drop schemas)
pnpm typecheck   # tsc --noEmit for core, markdown, ai, cli
pnpm build       # compile each package to packages/*/dist
pnpm smoke:pack  # pack the four tarballs, install them in a temp project, run `mogging`
```

`pnpm test` uses `withTestDb` (`packages/core/test/db.ts`): each test gets a random schema and
drops it afterwards. Tests never seed a shared database. There is no seed script.

### 4. Apply the schema and create a project config

The engine tables are created by `migrate`. The CLI's `init` writes a starter `mogging.config.ts`
and then applies the migrations:

```bash
DATABASE_URL=... pnpm --filter @mogging/cli dev init --config /absolute/path/to/mogging.config.ts
```

`pnpm --filter @mogging/cli dev` runs the TypeScript entry point with `tsx` and uses
`packages/cli` as its working directory. Pass an absolute `--config` path (and absolute content
directories) when running it from this repository. Do **not** insert `--` before the arguments:
`pnpm --filter @mogging/cli dev -- init` passes `--` to the CLI and fails with
`unknown command --`.

The generated config is plain TypeScript:

```ts
import { defineCollection, defineConfig, slug, text, richText } from "@mogging/core";

const docs = defineCollection("docs", {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
});

export const config = defineConfig({
  collections: [docs],
  locales: { source: "en", chains: { de: ["en"] } },
});
```

**There is no Admin UI to open.** Content is written through the SDK, the CLI, Markdown import, or
the AI pipeline. The closest thing to a review screen is `mogging review` in a terminal and
`mogging review show` for scripted output.

### 5. Import and read content

```bash
# content/en/docs/intro.md -> published `docs/intro`
DATABASE_URL=... pnpm --filter @mogging/cli dev import /absolute/path/to/content \
  --config /absolute/path/to/mogging.config.ts --publish

DATABASE_URL=... pnpm --filter @mogging/cli dev query docs/intro --locale de \
  --config /absolute/path/to/mogging.config.ts
DATABASE_URL=... pnpm --filter @mogging/cli dev query docs --json \
  --config /absolute/path/to/mogging.config.ts
```

The import layout is `<dir>/<locale>/<collection>/<slug>.md` (or `.mdx`). Front matter keys match
field names; the Markdown body fills the collection's single `body` field. See
[packages/markdown/README.md](packages/markdown/README.md) for the full mapping and limits.

### 6. Optional: enable AI translation

Add an `ai` export to the config and set `OPENROUTER_API_KEY`. `compile`, `worker` and `jobs` require
it; the other commands do not.

```ts
import { defineAiConfig } from "@mogging/ai";

export const ai = defineAiConfig({
  provider: { kind: "openrouter" },
  models: { translate: "<vendor>/<model-id>" },
  prices: { "<vendor>/<model-id>": { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 128000 } },
  budgets: { monthlyCapUsd: 10 },
});
```

Then enqueue and run:

```bash
DATABASE_URL=... pnpm --filter @mogging/cli dev compile --locales de --budget 2 \
  --config /absolute/path/to/mogging.config.ts
```

The model id and prices are examples: use your provider's current values. A translation is stored
as `DRAFT_AI` and must be reviewed and approved before it can be published.

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | SDK, CLI, tests | PostgreSQL connection string. The CLI prefers `--database-url`, then `MOGGING_DATABASE_URL`, then `DATABASE_URL`. |
| `MOGGING_DATABASE_URL` | CLI | Alternative database URL; wins over `DATABASE_URL`. |
| `MOGGING_ACTOR` | CLI | Attribution recorded on writes when `--actor` is absent. Defaults to the OS user, then `cli`. This is attribution, not authentication. |
| `MOGGING_LICENSE_KEY` | core, CLI | Offline licence token. Wins over `license` in `defineConfig`. |
| `OPENROUTER_API_KEY` | `@mogging/ai` | Provider key when the AI config uses `kind: "openrouter"`. |
| `VISUAL`, `EDITOR` | CLI review | Editor for interactive field edits; falls back to `vi`. |
| `NO_COLOR` | CLI review | Disables colour. |
| `MOGGING_LIVE` | tests | Opts into the live OpenRouter test. |
| `MOGGING_LICENSE_PRIVATE_KEY` | `tools/licence/sign.ts` | Private Ed25519 key for signing licence tokens; never committed and never read by the engine. |

The [.env.example](.env.example) file documents only `DATABASE_URL`. The CLI does not read `.env`,
so a copied file has no effect until the variables are exported.

## Scripts and type generation

| Command | Location | What it does |
| --- | --- | --- |
| `pnpm test` | root | Runs every package's Vitest suite. Needs `DATABASE_URL`. |
| `pnpm typecheck` | root | `tsc --noEmit` for each package's `tsconfig.json`. |
| `pnpm build` | root | Compiles `src` of each package to `packages/*/dist` with declarations. |
| `pnpm smoke:pack` | root | Builds, packs all four packages, installs the tarballs outside the repository, and exercises the installed `mogging` binary against a throwaway schema. Needs `DATABASE_URL`. |
| `pnpm --filter @mogging/cli dev <command>` | repo | Runs the CLI from source with `tsx` (cwd is `packages/cli`). |
| `pnpm --filter <pkg> test` | repo | Runs one package's tests. |
| `prepack` | each package | Copies the repository licence into the package before packing. |

**There is no schema type-generation step.** Unlike Payload (`payload generate:types`) or Sanity
(`sanity typegen`), MoggingCMS does not emit a generated TypeScript file from the content schema.
Collections and fields are already TypeScript values created by `defineCollection`/`text`/`richText`
and their types are inferred by the compiler. Document payloads cross the SDK boundary as
`Record<string, unknown>`; an application that wants narrower types defines them itself. `migrate`
is the only schema-related command, and it applies the bundled SQL in
`packages/core/migrations/`.

If the database was created before plan 4, recreate it rather than reusing it: migration `0001` was
edited in place and the runner tracks migrations by name only. See
[docs/dev-setup.md](docs/dev-setup.md).

## Project structure

```text
.
├── packages/
│   ├── core/                     # @mogging/core
│   │   ├── migrations/
│   │   │   └── 0001_engine.sql   # the entire engine schema (documents, snapshots, jobs, releases)
│   │   ├── src/
│   │   │   ├── schema/           # field builders, defineCollection, defineConfig, locale normalization
│   │   │   ├── values/           # typed normalization, JSON hashing, U+0000 rejection
│   │   │   ├── documents/        # create/delete, saveDraft, publish/unpublish, approve/reject, recordAiDraft
│   │   │   ├── read/             # resolve, resolveReference, getDocument, listDocuments, review queries
│   │   │   ├── sync/             # translation staleness (current/stale/untracked/missing/orphaned)
│   │   │   ├── releases/         # named release sets and atomic publication
│   │   │   └── licence/          # offline Ed25519 key verification and the 30-day write guard
│   │   └── test/                 # integration tests; each test owns a throwaway schema
│   ├── ai/                       # @mogging/ai: jobs, worker, prompts, budgets, validation, provenance
│   ├── markdown/                 # @mogging/markdown: parse/serialize, sentinels, folder import/export
│   ├── cli/                      # @mogging/cli: bin.ts, commands/, output, config loading
│   └── ...
├── docs/
│   ├── dev-setup.md              # database, tests, build, smoke test
│   ├── CONTENT_ARCHITECTURE.md   # data model, lifecycle, localization, security
│   ├── API_INTEGRATION.md        # SDK/CLI integration for frontend applications
│   └── superpowers/              # design specs and implementation plans (design-only unless stated)
├── scripts/
│   └── pack-smoke.mjs            # the pack/install/run check behind `pnpm smoke:pack`
├── tools/
│   └── licence/sign.ts           # offline licence-token signer (not shipped in the SDK)
├── spikes/                       # isolated experiments (workspace members)
├── TODO.md                       # tracked debt and accepted limits
└── package.json                  # root test/build/typecheck/smoke scripts
```

Where the usual CMS concepts live:

- **Content models:** in the adopter's `mogging.config.ts` (or `.mts`/`.js`/`.mjs`), built with
  `defineCollection` and the field builders from `@mogging/core`. There are no built-in content
  models in the repository itself.
- **Validation:** field-shape and locale validation live in `packages/core/src/values/`,
  `packages/core/src/schema/`, and per-operation checks in `packages/core/src/documents/`. Custom
  field validators do not exist as an extension point; adding a field kind means changing core.
- **Lifecycle logic:** `packages/core/src/documents/` and `packages/core/src/releases/`. There are
  no user-configurable `beforeChange`/`afterRead` hooks.
- **Access rules:** none. The only gate is the licence check in `packages/core/src/licence/`; there
  is no authentication or RBAC layer.
- **Plugins, admin UI, custom field components:** not present in v0.1. The AI worker and Markdown
  package consume the core SDK rather than plugging into an extension system.

## Documentation

- [docs/dev-setup.md](docs/dev-setup.md) — database creation, test isolation, building, smoke test,
  live AI test.
- [docs/CONTENT_ARCHITECTURE.md](docs/CONTENT_ARCHITECTURE.md) — collections and fields, the
  database ER model, publishing and localization rules, AI pipeline, licence and security model.
- [docs/API_INTEGRATION.md](docs/API_INTEGRATION.md) — how frontend applications read content
  through the SDK and CLI, including pagination, rich-text rendering and draft review.
- [packages/core/README.md](packages/core/README.md),
  [packages/ai/README.md](packages/ai/README.md),
  [packages/markdown/README.md](packages/markdown/README.md),
  [packages/cli/README.md](packages/cli/README.md) — package-level reference and known limits.
- [docs/superpowers/specs/2026-11-11-moggingcms-core-design.md](docs/superpowers/specs/2026-11-11-moggingcms-core-design.md)
  — the authoritative engine design. The Starlight integration spec is a design document only; no
  Starlight package is implemented.

## Licence

MoggingCMS is source-available, not open source. The first 30 days after the first `migrate` are a
free evaluation; production or other commercial use after that requires a paid key. Keys are
verified offline and never contact a licence server. See [LICENSE.md](LICENSE.md) for the full
terms, including the anti-circumvention clause.
