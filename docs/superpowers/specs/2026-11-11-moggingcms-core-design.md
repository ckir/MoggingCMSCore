# MoggingCMSCore design

Date: 2026-11-11. Status: APPROVED by the owner on 2026-11-11; REVISED the same day after the
owner's ruling "every company pays" (section 12 replaces the MIT decision; sections 2, 4, 8.7 and 10
updated; the revision is the jointly agreed recommendation of both reviewers). Scope `@mogging`,
bulk approval allowed, announce after a template exists. Repo state at writing: empty (README and
.gitignore).

This document is the design a builder plans from. It records what the owner decided, what Claude
proposed and the owner ratified, and what is left to the builder. Three agy-first consults shaped it
(seams in `.clavity/seams/`, peer analyses in `.clavity/scratch/`); their verified findings are folded
in and their rejected claims are not repeated. Appendix A is the review ledger.

## 1. Intent

MoggingCMSCore is a TypeScript content engine for multilingual sites, built so that other teams adopt
it. Its thesis: a CMS that others will switch to in 2026 must make localization the data model rather
than a plugin, and must make AI part of the architecture rather than a button.

The product shape is a **staleness compiler**. The source locale is treated like source code; every
other locale is a compiled artifact. When source content changes, the engine knows exactly which
fields in which locales are now stale, an asynchronous pipeline produces AI drafts for those fields
through the adopter's own LLM key, and a human approves each draft before it can be published. Nothing
AI-produced reaches production without a recorded human approval.

## 2. Who it is for

**First adopter:** a technical lead or documentation engineer at a company of roughly 20 to 500
people, running a content-heavy multilingual site with technical documentation and knowledge bases as
the showcase use. They write Markdown, live in Git, need two or more locales, are comfortable with a
CLI and a typed SDK, can evaluate locally in ten minutes, and can expense a licence of a few hundred
dollars a year without a purchasing process. They do not need a visual editor to get value.
Individuals and noncommercial organisations use the product free (section 12) and are welcome, but
they are not who v0.1 is designed to win.

**Why this adopter:** every existing docs framework leaves translation sync to the user (Docusaurus
says so in its own docs; Starlight has fallback only), yet docs sites need several locales as a matter
of course. The CMS products that do have AI translation (for example Sanity AI Assist) lack staleness
tracking, glossaries, and bring-your-own-key. This adopter is reached through framework templates and
integrations, a self-serve evaluation that needs no conversation, and a self-serve purchase that needs
no sales call.

**Success criterion:** within twelve months of first public release, a paying organisation the owner
does not know keeps two or more locales current in production with the product's AI assistance, and
arrived through a channel that scales.

## 3. Goals, non-goals, anti-goals

**Goals for v0.1**

- Localization is a dimension of every localized field value, addressed as (document, field, locale,
  version), with per-field fallback chains and computed staleness.
- Versioned content with one published head and at most one draft head per (document, locale), full
  history, time-travel by timestamp, and atomic multi-document releases.
- An asynchronous, Postgres-backed AI pipeline with a human-approval state machine, bring-your-own-key
  through OpenRouter and direct providers, glossary and structural validation before a draft is
  recorded, and hard cost caps.
- A typed TypeScript schema that drives validation and the query layer, with schema changes expressed
  as migrations that do not rewrite history.
- A CLI and a typed SDK that expose every operation, so that a later MCP server and a later web UI are
  thin projections over the same engine.
- Postgres as the only required dependency. Runs self-hosted with no cloud account.
- A ten-minute path from install to a locally running engine with imported Markdown content and a first
  AI draft awaiting review.

**Non-goals for v0.1** (deliberately later)

- A web admin UI or visual editor. v0.1 ships a minimal review surface only (section 8.6).
- True content branching. The design must not preclude it; it does not ship it.
- SQLite support. Desirable for local development; deferred because the fallback merge and identity
  columns are Postgres-specific.
- An MCP server. The SDK is shaped so one can wrap it; it is not in v0.1.
- Authentication and user management. v0.1 trusts whoever holds the database URL (section 8.7).
- Translation memory, XLIFF export, vendor integrations, SSO, multi-tenancy, hosted cloud.
- Node-level staleness inside rich text. v0.1 is per field.

**Anti-goals** (would make the product a failure even if it worked)

- AI output reaching a published locale without a recorded approval by a named actor.
- Silent cost: an adopter discovering an LLM bill they did not cap.
- A locale reading as "present" when a field is actually missing, or a cleared translation hiding the
  source text instead of falling back to it.
- A public schema DSL or storage format that forces consumers to rewrite when the engine changes.
- Becoming a documentation framework. The engine serves docs sites; it does not render them.

## 4. Constraints

- Solo founder or very small team; v0.1 must be shippable in months.
- TypeScript throughout. Supported runtime is Node 22 or later (the AI SDK requires it); Bun
  compatibility is a goal, verified in CI, not a promise.
- Postgres 16 or later is the only required service. Tested on 18.
- LLM calls are paid by the adopter through their own keys. The engine never ships a key and never
  calls a provider without a configured budget.
- No LLM call inside a database transaction or request handler; all generation runs in background
  jobs.
- Prompts, model ids and token counts never live in content tables.
- Source-available, self-hostable, paid for every commercial user (section 12). The product is
  never described as "open source".
- The engine must work with no network access other than the adopter's own Postgres and their own
  LLM provider: licence verification is offline (section 12).

## 5. Approaches considered

Three forks were decided, each with an agy-first consult, measurement, and owner ratification.

**Fork 1, first adopter.** Options: developer embedding an npm package with an admin UI (Payload and
Sanity crowd); agency and editorial teams wanting a polished standalone admin (Statamic and Craft
crowd); enterprise localization buyers (Contentful and Kontent.ai crowd). Agy argued the real fork was
whether v0.1 needs an admin UI at all, and proposed docs and knowledge-base teams as the sharper
adopter. **Picked:** engine first with no admin UI, docs-led developer adopter. The agency path needs
UI polish a small team cannot afford first; the enterprise path is a sales motion, not a GitHub one.

**Fork 2, the role of AI.** Options: AI as a feature layer (draft translations, alt text); AI agents
as first-class operators of the CMS through MCP; AI localization as the whole product competing with
Lokalise and Crowdin. Agy rejected agents-as-operators on governance grounds (organisations refuse
autonomous writes across locales) and the whole-product option as a red ocean, and reframed the
feature layer as an asynchronous compiler pipeline with a human-approval state machine. **Picked:**
the staleness compiler. Per-field "translate" buttons are a commodity; the compiler pipeline with
staleness scoping, structural validation and glossaries is the structural moat.

**Fork 3, storage layout.** Options: one generic per-field value table; one JSON document per
(document, locale, version); generated relational tables per collection; an event log with
materialized read models; Claude's hybrid of a per-field table plus materialized heads. Agy proposed
a sixth: document-locale snapshots split into shared and localized tables with a per-field hash
vector for staleness. Claude built it on Postgres 18 at the target scale and measured it (section
7.5). **Picked:** the snapshot layout, with one correction (null handling) and three deferrals
(SQLite, branching, a staleness marker for dashboards).

