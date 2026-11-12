# @mogging/ai

The translation pipeline of MoggingCMSCore: it finds stale or missing translations, queues one job per document and
locale, calls a language model under a monthly budget, validates what comes back and records it as a `DRAFT_AI` for a
human to review (spec section 8). Content is read and written through the `@mogging/core` SDK; this package owns the SQL
on `ai_jobs`, `ai_budgets`, `glossary` and the provenance row of a call whose output was discarded.

This is a pre-release (v0.1, in development): the package is not yet published to npm, and the `mogging` command line
that wraps these functions comes later. It is source-available under the licence in [LICENSE.md](../../LICENSE.md).

```ts
import postgres from "postgres";
import { defineAiConfig, compile } from "@mogging/ai";
import { config } from "./mogging.config.js"; // your core config

const ai = defineAiConfig({
  provider: { kind: "openrouter" }, // reads OPENROUTER_API_KEY
  models: { translate: "openai/gpt-4o-mini" },
  prices: { "openai/gpt-4o-mini": { inputUsdPerMtok: 0.15, outputUsdPerMtok: 0.6, contextTokens: 128000 } },
  budgets: { monthlyCapUsd: 20 },
});
const ctx = { sql: postgres(process.env.DATABASE_URL!), config, actor: "ci", ai };

const report = await compile(ctx, { locales: ["de", "fr"], budgetUsd: 2, log: console.log });
// report.enqueue.enqueued, report.worker.completed, report.pendingJobs ...
```

Every function takes the typed context `{ sql, config, actor, ai }`: the core context plus the AI configuration.

## Configuration

`defineAiConfig` validates the settings and fills the defaults. It throws `ValidationError` naming the offending key.

| Key | Meaning | Default |
| --- | --- | --- |
| `provider` | `{ kind: "openrouter", apiKeyEnv? }` or `{ kind: "custom", models }` | required |
| `models.translate` | the model id used for translation | required |
| `models.summarizeChange` | reserved, unused in v0.1 | none |
| `prices` | model id to `{ inputUsdPerMtok, outputUsdPerMtok, contextTokens }` | required |
| `budgets` | `{ monthlyCapUsd, collections?: { <name>: usd } }` | required |
| `collections` | per-collection `{ translate?: modelId, glossary?: "warn" \| "strict" }` | none |
| `glossary` | `"warn"` or `"strict"` (see Validation) | `"warn"` |
| `perFieldTokenLimit` | a field above this many input tokens is sent in a request of its own | 6000 |
| `maxOutputTokens` | the most a call may generate (also bounded by the model window) | 12000 |
| `contextCharLimit` | the cap on each of the sibling and the shared context sent with a request | 20000 |
| `providerTimeoutSeconds` | one provider call is aborted after this long | 120 |
| `leaseSeconds` | how long a claimed job is held; must exceed the timeout | 300 |
| `maxAttempts` | claims a job gets before it is `FAILED` | 3 |
| `temperature` | within 0 to 1 | 0.1 |

**Providers.** OpenRouter is built in: the key is read from `OPENROUTER_API_KEY` (or the variable named by
`apiKeyEnv`) when a run starts, and a missing key fails the run before anything is claimed. The model is built with
OpenRouter's usage accounting on, so the cost it reports is what is recorded; without a reported cost the cost is the
tokens times your price table. For any other provider, build the AI SDK `LanguageModel` yourself and pass it as a
`custom` model keyed by model id:

```ts
import { anthropic } from "@ai-sdk/anthropic"; // your own dependency; it is not bundled
// The model id and prices are examples; use your provider's current ones.
const ai = defineAiConfig({
  provider: { kind: "custom", models: { "claude-haiku": anthropic("claude-haiku-4-5") } },
  models: { translate: "claude-haiku" },
  prices: { "claude-haiku": { inputUsdPerMtok: 1, outputUsdPerMtok: 5, contextTokens: 200000 } },
  budgets: { monthlyCapUsd: 20 },
});
```

