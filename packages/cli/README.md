# @mogging/cli

The `mogging` command line of MoggingCMSCore: it sets up a project, imports and exports Markdown, shows which
translations are stale, runs the AI translation pipeline under a budget, reviews and approves what the model wrote,
and publishes documents or releases (spec sections 8 and 9.2). Every command is a thin layer over the `@mogging/core`,
`@mogging/ai` and `@mogging/markdown` SDKs.

## Status and install

This is a pre-release (v0.1, in development). The package is private (`0.0.0`) and is not published to npm yet, so
there is nothing to `npm install` from a registry. It is source-available under the licence in
[LICENSE.md](../../LICENSE.md).

From a checkout of the repository:

```bash
pnpm install
pnpm --filter @mogging/cli dev <command> [options]   # runs src/bin.ts with tsx
pnpm build                                           # compiles every package to packages/*/dist
DATABASE_URL=... pnpm smoke:pack                     # packs the four packages, installs the tarballs, runs `mogging`
```

`pnpm --filter ... dev` runs with `packages/cli` as the working directory, so pass `--config <path to your
mogging.config.ts>` there. The packed manifest declares the `mogging` binary (`dist/bin.js`); `pnpm smoke:pack`
(see [docs/dev-setup.md](../../docs/dev-setup.md)) is the check that an installed copy runs.

Requires Node 22 or newer and a PostgreSQL database. `mogging init` writes a starter `mogging.config.ts` and applies the
engine migrations.

## Commands

```text
mogging init
mogging migrate
mogging import <dir> [--publish]
mogging export <dir> [--collection <c>]... [--locale <l>]...
mogging status [<collection>] [--locale <l>]
mogging track <collection>/<slug> --locale <l> [--fields a,b]
mogging compile --locales de,fr --budget <usd> [--collection <c>] [<collection>/<slug> ...]
mogging worker [--once] [--poll-ms <n>] [--budget <usd>] [--collection <c>] [--locales a,b]
mogging jobs [--state <s>] [--collection <c>] [--limit <n>] [--retry <id,...>] [--cancel <id,...>]
mogging provenance <collection>/<slug> [--locale <l>] [--discarded-only] [--limit <n>]
mogging review [--locale <l>] [--collection <c>]
mogging review <collection>/<slug> [--locale <l>]
mogging review list [--collection <c>] [--locale <l>] [--state DRAFT_AI|APPROVED|DRAFT_HUMAN]
mogging review show <collection>/<slug> --locale <l>
mogging review approve <collection>/<slug> --locale <l> --version <n> [--reject-fields a,b] [--edit-file <path>] [--ack-warning <text>]...
mogging review reject <collection>/<slug> --locale <l> --version <n> [--reason <text>]
mogging review --approve-clean [--collection <c>] [--locale <l>]
mogging publish <collection>/<slug> [--locale <l>]
mogging publish --release <name> [--allow-stale]
mogging unpublish <collection>/<slug> --locale <l>
mogging release create <name>
mogging release list
mogging release add <name> <collection>/<slug> ... [--locale <l>]
mogging release add <name> --all-approved [--locale <l>] [--collection <c>]
mogging release publish <name> [--allow-stale]
mogging query <collection>[/<slug>] [--locale <l>] [--raw] [--limit <n>]
mogging help [command]
mogging version
```