**Fork 4, licence and business model** (decided later the same day, after the owner's ruling "every
company pays"). Options: MIT core with commercial extensions; a source-available licence that permits
commercial use but forbids competing hosted offerings (Functional Source License or Elastic 2.0
class); PolyForm Noncommercial alone; a dual licence of PolyForm Noncommercial plus a commercial
licence on the honour system; the same with an in-engine licence key; closed source hosted only.
Two agy-first rounds read the licence texts from the SPDX list. PolyForm Noncommercial alone blocks
the first adopter at work; the free-commercial-use licences contradict the ruling; honour-system dual
licensing produces neither revenue nor adoption; hosted-only discards the self-hosted architecture.
**Picked:** the dual licence with an in-engine offline key and a built-in evaluation period
(section 12), agreed point by point by both reviewers.

## 6. The content model

### 6.1 Collections, documents, fields

A **collection** is a named content type defined in TypeScript. A **document** belongs to one
collection and has an immutable id. A collection declares **fields**; each field is either
**localized** (has a value per locale) or **shared** (one value for all locales).

Field kinds in v0.1: text, rich text (portable tree), number, boolean, date-time, slug, reference
(to a document in a named collection), list of any of these, object (named sub-fields). `slug` is
always shared. Each collection marks exactly one rich-text field as its Markdown body for import
and export.

**The unit of localization is the top-level field.** Fallback, staleness, AI jobs, approval and
rejection all operate on top-level localized fields. A nested object or list field falls back,
hashes, and is translated as one value; a partially translated list falls back as a whole. Nested
paths (`sections.2.body`) appear only in validation and review messages. Per-leaf localization is a
later refinement; v0.1 keeps the SQL merge and the hash vector flat.

### 6.2 Locales and fallback

Locale codes are BCP 47 tags, stored case-normalized (`de-CH`). The schema declares the set of
locales and a **source locale** (the one humans author in; default locale for fallback). Each locale
may declare a **fallback chain** (`de-CH` falls back to `de` then `en`). A localized field may
override the chain (`legal` falls back from `de-CH` straight to `en`).

Resolution rule: a field resolves to the first locale in the chain that **has** the field. "Has"
means the key is present and not JSON null. A cleared translation is stored as absence, so it falls
back rather than hiding the source. This rule came from a measured defect in the proposed merge
(section 7.5) and is a contract.

Intentional suppression is distinct from clearing: to show nothing in a locale for an optional
field (a banner that does not apply there), the editor stores an **empty value** of the field's type
(empty string, empty list, empty tree, empty object). Empty is present, so it does not fall back.
Null means "I have nothing, use the chain"; empty means "show nothing". Scalar kinds (number,
boolean, date-time, reference) have no empty value and cannot be suppressed this way; a localized
scalar that must not fall back declares `fallback: "none"` in the schema, which is the per-field
chain override with an empty chain, and then resolves to absent when the locale lacks it.

### 6.3 Versions, heads, states

Every write to a (document, locale) creates a new immutable **version** of that locale's snapshot.
A snapshot always holds the complete set of that locale's localized fields, never a delta. Shared
fields version per document in their own snapshot with the same lifecycle. Each (document, locale)
and each document's shared snapshot has at most one **published head** and at most one **draft
head**. A draft is in one of three states: `DRAFT_HUMAN` (authored by a person), `DRAFT_AI` (produced
by the pipeline, unapproved), `APPROVED` (a person approved an AI draft but it is not yet published,
for example because it waits for a release).

Rules:

- **Publishing flips, it does not copy.** Publishing a draft sets `state = PUBLISHED`,
  `is_head_published = true`, `is_head_draft = false`, `published_at`, `published_by` on that row, and
  sets `is_head_published = false`, `unpublished_at` on the previous published row, in one
  transaction. No new row is created by publishing a draft.
- **Republishing an earlier version inserts a copy.** `publish` with an explicit `version` of a
  previously published row sets the current published head's `is_head_published = false` and
  `unpublished_at`, then inserts a new `PUBLISHED` row (next version number, same content) as the head.
  The original row is never modified, so its own publication window stays exact for time-travel reads.
- The pipeline never overwrites a `DRAFT_HUMAN` head. If a human draft exists for a (document,
  locale), the AI job for it is cancelled and reported. The partial unique index on the draft head is
  the guard: the draft insert fails rather than racing.
- A `DRAFT_AI` snapshot is reviewed as a whole (document, locale). The reviewer may reject individual
  fields; rejecting a field restores that field to the currently published value (or absence) and
  records the rejection in provenance. Approving writes a new version in state `APPROVED` containing
  the accepted and edited fields; its provenance rows reference the AI version and carry an `edited`
  flag per field the reviewer changed. The original AI version stays in history and is never
  publishable itself. A `DRAFT_AI` head may also be rejected as a whole (`rejectDraft`): the head flag
  is cleared, the row stays in history, a `human:reject` provenance row records who and why, and the
  pair is stale again so a later `compile` may regenerate it.
- A `DRAFT_HUMAN` snapshot may be published by its author without a separate approval; the
  publication record names them. Only `DRAFT_AI` requires the approval step.
- Each snapshot records `published_at` and `unpublished_at`. Time-travel reads take a timestamp T and
  resolve each (document, locale) to the version with `published_at <= T` and (`unpublished_at` null
  or `> T`). A document with `deleted_at <= T` is absent at T. Creation time is not publication time;
  an approved draft can be published long after it was written.
- Unpublishing a locale clears its published head; readers then fall back. This is reversible: the
  version stays and can be republished.
- A release may include localized and shared drafts; `release_items.locale` is null for a shared
  snapshot.

### 6.4 Staleness

Every localized snapshot carries a **hash vector**: for each field, the hash of the source-locale
value it was derived from. The source locale's own snapshot carries the hash of its own values. A
target field is in one of three sync states against the source locale's published head:

- **current**: recorded hash equals the current source hash.
- **stale**: recorded hash differs.
- **untracked**: the target has a value for the field but no recorded hash (it was never derived
  from, nor asserted in sync with, the source). Reported separately from stale; the CLI offers to
  track it.
- **missing**: the source has the field and the target has no value for it, including the case
  where the target locale has no snapshot at all yet. Missing fields are what the first `compile`
  translates; the sweep enumerates every (document, declared locale) pair, not only existing target
  rows, so a newly declared locale shows every field as missing.

A field that exists in a target but no longer exists in the source is reported as **orphaned** and
is ignored by fallback and compile; the reviewer removes it or keeps it.

When a person saves a target locale, the fields they saved are recorded as derived from the current
source hashes: a human edit asserts "in sync with the source as of now". Staleness is computed, never
written to targets, so a source change costs one write regardless of locale count.

Hash: SHA-256 over the RFC 8785 (JSON Canonicalization Scheme) encoding of the field value **after
typed normalization**: text NFC-normalized; date-time stored as ISO 8601 in UTC with millisecond
precision (`2026-11-11T08:00:00.000Z`); numbers as JSON numbers, never numeric strings; booleans as
JSON booleans; slugs lower-cased. Normalization happens at write time, so an importer that emits a
date without milliseconds does not produce a different hash from one that does. Hash algorithm,
normalization and canonicalization are part of the storage contract.

### 6.5 Rich text

Rich text is stored as a portable JSON tree: block nodes with typed inline children, marks, and
link and embed nodes. v0.1 ships a Markdown-to-tree and tree-to-Markdown converter because the first
adopter writes Markdown; CommonMark plus GFM tables and fenced code blocks are the supported subset.
Raw HTML blocks and inline HTML are preserved as opaque nodes and are never sent to a model; they are
copied through unchanged like code blocks. Any syntax outside the supported subset (MDX components,
admonition fences, footnotes) is likewise preserved as an opaque block node holding the original
text, so nothing is dropped. Import then export round-trips semantically for supported syntax and
byte-for-byte for opaque nodes and code blocks; it is not byte-for-byte for the whole file.

For AI translation, rich text travels as Markdown inside the structured JSON response (a string per
field). Before the Markdown is sent, every code block, opaque node and inline code span is replaced
by a numbered sentinel token (`⟦MOGGING:3⟧`) and the originals are kept aside; the model is told the
sentinels are immutable. On return the draft is converted back to a tree, every sentinel is checked
to appear exactly once and is replaced by its original node, and only then is the tree validated.
Structural validation compares the tree shape of draft and source: same block count and order of
block types, same set of link targets, same sentinels present exactly once each, same placeholder
tokens (`{name}` style) present exactly once each. A draft failing this is rejected before it is
recorded.

### 6.6 References

A reference field stores the target document id only. Resolving a reference in locale L applies
the same fallback rule to the target document, and reports whether the target resolved in L or
through fallback, so a renderer can decide what to do with a cross-locale link. A target whose collection
has localized fields and that has no published localized head anywhere in the chain does not resolve (and
`resolve` omits it from listings), even when its shared head is published; a collection with only shared
fields resolves on its shared head.

### 6.7 Schema as code and migrations

The schema is a TypeScript module exporting collections built with the engine's field builders.
Validation types are derived from it. Adding a field is a schema change with no data migration.
Renaming a field is a migration that rewrites heads and leaves history readable through an alias
table in the schema. Flipping a shared field to localized is a migration that copies the value into
the source locale and removes it from the shared snapshot; history stays intact.

Migrations are numbered SQL and TypeScript files run by the CLI; engine-level migrations (the tables
below) and adopter-level migrations (their schema changes) share one runner and one ledger table.

The adopter's configuration lives in one file, `mogging.config.ts`, exporting the schema, the locales
and fallback chains, the provider and model settings, and the budgets.

## 7. Storage

### 7.1 Tables

`documents(id uuid pk, collection text, created_at, created_by, deleted_at, deleted_by)`.

`document_shared(id bigint identity pk, doc_id, version int, state text, data jsonb,
is_head_published bool, is_head_draft bool, created_at, created_by, published_at, published_by,
unpublished_at, unpublished_by)`; unique (doc_id, version); partial unique (doc_id) where is_head_published; partial
unique (doc_id) where is_head_draft. Same states and lifecycle as the localized table minus
`DRAFT_AI` (shared fields are never AI-generated).

`document_localized(id bigint identity pk, doc_id, locale text, version int, state text, data jsonb,
source_hashes jsonb, field_warnings jsonb not null default '{}', is_head_published bool, is_head_draft bool, created_at, created_by,
published_at timestamptz null, published_by text null, unpublished_at timestamptz null, unpublished_by text null)`; unique
(doc_id, locale, version); partial unique (doc_id, locale) where is_head_published; partial unique
(doc_id, locale) where is_head_draft; index (doc_id, locale, version); index (doc_id, locale,
published_at) for time-travel. `state` is one of PUBLISHED, DRAFT_HUMAN, DRAFT_AI, APPROVED.
`field_warnings` holds the warnings the row's AI text still carries, per field (field path to distinct
warning texts; a field with none has no key); it is `{}` once the row is approved. INVARIANT: every writer
that creates or copies a `DRAFT_AI` row must set it, because the default `{}` lets the 8.4 gate pass. A
field carried over from a superseded draft keeps the warnings of the text it carries; a field the AI
re-drafts has exactly its new call's warnings.