**The price table.** Every model id named anywhere (`models.translate`, `models.summarizeChange`, a collection override)
needs an entry in `prices`, and with a `custom` provider also an entry in `models`, because every provenance row records
its model id. `contextTokens` is the model's window and must be at least 1024. Prices are US dollars per million tokens;
amounts are kept as whole micro-dollars (`usdToMicros`).

## Budgets and scopes

There is one global monthly cap, `budgets.monthlyCapUsd`, and an optional cap per collection in
`budgets.collections`. A job belongs to its collection's scope when that collection has a cap, else to `global`; every
live job counts against the global cap too. The month is the database's UTC calendar month. `getBudgets` shows each
scope's cap, spent and in-flight amounts (the estimates of jobs currently held under a live lease), in micro-dollars.

The cap is enforced when a job is claimed, in one transaction under the budget row lock: the job is claimed only if
spent plus in-flight plus its estimate fits every scope it belongs to. A refused job stays `QUEUED` with
`error_message` starting `budget_exhausted:` and is tried again after five minutes. Spending is debited when the job
completes, from the cost that was actually reported. The cap is a bound built on an estimate with a 1.5 safety factor
(spec 8.5), not an exact guarantee: a single call may cost more than its estimate.

A cap of `0` is the pause switch: every job with a cost estimate above zero is refused in that scope, and once anything
has been spent (or is in flight) in that scope this month, even a job with a zero estimate is refused. The cap is read
from the configuration on every claim, so changing it takes effect at once. ("Pausable per scope" in spec 8.2 is otherwise not implemented.)

The per-run budget (`budgetUsd` in `compile`, `runBudgetMicros` in `runWorker`) is separate: an in-memory tally for one
run. A job whose estimate no longer fits what is left of it is not claimed, and the run ends with `runBudgetStop: true`.
Nothing is marked and the jobs stay `QUEUED`.

## Jobs

`enqueueStale(ctx, { locales, collection?, docIds? })` queues one job per (document, locale) that has stale or missing
translatable fields. `docIds` needs `collection`. The report counts `enqueued`, `duplicates` (an active job for that
source version already exists), `cancelledStale` and the total `estimateMicros`, and lists `skipped` pairs and fields
with a reason:

- `not translatable`: only localized `text` and `richText` fields, and lists or objects with at least one text leaf and
  no rich-text leaf, are sent to the model. Other stale or missing localized fields (numbers, dates, references, a rich-text tree nested in a list)
  are reported and never copied.
- `human draft pending`: a `DRAFT_HUMAN` is never overwritten, and a `QUEUED` job for that pair is cancelled.
- `draft already current`: a pending `DRAFT_AI` or `APPROVED` draft already covers the field at the current source
  hash, so a second compile does not buy it again.

A job moves through these states:

| State | Meaning |
| --- | --- |
| `QUEUED` | waiting; `run_after` is in the past once it may be claimed |
| `RUNNING` | claimed by a worker under a lease (`locked_by`, `locked_until`) |
| `COMPLETED` | a `DRAFT_AI` was recorded |
| `FAILED` | validation failed twice, a source field is unusable or larger than the model window, the document was deleted, or `maxAttempts` was reached |
| `CANCELLED` | the source moved, a human draft appeared, or `cancelJobs` was called |

A worker claims the oldest `QUEUED` job whose `run_after` has passed (`FOR UPDATE SKIP LOCKED` on the row), and renews
its lease every third of `leaseSeconds` while the provider call runs. Before each pass the reaper returns `RUNNING`
jobs with an expired lease to `QUEUED` with a back-off of 30 seconds times 2 to the power of the attempts, or `FAILED`
at `maxAttempts`. A provider error or a job that could not be loaded goes back the same way. When a lease is lost, the
late result is not stored: its cost is debited and recorded as a discarded row (`lease lost`).

`listJobs(ctx, { state?, collection?, limit?, afterId? })` returns jobs, oldest first, and the current budgets. `limit`
is 200 by default and at most 1000; to read further, pass the last `id` of a page as `afterId` (only jobs with a greater
id are returned). `retryJobs(ctx, { ids })` puts
`FAILED` and `CANCELLED` jobs back to `QUEUED` with zero attempts, under the same gates as enqueue: it skips (with a
reason) a job whose source moved, whose document is gone, that has an active twin (also when the twin is queued while
the retry runs), whose draft is human, or whose fields a pending draft or the published translation already covers at
the current source hash (`draft already current`). A job only partly covered is narrowed to its other fields. `cancelJobs(ctx, { ids })` cancels `QUEUED` and `RUNNING` jobs; a running worker
then fails its fence and its result is discarded.