Every command also takes the global options `--json`, `--config <file>`, `--database-url <url>`, `--actor <name>` and
`--help` (which prints that command's usage); the one exception is the interactive `review`, which refuses `--json`.
With a target, `review` takes only `--locale`; `--collection` is for the form without one. `release add` needs
targets or `--all-approved`, not both, and `--collection` only with `--all-approved`. `--version` is recognised only before the command
(`mogging --version`). A single-value option given twice is a usage error; `export --collection`/`--locale` and
`review approve --ack-warning` are the repeatable ones. A `<collection>/<slug>` target also accepts a document id
after the slash, and splits at the first `/`, so a nested slug (`docs/guide/setup`) works.

| Command | What it does |
| --- | --- |
| `init` | Writes `mogging.config.ts` unless a config already exists (never overwrites), then applies the migrations. Needs a database URL before it writes anything. |
| `migrate` | Applies pending migrations. |
| `import <dir>` | Imports a `<locale>/<collection>/<slug>.md` tree as drafts; `--publish` publishes them in the same run. |
| `export <dir>` | Writes the published content as the same tree; `--collection` and `--locale` narrow it (undeclared names are a usage error). |
| `status [<collection>]` | One line per locale and state (`current`, `stale`, `missing`, `untracked`, `orphaned`), then one line per field that is not current, then a `run: mogging track ...` line for each document with untracked fields. |
| `track` | Asserts that untracked translated fields are in sync with the source; without `--fields` it tracks every untracked field of that locale. |
| `compile` | Queues every stale or missing translation for `--locales`, runs the worker until the queue is empty or `--budget` (USD for this run, required) is spent, and reports. Needs an `ai` export in the config. Targets given as `<collection>/<slug>` must share one collection. |
| `worker` | Runs the translation worker. `--once` stops when the queue is empty; `--poll-ms` (100 to 2147483647) is the idle poll interval; `--budget` is a per-run cap. Needs an `ai` export. |
| `jobs` | Job counts by state, the job table (id, document, locale, state, attempts, lease holder, lease expiry, error) and one budget line per scope. `--state` is `queued`, `running`, `failed`, `cancelled` or `completed`. `--retry` and `--cancel` take comma-separated ids and cannot be combined. Lists every row unless `--limit` (1 to 1000) is given. Needs an `ai` export. |
| `provenance` | Every AI provenance row of one document, discarded calls included (`--discarded-only` shows only those); every row unless `--limit` (1 to 1000). |
| `review` | Four forms, see below. |
| `publish` | Publishes the draft heads of one document (`--locale` for one locale or `shared`), or a named release (`--release`, with `--allow-stale` to publish a release whose items are stale). A `DRAFT_AI` head is refused: review it first. |
| `unpublish` | Takes one locale, or `shared`, offline. Already offline is reported as `not published` and is not a failure. |
| `release` | `create` a named release, `list` releases, `add` approved heads (named targets, or every `APPROVED` head with `--all-approved`, narrowed by `--collection` and `--locale`), `publish` it. |
| `query` | Read-only. `<collection>` lists published documents with locale fallback (`--limit` 1 to 200, default 20); `<collection>/<slug>` shows one document and which locale each field came from; `--raw` shows the document's heads and versions instead. `--locale` defaults to the source locale. |
| `help`, `version` | Print the usage, or the version. |

### Review

- `mogging review` and `mogging review <collection>/<slug>` are the interactive review: every pending `DRAFT_AI`
  draft in scope, one at a time. Per field it shows the source text, then the previous text and the draft in two
  columns, a `! source changed` flag, the warnings and the glossary entries that match the source. Keys: `[a]pprove [r]eject [e]dit [s]kip [q]uit`. It needs a terminal on stdin and stdout and has no
  `--json` form; edits open `$VISUAL`, else `$EDITOR`, else `vi`.
- `review list`, `review show`, `review approve`, `review reject` are the scriptable forms. `approve` and `reject`
  require `--version <n>`, the draft version that `list` or `show` printed; if the draft has been replaced since, the
  command fails with a conflict instead of acting on a draft nobody saw. The number proves which version was acted on,
  not that a person read it.
- A draft with warnings is refused unless every distinct warning text is acknowledged with `--ack-warning <text>`
  (spec 8.4); the interactive review asks per warning.
- `review --approve-clean` approves every warning-free `DRAFT_AI` head in scope and lists the skipped ones. There is no
  "approve everything" command (spec 8.6).

### The edit file

`review approve --edit-file <path>` replaces the text of fields before approving. Only `text` and `richText`
fields can be edited, and only fields whose text differs from the draft count as edits.

A file with any other extension is the text form: one section per field, each starting with the line
`=== <field> ===`, followed by the field's text (a `richText` field as Markdown, or MDX if the draft is MDX):

```text
=== title ===
Einleitung

=== body ===
Hallo zusammen, willkommen.
```

Text before the first header, no header at all, a section repeated, or a header for a field that is not editable is an
error. Any other `=== ... ===` line is ordinary text. A value that itself contains a line that looks like a section
header of the draft cannot be written to a text file: use the JSON form.

A path ending in `.json` is the JSON form, an object of field to string:

```json
{ "title": "Einleitung", "body": "Hallo zusammen, willkommen." }
```

Unknown or non-editable fields and non-string values are errors.

## Output and exit codes

Human output goes to stdout. Progress (the per-job lines of `compile` and `worker` under `--json`), the licence line and
errors (`error: <message>`) go to stderr. Every write to either stream has database URL passwords replaced by `***`.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Error: the command failed, or every item it attempted failed or was refused. |
| `2` | Usage error: unknown command or option, a missing or malformed argument, no config, no database URL. Also `mogging` with no command. |
| `3` | Licence refusal (spec 12.3). |
| `4` | Partial failure: a command that attempts several items and at least one succeeded (or was already in the wanted state) and at least one failed or was refused. |

One rule decides `1` versus `4`. Commands that attempt several items (`import` files, `publish` heads, `release add`
items, `compile` and `worker` jobs, `jobs --retry` ids, interactive review) count `failed` and `done`: `failed = 0`
gives `0`, `done = 0` with `failed > 0` gives `1`, both greater than zero gives `4`. An item that is already in the
wanted state (`unchanged`, `already in release`) is done. Skips by `review --approve-clean` are not failures. For
`compile` and `worker`, a requeued job (provider error) or a discarded one (lease lost, or cancelled while running)
counts as failed; a job refused by the budget stays pending and counts as neither.

### `--json`

With `--json` stdout is exactly one JSON document, with these members:

```json
{ "ok": true, "partial": false, "data": {}, "licence": { "state": "evaluation", "daysLeft": 12, "warn": false, "plan": null, "licensee": null, "keyError": null } }
```

- Exit `0` and `4`: `ok` is `true`; `partial` is `true` exactly for `4`; `data` is what the command wraps, unchanged.
- A command that returns exit `1`: `{ "ok": false, "partial": false, "data": ..., "error": { "code", "message" }, "licence": ... }`.
- A failure that is thrown (usage errors, licence refusals, a refused connection): `{ "ok": false, "error": { "code", "message" }, "licence": ... }`
  with no `data` and no `partial`. `code` is the error's own `code` when it has one, else its name. Usage and
  argument parse errors are reported this way too.
- `licence.state` is `licensed`, `evaluation` or `expired`; `daysLeft` and `licensee` may be `null`; `keyError` names a
  rejected key. The whole member is `null` when the command never opened the project.

`data` for the commands: `init` `{ configCreated, applied }`; `migrate` `{ applied }`; `import` and `export` the
importer's or exporter's report; `status` `{ rows }`; `compile` `{ enqueue, worker, pendingJobs }`; `worker` the final
worker report; `jobs` `{ jobs, budgets }` (with `--retry` or `--cancel`, the result of that call); `provenance` the row
array; `review list` `{ items, next: null }`; `review show` the draft review; `review approve` and `review reject`
`{ version }`; `review --approve-clean` `{ approved, skipped }`; `publish`, `unpublish` and `release add`
`{ items: [{ target, locale, outcome, version?, message? }] }`; `release create` the new release; `release list` the
array of releases; `release publish` and `publish --release` `null`, except a stale release, which is exit `1` with
`data: { stale: [...] }`; `track` `null`; `query` the resolved document `{ id, data, fellBack, missing }`, or an array of
them for a collection (`--raw`: the document with its heads). `fellBack` maps each field that was taken from another
locale to the locale it came from.

`--version`, `--help` and the usage text printed for no command are plain text with or without `--json`.

## Actor

Every write records an actor. The CLI takes it from `--actor`, else `MOGGING_ACTOR`, else the operating system user
name, else the word `cli`; a blank value is skipped, so the actor is never empty.

This is attribution, not authentication (spec 8.7). v0.1 has no login: anyone with the database URL can do anything the
SDK can do, and `--actor alice` is believed. An approval record names who the process said it was; making sure that
is a real person is the deployment's job.

## Licence lines

Every command that opens the project prints the licence state on stderr (spec 12.3, 12.4). With `--json` the same facts
are also in the `licence` member, so a redirected stderr does not hide them; in human mode the line is on stderr only,
so `2>/dev/null` hides it:

- During the 30-day evaluation: `MoggingCMS evaluation: <n> days left`, written `warning: MoggingCMS evaluation: <n> days left` from 7 days left.
- After it, without a valid key: `warning: MoggingCMS evaluation has ended: reads keep working, but content updates, compiles and publishing are paused until a licence key is set`. Guarded writes then exit `3`.
- With a valid `noncommercial` key: `MoggingCMS noncommercial licence: commercial use is not permitted`, then `licensee: <name>`.
- With a key that does not verify: `warning: licence key rejected (<code>); running as <state>` first, then the line for that state.
- A valid commercial key prints no line.

`--help`, `--version` and the plain usage text open no project and print no licence line.

The guarded operations are exactly saving drafts (so `import`), recording AI drafts (`compile`, `worker`), `approve` and
`approveClean`, and `publish` and `publishRelease` (spec 12.3). Reads, `unpublish`, `release create` and `add`, `track` and
`review reject` are not guarded: `review reject` keeps working after the evaluation has ended.

## Configuration

The CLI looks for `mogging.config.ts`, `mogging.config.mts`, `mogging.config.js` and `mogging.config.mjs`, in that
order, in the current directory (a symbolic link counts as present, and a dangling one fails to load). `--config <file>`
names one instead, relative to the current directory. The module must export `config` (from `defineConfig`) and may
export `ai` (from `defineAiConfig`); `compile`, `worker` and `jobs` need `ai`. It is loaded with `jiti`, so TypeScript
works without a build step.

### Environment variables

| Variable | Used for |
| --- | --- |
| `DATABASE_URL` | The database. `--database-url` wins, then `MOGGING_DATABASE_URL`, then `DATABASE_URL`. With none, the exit code is `2`. |
| `MOGGING_DATABASE_URL` | As above; wins over `DATABASE_URL`. |
| `MOGGING_ACTOR` | The actor when `--actor` is not given. |
| `MOGGING_LICENSE_KEY` | Your licence key, read by `@mogging/core`; wins over `config.license`. |
| `OPENROUTER_API_KEY` | The OpenRouter key, read by `@mogging/ai` when the config uses the `openrouter` provider. The CLI never reads or prints it. |
| `VISUAL`, `EDITOR` | The editor of the interactive review: `$VISUAL`, else `$EDITOR`, else `vi`. Split on spaces, run without a shell. |
| `NO_COLOR` | Turns colour off in the review view. |

## Known limits

- **No local review web page in v0.1.** Spec 8.6 allows one; review is the terminal, `review show` and the flag-driven
  forms. It is deferred to v0.2.
- **Ctrl-C on `compile`, `import` and `export` ends the process at once.** These commands take no abort signal. A job in
  flight keeps its lease until the lease expires and the reaper requeues it (spec 8.5), and a provider call that was
  already sent may still be billed. Only `worker` and the interactive `review` stop gracefully on the first Ctrl-C
  (SIGINT or SIGTERM): they print `interrupted: stopping after the current step (interrupt again to quit now)` on
  stderr and finish the current step; a second signal exits with code 130 at once. A provider call that is aborted
  records no spend and may be billed anyway: see Known limits in [`@mogging/ai`](../ai/README.md#known-limits), and set a
  spend limit on the provider key.
- **`export` overwrites.** Files that already exist in the target directory are replaced without a check, so a
  hand-edited file there that was never imported is lost.
- **A warning is acknowledged once.** An acknowledged warning is not demanded again for text carried over into a later
  draft; only a field the model re-drafts brings new warnings. A warning's only identity is its text, so a reworded
  validator message changes what must be acknowledged.
- **An edit is recorded as in sync with the source at approval time** (spec 6.4). If the English source is changed and
  published while a reviewer is in `$EDITOR` or preparing an `--edit-file`, that is not detected: the AI draft is not
  replaced and `--version` still matches.
- **No `release remove`.** `release add` of a pair that is already in the release at another version is refused, and
  v0.1 has no way to take an item out; a release holding an item whose draft has moved on cannot be published.
- **`publish <target>` without `--locale` publishes every `DRAFT_HUMAN` and `APPROVED` head** of the document, the shared
  snapshot included, and refuses `DRAFT_AI` heads. It is not atomic across heads: each is reported, and the exit code is
  `4` or `1` by the rule above.
- **Edit files take only `text` and `richText` fields.**
- **`review` shows the current source text**, with a `! source changed since this draft was translated` line when the
  source moved since the draft was made, not a diff of two source versions.