`content_provenance(id, doc_id, locale, version int null, field_path text null,
superseded_version int null (the draft version this row replaced, spec 8.1), call_id uuid null (every row
one provider call produced shares it, kept or discarded), job_id null,
model_id, prompt_version, prompt_tokens, completion_tokens, cost_micros, edited bool, discarded bool,
discard_reason text null, warnings text[] not null default '{}', acknowledged_warnings text[] null,
bulk_id uuid null, approved_by, approved_at, created_at)`, with a partial index on `bulk_id` where not null. `warnings` holds the validator warnings
of section 8.4 for that field; `approve-clean` (8.6) considers only drafts whose row's `field_warnings`
(above) is empty, so a field carried over from a superseded draft still counts. `version` and `field_path` are null
on a discarded-cost row, which records a provider call whose result was never stored (section 8.2).
Every provider call produces exactly one provenance row per field it covered, or one discarded row.

`ai_jobs(id, doc_id, locale, field_paths text[], source_version, source_hashes jsonb, state,
attempts, max_attempts, run_after, locked_until, locked_by, cost_estimate_micros bigint, budget_scope
text, error_message, created_at, updated_at)`; partial unique (doc_id, locale, source_version) where state in (QUEUED,
RUNNING); index (run_after, id) where state = QUEUED; index (locked_until) where state = RUNNING for
the reaper. A job covers all stale fields of one (document, locale) at one source version.

`releases(id, name, created_by, created_at, published_at, published_by, allow_stale bool)`, unique (name), and `release_items(release_id,
doc_id, locale, draft_version, added_by, added_at)`; publishing a release flips every item's head in one transaction.

`glossary(id, source_locale, target_locale, term, translation, accepted_forms text[], do_not_translate
bool, note, updated_by text not null, updated_at timestamptz not null default clock_timestamp())`;
unique (source_locale, target_locale, term).

`ai_budgets(id, scope text, period_start date, cap_micros bigint, spent_micros bigint)`; `scope` is
`global` or `collection:<name>`; one row per scope per calendar month. There is no reservation
column; in-flight spend is the sum of `cost_estimate_micros` over RUNNING jobs (section 8.5). The
per-run budget is a `compile` argument, not a row. `ai_jobs` carries `cost_estimate_micros bigint`
and `budget_scope text`.

`migrations(name text pk, applied_at)`.