By default `locked_by` reads `<actor>@<hostname>#<pid>#<8 hex>`: the actor and the process, plus a suffix that is unique per claim,
so a reclaimed job can never pass an earlier worker's fence.

## Provenance

Every provider call that reports its usage is recorded, so the money spent is explainable (see Known limits for the
exceptions). `listProvenance(ctx, { docId?, locale?, discardedOnly?, limit?, afterId? })` lists `content_provenance`
rows ordered by creation time, then id; `limit` is 200 by default and at most 1000, and `afterId` returns only rows
with a greater id (pass the last `id` of a page). Rows written by concurrent transactions can be created in a different
order than their ids, so treat `afterId` as a way to reach rows beyond the cap, not as an exact page boundary:

- A kept row per translated field of an accepted draft: model, prompt version, tokens, cost, warnings, `job_id`, and
  `superseded_version` when the draft replaced an earlier AI draft. A call translates several fields at once, so its
  tokens and cost are split over the fields in proportion to their translated characters (the parts sum to the call).
- `call_id` groups the rows of one provider call.
- A discarded row (`discarded = true`, no version, no field) for a call whose output was not stored, with
  `discard_reason`: `validation: ...` (rejected, including the first call that was retried with the strict prompt),
  `provider: ...`, `cancelled: <why>`, `lease lost`, or `commit_failed: <error>` (see Known limits).

Without `docId`, `discardedOnly` lists the spend that produced no draft across the whole project.

## Validation

A draft is stored only if every field passes (spec 8.4):

1. The shape is right: a list keeps its length, an object its keys, non-text leaves are unchanged, and rich text comes
   back as Markdown that restores into a valid tree. Code and opaque nodes were replaced by sentinels before the call and
   are put back from the source, so the model can never alter them.
2. Placeholders such as `{name}` are the same multiset as in the source: each one exactly as often, so a dropped and
   an added placeholder are both rejected.
3. Do-not-translate glossary terms still appear at least as often as in the source.
4. A glossary term that has a translation shows that translation or an accepted form. In `warn` mode a miss is a
   warning stored on the provenance row (for `approveClean`); in `strict` mode it rejects the draft. The mode can be set
   per collection.
5. No string contains U+0000.

A rejected draft is retried once with a stricter prompt over the same request. A call that does not return an object
that matches the schema counts as a rejection too. Both calls are paid and recorded; if the second also fails the job
is `FAILED` with the reasons, and no draft is written. The SDK's own retries are turned off (`maxRetries: 0`), so every
attempt is one counted call.

The glossary is per locale pair: `upsertGlossary(ctx, entries)` and `listGlossary(ctx, { sourceLocale, targetLocale })`
take `GlossaryEntry` values (`sourceLocale`, `targetLocale`, `term`, `translation`, `acceptedForms`, `doNotTranslate`,
`note`).

## Running a worker

`runWorker(ctx, { once, runBudgetMicros?, pollMs?, filter?, workerId?, log?, signal? })` claims and processes jobs one
at a time. With `once: true` it returns when nothing runnable is left; otherwise it polls every `pollMs` (2000 by
default) until `signal` aborts. `filter` limits it by collection, document ids and locales. The report counts
`completed`, `failed`, `cancelled`, `discarded`, `requeued`, `errors`, `budgetRefusals`, `runBudgetStop` and
`spentMicros`.

`compile(ctx, { locales, budgetUsd, collection?, docIds?, log? })` is `enqueueStale` followed by one `runWorker` pass
over the same scope with `budgetUsd` as the run budget. `budgetUsd` must be above zero. `pendingJobs` is the number of
jobs still `QUEUED` in that scope afterwards: jobs over the run budget or a cap, and jobs backed off after an error.
A missing API key or a model that cannot be resolved makes `compile` reject only AFTER `enqueueStale` has committed
its jobs: they stay `QUEUED`, and the next `compile` counts them as duplicates instead of queueing them again.