The DDL that was executed in the measurement is in `.clavity/scratch/storage-layout/claude-probe.sql`.
This document supersedes the probe where they differ: the probe's `state` check lacks `APPROVED`, its
`document_shared` lacks the head pair, and its `ai_jobs` is per field. The builder writes the first
engine migration from this section and keeps the probe only as the origin of the schema test.

### 7.2 Writes

Saving a draft: in one transaction, lock the `documents` row (`SELECT ... FOR UPDATE`), allocate the
next version for that (doc, locale), clear the previous draft head flag, insert the new snapshot row,
and write provenance rows for any AI-produced fields. A write that expected a different current version
fails with a conflict; `approve` and `rejectDraft` take the same optional `expectedVersion` as `saveDraft`
(the draft head version the reviewer saw). Locking the document row rather than the head row works for the first write
too, when no head exists. Publishing is the flag flip described in section 6.3, under the same lock.
Any operation that locks several documents (publishing a release, bulk import) locks them in
ascending `documents.id` order, so two concurrent multi-document operations cannot deadlock.

Null handling: before a snapshot is stored, top-level keys whose value is JSON null are removed,
because the top-level field is the fallback unit. Inside a nested value, null is an ordinary value.

### 7.3 Reads

A page read resolves N documents in one query: the shared head per document, plus the published
head for each locale in the chain, merged in chain order with the lowest-priority locale first.
Per-field chain overrides are applied by the query builder from the schema. Measured plan: index
scans on the partial head index, one search per document per locale.

Time-travel reads replace the head predicate with the `published_at` / `unpublished_at` window from
section 6.3.

### 7.4 Staleness queries

Per document: join the target heads with the source head and compare hash vectors. Measured at a
few milliseconds. Whole-site sweep: the same join across all heads. Measured at about 1.25 seconds
for 10k documents and 35k target heads, which is the shape the compile job uses. A dashboard-grade
"everything stale" view is deferred; if needed, add a `stale_count` marker on target heads
maintained by the compile job.

### 7.5 What was measured

On local Postgres 18.6, 10k documents, 5 locales, 10 versions, 30 fields (450k localized rows,
777 MB): DDL ran verbatim; the 50-document fallback read used index scans only, about 26 ms in a
single uncontrolled sample; the global staleness sweep found the expected stale set in about 1.25 s;
per-document staleness about 2.6 ms; a second published head was rejected by the index; the queue
pop worked. Reproduced defect: with the plain JSON merge, a translation containing JSON null
overrode the fallback in 100 of 100 cases. Stripping nulls fixed all 100. Timings are indicative only.

### 7.6 Deferred, not precluded

Branching: adding a `branch` column to the head uniqueness indexes is a migration. Releases cover
the "publish a set atomically" need without it. SQLite: the JSON merge and identity columns differ;
revisit when a dev-mode adapter is worth it.

## 8. The AI pipeline

### 8.1 State machine

For each (document, locale) with stale or untracked-and-opted-in fields: STALE (computed) -> QUEUED
(an `ai_jobs` row) -> RUNNING -> a `DRAFT_AI` snapshot recorded, or FAILED or CANCELLED -> APPROVED by
a person -> PUBLISHED.

- A job is cancelled, not applied, if the source version it was queued for is no longer the source
  head when it completes, or if a `DRAFT_HUMAN` head exists for that (document, locale).
- If the draft head is a `DRAFT_AI` or `APPROVED` snapshot that is now stale, the new AI draft
  **supersedes** it: in the same transaction the old draft loses its head flag (it stays in history,
  never publishable because it is no longer a head) and the new `DRAFT_AI` row takes it. The new
  draft is built **from the superseded draft**, not from the published head: every field that is not
  stale keeps the superseded draft's value, including a reviewer's edits, and only the stale fields
  are regenerated. Provenance on the new draft references the superseded version, and the review
  surface shows the superseded value of each regenerated field beside the new one. Only
  `DRAFT_HUMAN` blocks.
- Publishing a `DRAFT_AI` snapshot directly is not allowed; the SDK enforces it, and the publish path
  requires an actor.
- An `APPROVED` draft can go stale while waiting for a release. Publishing a release re-checks every
  item against the current source head and refuses the whole release if any item is stale, listing
  them. The operator can re-compile those items or publish with an explicit `--allow-stale` flag that
  is recorded on the release.
- A FAILED job for a source version may be re-enqueued by a later `compile`; the idempotency index only
  blocks duplicates of QUEUED and RUNNING jobs.

### 8.2 Jobs

Jobs are rows claimed with `FOR UPDATE SKIP LOCKED`, leased with `locked_until`, retried with
exponential backoff up to `max_attempts`, and pausable per scope. Writing the `DRAFT_AI` snapshot,
its provenance rows, and the job's COMPLETED state happen in one transaction, so a crash leaves
either a complete result or a re-claimable job, never a draft without a completed job. That
transaction begins by updating the job row conditionally: `WHERE id = $job AND state = 'RUNNING' AND
locked_by = $worker AND locked_until > now()`. If that update affects no row, the worker's lease was
lost (the reaper requeued the job, or another worker now holds it): the worker discards its result,
records the provider cost it incurred against `spent_micros` and in provenance with a `discarded`
flag, and writes nothing else. This is what stops a slow worker from committing a stale draft over a
re-run.

One job translates all stale fields of a (document, locale) in one prompt, with the unchanged
sibling fields and the shared fields supplied as context. A single field whose source exceeds the
configured per-field token limit is sent in its own request; a field larger than the model's context
window fails the job with a reason that names the field.

### 8.3 Providers

The engine uses the Vercel AI SDK (`ai`, v7 line) as its provider abstraction. OpenRouter is
supported through the official `@openrouter/ai-sdk-provider`; direct Anthropic, OpenAI and Google
providers and a local Ollama provider are supported through their AI SDK providers. The builder
verifies provider and SDK peer-dependency compatibility at project setup and commits a lockfile.
Configuration names a default model per task (translate, summarize-change) and allows per-collection
overrides. Model ids are configuration, never schema. Generation uses structured output with a schema
`{ fields: { [topLevelField]: JsonValue }, glossaryTermsUsed: string[] }`, where each value must
match the field's declared type (a list field returns a list, an object field an object, and rich
text a Markdown string, section 6.5), so no conversational text leaks into content. The per-field
type check in section 8.4 is what rejects a mismatch. Temperature is fixed low.
The prompt is a versioned template file in the repo with a `standard` and a `strict` variant; the
variant and version are written to provenance.

Content is always passed to the model as data in a delimited user message, never in the system
prompt, and the validators in section 8.4 are the guard against content that tries to instruct the
model (for example a source paragraph saying "ignore the glossary"). The validators check structure
and terminology, not meaning: a translation that is structurally perfect and semantically wrong is
caught only by the reviewer. That is why the approval step exists and why there is no bulk approval
without the owner's explicit decision (section 8.6).

### 8.4 Validation before a draft is recorded

1. Type validation for every field; structural validation (section 6.5) for rich text.
2. Placeholder parity: every `{token}` in the source appears exactly once in the draft.
3. Do-not-translate terms must appear unchanged in the draft.
4. Glossary terms: for every glossary term in the source, the draft must contain the approved
   translation or one of its `accepted_forms` (inflected languages need this). By default a miss is a
   **warning** attached to the draft and shown prominently at review, not a rejection, because a
   deterministic check cannot cover every inflection. A collection or the whole config may set
   `glossary: "strict"`, which makes a miss a rejection like checks 1 to 3. The review surface
   counts warnings per draft and refuses to approve a draft with warnings unless the reviewer
   acknowledges each one by name; the acknowledgement is recorded in provenance. The refusal lives in
   core `approve` (D-warn): a draft with warnings is approved only with `acknowledgedWarnings` equal to
   its distinct warning texts; the CLI's `--ack-warning <text>` and the interactive prompt feed it.

A draft failing 1, 2 or 3 is not stored. The job's first failed attempt is retried once with the
`strict` prompt variant; a second failure marks the job FAILED with the validation reason.

### 8.5 Cost control

There is no stored reservation counter, so nothing can leak. Each job row carries
`cost_estimate_micros`. A worker claims a job only if, in the same statement, `spent_micros` for the
scope plus the sum of `cost_estimate_micros` over jobs in RUNNING **whose lease is live**
(`locked_until > now()`) for that scope plus this job's estimate is at or below the cap; otherwise
the job stays queued with a `budget_exhausted` reason visible in `mogging jobs`. A RUNNING job whose
lease has expired does not count: its worker is presumed dead. Before each claim the worker also
runs the reaper step, which moves expired-lease RUNNING jobs back to QUEUED (or to FAILED if
`attempts >= max_attempts`), so a crashed worker can never pin budget or block the queue. The actual
cost of every provider call is added to `spent_micros` and written to provenance in the same
transaction as the job's transition, whatever that transition is: completed, failed on validation,
cancelled because the source moved or a human draft appeared, or discarded after a lost lease. A
call that happened is spend, regardless of whether its result was kept. The claim statement
takes the budget row `FOR UPDATE`, so concurrent workers serialize on it and cannot overspend the
cap. A lease is renewed by the worker while a provider call is in progress; the lease length is
configuration and must exceed the provider timeout.

Token estimate: input tokens = (characters of the source fields and sibling context sent) / 3 for
Latin-script locales and / 1.5 for CJK target or source locales, plus the prompt template's measured
token count; output tokens = estimated input tokens of the fields being translated x 1.3. Cost
estimate = tokens x the per-model price table in `mogging.config.ts`, x 1.5 safety factor. The
builder may replace the character heuristic with a provider tokenizer where one is available, but the
safety factor stays. The per-run budget (a `compile` argument) and the monthly cap are both required
configuration; the CLI refuses to compile without them.

### 8.6 The review surface

v0.1 has no admin UI. Review happens through the CLI, which prints a side-by-side diff of source
change and AI draft per field with glossary matches and warnings highlighted, and accepts approve,
reject (of single fields through `approve`, or of the whole draft through `rejectDraft`), and
edit-then-approve per (document, locale). There is no unconditional "approve all". The
owner-approved bulk path is `mogging review --approve-clean [--collection] [--locale]`: it approves
every `DRAFT_AI` head in scope that has zero warnings and passed every validator, skips the rest
and lists them, and writes one bulk-approval provenance row per approved draft carrying the actor,
a shared `bulk_id` (the count of a bulk approval is the number of rows sharing that `bulk_id`), so a later audit can see which approvals were individual and which
were bulk. The CLI can also serve a minimal local web page with the same side-by-side view for people
who prefer a browser; it is read-and-approve only and is not a CMS editor. This is Claude's call to
keep the "no UI" boundary while still making review humane.

### 8.7 Trust model

v0.1 has no authentication. Anyone with the database URL can do anything the SDK can do. Every write
takes an actor string and records it; approval and publication records are therefore attribution,
not authentication. The engine guarantees that no AI text is published without an approval record
naming an actor; making sure that actor is a real person is the deployment's responsibility, and the
documentation says so plainly. The MCP server, when it comes, will need a real actor model first.

Licensing (section 12) is separate from this trust model: the licence key says whether the
deployment may run guarded writes at all; the actor string says who ran them. Neither authenticates
a person.

## 9. Interfaces

### 9.1 Packages

A single repo with these packages: `@mogging/core` (schema builders, storage, queries, staleness,
migrations), `@mogging/ai` (pipeline, providers, validation, budgets), `@mogging/cli`
(`mogging` binary), `@mogging/markdown` (tree converters, folder import and export). Framework
adapters are separate later packages.

### 9.2 CLI

`mogging init` (scaffold config and schema, run engine migrations), `mogging migrate`,
`mogging import <dir>` (Markdown folders per locale into documents), `mogging export <dir>`,
`mogging status` (current, stale, missing and untracked fields per locale), `mogging track` (opt
untracked fields into staleness tracking), `mogging compile --locales de,fr --budget <amount>
[--collection <name>] [<collection>/<slug> ...]` (queue jobs, run the worker, report; `--budget` is
the per-run cap of section 8.5 and is required), `mogging worker` (long-running), `mogging review
[<collection>/<slug>] [--locale]` (approve, reject, edit-then-approve), `mogging publish
<collection>/<slug> [--locale <l>] | --release <name> [--allow-stale]` (one document, or a release;
there is no unscoped publish-everything), `mogging unpublish <collection>/<slug> --locale <l>`,
`mogging release create|add|publish`, `mogging jobs` (queue depth, running jobs with lease and worker,
failed and cancelled with reasons, budget-exhausted, and per scope: spent, in-flight estimate over
live leases, and cap; `--retry`, `--cancel`), `mogging provenance <collection>/<slug> [--locale]`
(every provenance row for the document including discarded-cost rows, so an operator can see why
spend rose without a draft appearing), `mogging query` (ad hoc reads).

### 9.3 SDK

Every CLI command is a function in `@mogging/core` or `@mogging/ai` taking a typed context (database
connection, schema, actor). Reads: `getDocument`, `listDocuments`, `resolve` (locale chain applied),
`getSyncState`, `listDraftHeads`, `getDraftReview`, `listReleases`. Writes: `saveDraft`, `approve`,
`rejectDraft`, `publish`, `unpublish`, `createRelease`, `addToRelease`, `publishRelease`. Pipeline: `enqueueStale`, `runWorker`. Licensing (section 12):
`verifyKey`, `getLicenceState`, `assertLicensed`, the `LicenceError` class and the `LicencePayload`
type; key signing is a separate tool, not part of the SDK. Every write takes an actor and is
recorded (the migrations bootstrap, which has no human actor, is the one exception). The worker logs one line per job with job id, model, tokens, cost and outcome.

### 9.4 Wire and file formats that are contracts