The worker logs one line per job, and one extra line when something went wrong:

```
job=42 doc=3f2c... locale=de model=openai/gpt-4o-mini tokens=812/655 cost_usd=0.000510 outcome=COMPLETED
job=43 error=<message>
```

`outcome` is the job's new state, `DISCARDED` for a lost lease, or `ERROR`. The second line appears when a job could
not be loaded (the job is released with back-off, and the first line shows its new state) or when the completion itself
threw (outcome `ERROR`; the job stays `RUNNING` until the reaper takes it).

## Licence

`enqueueStale`, `runWorker` and `compile` refuse to run once the 30-day evaluation has ended without a valid key (spec
12.3). Reads, `listJobs`, `retryJobs`, `cancelJobs`, glossary and budget functions are not guarded.

## Known limits

- **Estimate, not a tokenizer.** There is no per-model tokenizer. Tokens are estimated from characters: 3 characters per
  token, or 1.5 when either locale is Chinese, Japanese or Korean. The prompt template counts as its length divided by 3.
  The enqueue estimate counts stored values, so a rich-text field counts as its tree's JSON while the worker sends the
  prepared Markdown; the two can differ.
- **One read per document at enqueue.** `enqueueStale` calls `getDocument` once per document that has stale fields,
  because the list reads return no heads.
- **One job at a time per worker process.** Run more processes for more parallelism; they claim safely side by side.
- **Context is truncated.** The sibling and shared context is cut at `contextCharLimit`; later values are dropped.
- **`summarizeChange` is reserved** and never called; its model still needs a price entry if configured.
- **Errors end a run.** `runWorker` (and so `compile`) rejects on a database error while reaping or claiming: a
  transient outage ends the run, and the jobs stay as they are. It also rejects with `LicenceError` if the licence
  lapses mid-run, and the partial report is lost; jobs already completed stay completed.
- **Spend can go unrecorded.** If the completion transaction fails after a provider call, a separate transaction records
  the cost (rows marked `commit_failed:`). It first locks the budget rows and then checks whether the first transaction
  committed after all, so a commit that was only reported as failed is never debited twice. If that second transaction
  fails too (for example the database is down), or the process dies between the call and the completion, that call's
  cost is not recorded; the job is re-run when its lease expires. The original error is still the one thrown, with
  the second failure and the lost call ids attached as its `fallbackError` property, and the worker's error line adds
  `fallback_failed=<message> calls=<ids>`.
- **Aborted calls record no spend.** A provider call that is aborted or times out (the provider timeout, or a lease
  lost mid-call) returns no usage, so it records no spend, writes no provenance row and is not seen by the monthly cap.
  Whether the provider bills such a call is unverified. A job can make up to `maxAttempts` such calls before it fails.
  This is an accepted limit of v0.1 (owner decision, 2026-11-13): when calls abort, the monthly cap and the per-run
  budget are not a hard bound on provider spend. To limit the exposure, keep `providerTimeoutSeconds` and `maxAttempts`
  modest, and compare the provider's own usage page with `listProvenance` if aborts are frequent.
- **Lock order.** Every transaction takes locks in one order: `ai_budgets` rows (`global` first, then
  `collection:<name>`), then the `ai_jobs` row, then `documents` (taken by core's `recordAiDraft`). The reaper runs in
  its own committed transaction before each claim, and candidates are tried in short transactions, so the budget lock is
  never held while a job is chosen.
- **Time is the database's.** Leases, back-off, the fence and the budget month all use the database clock, so workers on
  hosts with skewed clocks agree.

## Live test

`test/live.test.ts` translates a seeded document through the real OpenRouter API. It is skipped unless `MOGGING_LIVE`
and `OPENROUTER_API_KEY` are set; see [docs/dev-setup.md](../../docs/dev-setup.md). Never put a key in a file that is
tracked.

## Source-available licence

MoggingCMSCore is source-available, not open source; the terms are in [LICENSE.md](../../LICENSE.md).