The portable rich-text tree, the canonical JSON hashing, the Markdown import folder layout, and the
provenance row. Changing any of these is a versioned migration with a converter.

Import layout: `content/<locale>/<collection>/<slug>.md`. The file name is the shared `slug` and is
the same in every locale folder; a translated display slug, if wanted, is an ordinary localized text
field in front matter. The Markdown body goes to the collection's designated body field (6.1); other
front-matter keys map to fields by name. A document's identity on import is (collection, slug) from
the source-locale file; other locales match by the same relative path. Shared fields are read from the
source-locale file only; shared keys in other locales' front matter are ignored with a warning.
Re-importing updates existing documents as new `DRAFT_HUMAN` versions instead of creating duplicates;
`--publish` publishes them in the same run.

Front-matter null rules follow section 6.2: a bare key with no value (`banner:`) parses as null and
means absent; an explicit empty (`banner: ""`, `tags: []`) means suppressed. `mogging export`
always writes empties explicitly and never writes a bare key, so an export-then-import round trip
preserves suppression.

**Implementation notes (plan 2).** Slugs may contain `/` (nested folders) and must be lowercase. `.md` and `.mdx` are both accepted and the extension sets the parse mode. Undeclared front-matter keys are a per-file error. References in front matter are a slug or a UUID. Reference slugs are case-insensitive (normalized like slugs); a null entry where a reference is declared is a per-file error. A whitespace-only body means absent. An unchanged file is skipped, as approved in F5.

**Implementation notes (plan 3).** F1: AI settings are built by `defineAiConfig` in `@mogging/ai`, exported next to the core `config` from `mogging.config.ts`; core's `MoggingConfig` is unchanged. F2: OpenRouter is built in, and a `custom` provider takes any AI SDK `LanguageModel` keyed by model id; every model named anywhere needs a price-table entry, because `content_provenance.model_id` is `not null`. F3: `@mogging/ai` owns the SQL on `ai_jobs`, `ai_budgets`, `glossary` and the discarded-cost provenance row, with one lock order everywhere (`ai_budgets` rows, global first, then the `ai_jobs` row, then `documents` through `recordAiDraft`); the reaper commits in its own transaction before each claim. F4: only localized fields with a `text` or `richText` leaf are sent to the model; other stale or missing localized fields are reported as `not translatable` and never copied. F5: `content_provenance.superseded_version`, `call_id` and the glossary unique index on (source locale, target locale, term) were added to migration 0001, which is still unreleased; `recordAiDraft` fills `superseded_version` when it supersedes a pending AI draft. F6: the monthly cap is enforced inside the claim transaction under the budget row lock (one transaction, not one statement), and a refused job stays `QUEUED` with a `budget_exhausted:` message and a later `run_after`; the per-run budget is an in-memory tally that stops the run and marks nothing. A call's tokens and cost are apportioned over the fields of its request by their share of the translated characters (floor rounding, remainder on the first field), so the per-field rows sum to the call; every call that happened gets a `call_id` and is recorded (a kept row per field, or one discarded row for the call). The AI SDK is called with `maxRetries: 0`, so the only retry is the strict re-prompt and every attempt is counted and paid once. If the completion transaction throws after a provider call, a separate cost-only transaction records the spend; it locks the budget rows first and only then checks whether the first transaction committed (by looking for a provenance row with one of the call ids), so an ambiguous commit is never debited twice. Enqueue drops fields that a pending `DRAFT_AI` or `APPROVED` draft head already covers at the source hash, so a second compile does not buy them again; a pending `DRAFT_HUMAN` skips the pair and cancels its `QUEUED` job. Every comparison and stored timestamp in the job queue (leases, back-off, the fence) and the budget month use the database clock, not the worker host's.

## 10. Left to the builder, and to the owner

**Builder decides** (within the above): database client library and migration runner; exact
field-builder API ergonomics; the canonical JSON library; the prompt wording; the CLI argument parser;
the look of the local review page; test fixtures; CI layout; how the worker is supervised; log format.

**Required spike before the AI package is planned in detail.** The storage layer was measured
(7.5); the rich-text pipeline in 6.5 was not. Before the plan commits to the sentinel mechanism, a
throwaway spike must run real docs pages (with admonitions, tables, inline code, MDX components and
placeholders) through Markdown-to-tree, sentinel replacement, a real model via OpenRouter, re-insertion
and structural validation, and report the rejection rate and the failure kinds. If models routinely
disturb sentinels, the fallback design is to send each block as a separate item in the structured
output rather than one Markdown string. The spike's result goes in the plan, not in this document.
The peer also noted that translatable text inside admonitions is lost to the opaque-node rule; the
spike measures how common that is for the showcase docs before v0.1 decides whether to parse
admonition bodies.

**Owner decided (2026-11-11):** every company pays (section 12 is the agreed execution; the MIT
decision taken earlier the same day is withdrawn); npm scope `@mogging`; v0.1 is announced only after a
framework template exists; and bulk approval is allowed as `mogging review --approve-clean`, which
approves only drafts with zero warnings and records one bulk-approval provenance row per approved draft naming
the actor, with the count derived from the rows sharing the `bulk_id` (section 8.6). The review peer had predicted that strict per-document review
of a first import would be bypassed with shell loops; a sanctioned bulk path with a record beats an
unsanctioned script with none.

## 11. What v0.1 looks like when done

A developer installs the CLI, runs `mogging init` against a Postgres URL, points `mogging import
--publish` at a folder of English Markdown docs, declares German and Japanese in the schema, sets an
OpenRouter key and a monthly cap, runs `mogging compile --locales de,ja --budget 5`, reviews a
side-by-side diff per document and approves each, adds the approved drafts to a release with
`mogging release add`, and publishes the release. They then edit one English paragraph, run `mogging status`, see exactly one stale field in
two locales, compile again, and the bill is cents. A typed `resolve` call from their Astro or Next
site returns the German page with Swiss-German overrides and English fallback for the one field no
one translated, and says which fields fell back.

## 12. Licensing and enforcement

This section executes the owner's ruling "every company pays". It is the jointly agreed
recommendation of both reviewers (agy-first rounds 7 and 8, 2026-11-11).

### 12.1 Licence text

The source is published under a custom source-available licence composed of three parts: the
permitted purposes of PolyForm Noncommercial 1.0.0 for individuals and noncommercial organisations
(its "Noncommercial Purposes", "Personal Uses" and "Noncommercial Organizations" clauses); a written
commercial evaluation grant of 30 days for any organisation, royalty-free, for internal testing; and
an anti-circumvention clause modelled on Elastic License 2.0's "Limitations" ("you may not move,
change, disable, or circumvent the license key functionality"). Commercial use beyond the evaluation
requires a paid licence key. The combined text is reviewed by a lawyer before first publication.
The product is never described as "open source"; the words used are "source-available".

### 12.2 Keys

A licence key is a signed JSON payload `{ licensee, license_id, expiry, plan, limits? }` encoded as
one token, signed with the owner's Ed25519 private key. `limits` is an optional object reserved
from v0.1 for later plans (for example `limits.seats`); an engine ignores limit keys it does not
know, so an old engine always verifies a newer key. `@mogging/core` embeds the matching public key
and verifies the token offline with Node's built-in crypto; there is no key server and no network
call. The key is supplied through `MOGGING_LICENSE_KEY` or a `license` entry in `mogging.config.ts`.
One key covers one project (one production engine database) and everything that works against it
or against copies of it: developer machines, CI runners, staging, and the later review hub, GitOps
bot and MCP server. A second production database is a second project. Plan values in v0.1 are
`solo` (paid) and `noncommercial` (zero price, see 12.4).

### 12.3 Grace and guarded operations

First run needs no key. The engine computes a 30-day evaluation window from the earliest
`applied_at` in its own `migrations` table (an empty table, which cannot occur after `migrate`,
counts as day one). Inside the window everything works; every CLI command prints the days remaining,
and from seven days left prints a warning line on stderr, so a CI log shows the expiry coming. After
the window, without a valid key, the **guarded operations** refuse with a message that names the
purchase address and says plainly what is affected. The guarded set is exactly: `saveDraft`,
`recordAiDraft`, `approve` (and therefore `approveClean`), `publish`, `publishRelease`, and `compile`
(the pipeline's enqueue and worker). **Not guarded**, by decision: every read (`resolve`,
`getDocument`, `listDocuments`, `getSyncState`), `unpublish` (an emergency takedown must always
work), `createRelease`, `addToRelease`, `trackFields` (metadata, no content) and `rejectDraft` (it only
removes a draft head). Because reads stay
free, a static-site build that only reads keeps succeeding after the window; what stops is editing,
translating and publishing new content. The refusal message says exactly that: "Reads keep working
and existing builds still succeed; content updates, compiles and publishing are paused until a
licence key is set." Both reviewers acknowledge the window is evadable by starting a fresh database;
the licence clause binds an evader, and the mechanism is designed for honest organisations.

Individuals and noncommercial organisations install a zero-price `noncommercial` key (12.4) and
never meet the refusal; the evaluation window is for companies deciding whether to buy.

Keys expire; v0.1 has no revocation. A refunded or lapsed licence is simply not renewed, and keys
are issued for at most one year. The engine accepts a list of public keys so a new signing key can
be rotated in through a package upgrade while old keys stay valid until their expiry. Expiry is
compared in UTC at the end of the stated date.

### 12.4 Buying

A self-serve checkout page (Stripe or equivalent) collects an email and payment, triggers a small
hosted signing function holding the private key, and emails the key and an invoice. No account, no
sales call. The same page issues a zero-price `noncommercial` key on a self-declaration that the
use is a permitted noncommercial purpose under the licence; the declaration is recorded with the
key, and the licence text, not the engine, binds it. Because a noncommercial key unlocks the same
operations as a paid one, the engine makes the plan visible: with a `noncommercial` key every CLI
command prints one line, "MoggingCMS noncommercial licence: commercial use is not permitted", the
review hub shows the same line in its footer, and the licensee name from the key is printed with
it. A company cannot deploy a free key silently. Keys can be re-sent to the purchase email on
request. Refunds are honoured for 14 days; because keys cannot be revoked, a refunded key lapses
at its expiry, an accepted loss. Pricing is flat, per project per year. Per seat is impossible before authentication
exists; per AI token contradicts bring-your-own-key. The price is the owner's and is unmeasured;
the placeholder discussed is a few hundred dollars a year, below common expense-card thresholds,
to be revised after the first ten purchases.

### 12.5 Contributions

A contributor licence agreement is required from the first external pull request, granting the
owner a perpetual, irrevocable, sublicensable right to commercially license the contribution. Until
the agreement tooling exists, external pull requests are not merged.

### 12.6 Measurement

The engine carries no telemetry. The business metrics are purchases and recurring revenue measured
at checkout, against top-of-funnel reach (package downloads, documentation visits). "Trial-to-paid"
is not computable from keys, because evaluation needs no key; both reviewers initially wrote that it
was and corrected it.

### 12.7 What this supersedes

The MIT decision and the open-core roadmap and measurement-gate discussions of 2026-11-11 are
withdrawn. Managed cloud and enterprise governance remain later releases on the paid path, sequenced
after the first paying customers; a hosted service, when it comes, isolates tenants per database or
schema and never retrofits a tenant column onto the v0.1 indexes.

## Appendix A. Review ledger

Folded from the solo adversarial panel (round 1, 2026-11-11), each verified against the text:

- Time-travel keyed on creation time was wrong; `published_at` / `unpublished_at` added (6.3, 7.1, 7.3).
- Edit-then-approve semantics defined (6.3); provenance carries `edited` and `job_id` (7.1).
- Untracked versus stale distinguished; human saves assert sync (6.4); `mogging track` added (9.2).
- List reordering makes trailing items stale; documented as a known limitation (6.1).
- Canonicalization pinned to RFC 8785 with NFC text (6.4); locale codes BCP 47 (6.2).
- Raw HTML passed through opaque; rich text travels as Markdown inside structured output (6.5, 8.3).
- Version allocation locks the document row so the first write works (7.2).
- Draft write, provenance and job completion in one transaction (8.2); human-draft guard is the
  partial unique index (6.3).
- Approved-but-stale drafts at release time are refused unless `--allow-stale` (8.1).
- Oversized fields split or failed with a named reason (8.2).
- Budget reservation made atomic against concurrent workers (8.5).
- Glossary check split: do-not-translate is a hard failure, translated terms are warnings with
  accepted forms (8.4); strict-prompt retry defined once (8.4).
- Prompt-injection posture stated: content as delimited data, validators as the guard (8.3).
- Trust model stated: attribution not authentication; no approve-all (8.6, 8.7).
- `unpublish` added as the reversible counterpart of publish (6.3, 9.2).
- Import identity and shared-field precedence defined (9.4); config file named (6.7).

Folded from the builder check (fresh reviewer, 2026-11-11):

- A locale with no snapshot never showed as stale; `missing` state added and the sweep enumerates
  declared locales (6.4). Orphaned fields defined.
- Per-field review against a per-locale snapshot defined: whole-snapshot review, per-field reject,
  `APPROVED` is a new version, the AI version is never publishable (6.3).
- Shared fields now have the same draft and publish lifecycle and can be in releases (6.3, 7.1).
- Unit of localization fixed to the top-level field; nested values fall back as a whole (6.1, 7.2).
- Publishing flips flags on the draft row; no copy (6.3, 7.2).
- Unsupported Markdown syntax preserved as opaque nodes; round-trip bar stated (6.5).
- Body field designation, slug as shared file name, re-import as drafts (6.1, 9.4).
- Probe DDL marked as superseded where it differs; budget scope values and per-run budget defined
  (7.1).

Agy panel escalation, round 1 (2026-11-11), 13 findings, each verified against the text or measured:

- FOLDED: structured-output schema could not carry list and object fields; now typed JSON values
  checked per field (8.3).
- FOLDED: null-stripping made intentional suppression impossible; empty value defined as "show
  nothing" (6.2).
- FOLDED: a crashed worker leaked budget reservations forever; reservation counter removed, in-flight
  spend derived from RUNNING jobs (7.1, 8.5).
- FOLDED: opaque nodes were never sent to the model yet required byte-identical on return; sentinel
  tokens defined (6.5).
- FOLDED: multi-document publish could deadlock; lock in ascending document id (7.2).
- FOLDED: recompiling a stale APPROVED or DRAFT_AI head hit the draft unique index; supersede rule
  added (8.1).
- FOLDED: date-time format drift would break hashes; typed normalization before hashing (6.4).
- FOLDED: no queue observability; `mogging jobs` added (9.2).
- FOLDED: token estimate formula was unspecified; defined with a safety factor (8.5).
- FOLDED: glossary warnings could be skipped by fatigue; strict mode and named acknowledgement (8.4).
- FOLDED: semantic prompt injection passes structural checks; stated as the reviewer's job (8.3).
- REJECTED: "enqueueing 40k jobs in one transaction bloats WAL and memory". Measured on Postgres
  18.6: 40,000 job rows inserted in one transaction in 503 ms, 16 MB WAL, 11 MB table.
- REJECTED: "monorepo split risks duplicate AI SDK versions". Section 8.3 already requires
  peer-dependency verification and a committed lockfile; `@mogging/ai` is the only package that
  depends on the SDK.
- OWNER DECISION PENDING: the peer predicts that "no approve-all" will be bypassed by scripts on a
  first import of hundreds of documents (8.6). See section 10.

Agy panel round 2 (2026-11-11), fold audit plus activation, cascade and state seats, 6 findings:

- FOLDED: superseding a stale APPROVED draft discarded the reviewer's edits on unchanged fields; the
  new draft is now built from the superseded draft and regenerates only stale fields (8.1).
- FOLDED: in-flight budget counted RUNNING jobs with expired leases, so a crashed worker near the cap
  blocked the queue; only live leases count and a reaper requeues expired ones (8.5).
- FOLDED: empty-value suppression had no meaning for scalar kinds; `fallback: "none"` defined (6.2).
- FOLDED: `compile` lacked the required `--budget` flag in the CLI surface and the walkthrough (9.2,
  11).
- FOLDED: `publish` without a release had no scope; document scoping defined, no publish-everything
  (9.2).
- FOLDED: export could write a bare key that re-imports as null; export writes empties explicitly
  (9.4). The peer's mechanism was half right: a quoted empty string parses as a string in YAML, a
  bare key parses as null.

Agy panel round 3 (2026-11-11), fold audit, procedure walker, mechanism gamer, resource vampire:
all six round-2 folds audited correct; the walker completed the section 11 scenario end to end;
3 findings:

- FOLDED: job completion had no compare-and-swap fence, so a worker past its lease could commit over
  a re-run; conditional completion update and discard rule added (8.2).
- FOLDED: the reaper scanned RUNNING jobs without an index; partial index on `locked_until` added
  (7.1).
- FOLDED: the walkthrough published a batch without a release; now uses `import --publish` and a
  release for translations (11).

Agy panel round 4 (2026-11-11), fold audit, boundary, blindspot and whole-document consistency:
round-3 folds (b) and (c) correct; 4 findings, all consistency drift from earlier edits:

- FOLDED: the discarded-cost record had no home; provenance gained `discarded`, `discard_reason`,
  nullable `version` and `field_path` (7.1).
- FOLDED: provider cost was debited only on completion; now debited on every terminal transition
  (8.5).
- FOLDED: `ai_jobs` column list still named the removed budget fields; corrected (7.1). `releases`
  gained `allow_stale` (7.1).
- FOLDED: `mogging jobs` now shows in-flight estimate; `mogging provenance` added (9.2).
- FOLDED (from the open question): the rich-text pipeline is unmeasured; a required spike is named
  in section 10.
- DISCARDED-BELOW-FLOOR by the peer, accepted: `document_shared` permitting `APPROVED`; `now()`
  semantics in the fence; a missing CHECK that both head flags are not set at once (the partial
  unique indexes and the write path in 7.2 are the guards).

Agy panel round 5 (2026-11-11), fold audit, schema census (92 names, all declared, spot-checked by
Claude), consistency pass, cascade: **CLEAN, no live challenge.** Post-clean fold of one item the
peer discarded: `acknowledged_warnings` added to provenance so the 8.4 record has a column (7.1).
Areas the peer examined least: 6.6 references and 6.7 migrations, checked for consistency only.

Revision after the owner's ruling "every company pays" (2026-11-11, agy-first rounds 6, 7, 8):

- Round 6 read PolyForm Noncommercial 1.0.0 and the Functional Source License and Elastic 2.0 texts
  from the SPDX list; the owner then ruled every company pays.
- Round 7 proposed the in-engine key with a built-in evaluation window; Claude measured that Node's
  crypto provides Ed25519 and that the Elastic 2.0 anti-circumvention clause reads as cited.
- Round 8 produced the agreed text: 7 points agreed, 2 amended (key payload uses `license_id`; the
  plan tasks that change), 1 dissent accepted (trial-to-paid is not computable from keys), and one
  both-wrong fold (an expired key stops builds, not a static live site). Sections 2, 4, 5, 8.7, 10
  and 12 carry the result.

Agy panel over the licensing revision, round 1 (2026-11-11), 4 material findings and 5 design
notes, all verified against the text:

- FOLDED: the guarded set was ambiguous across files; 12.3 now lists guarded and not-guarded
  operations exactly, `recordAiDraft` added, `unpublish` deliberately free.
- FOLDED: 9.3 did not name the licensing functions the plan exports; added.
- FOLDED: the round-8 "both wrong" sentence was itself wrong: reads are free, so a build that only
  reads keeps succeeding; 12.3 and the refusal message now say so.
- FOLDED: evaluation expiry gave CI no warning; days-left on every command, warning from 7 days.
- FOLDED: no revocation and no rotation path were stated; one-year keys, no revocation in v0.1,
  rotation through a list of accepted public keys (12.3).
- FOLDED (plan): signature verified over raw payload bytes; empty migrations table defined;
  `config.ts` added to the files Task 9B modifies.

Roadmap review (builder check and agy panel on the roadmap doc, 2026-11-11) exposed three gaps
in this document, folded: the key schema gains a reserved optional `limits` object and names the
plan values (12.2); a zero-price `noncommercial` key is issued by the checkout page so free users
never meet the refusal (12.3, 12.4); key re-issue and the refund rule are stated (12.4).

## Stand-downs

- DISCARDED-BELOW-FLOOR: fallback chains deeper than five or more than one hundred locales; the
  read query shape (7.3) is linear in chain length and the artifact scopes v0.1 to docs sites.
