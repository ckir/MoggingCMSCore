# Starlight integration: drop-in package and starter template (v0.1 ship step 2)

Date: 2026-11-13. Status: DRAFT, awaiting owner approval. Size: a project. Step 2 of
`docs/superpowers/specs/2026-11-13-v01-ship-sequencing-design.md`. Agy-first consults: seams
`.clavity/seams/starlight-source-first.md`, `starlight-shape-first.md`, `starlight-negotiate-first.md` (replies in
`.clavity/scratch/starlight-source`, `starlight-shape`, `starlight-negotiate`), all [VERDICT: ALIGNED] after
verification. Starlight facts below were read from the source of `@astrojs/starlight@0.43.0`.

## 1. Intent and why

The buyer (core design section 2) is a tech lead or docs engineer at a 20 to 500 person company who already has a
docs site in a git repository and will not migrate to a sample (roadmap section 5, v0.1). Two artefacts reach that
buyer: a drop-in package for an existing Starlight site, and a cloneable starter template for a new one. v0.1 is
announced only after a template exists (core design section 10). Step 2 runs before migration 0001 is frozen, so a
real consumer can still surface a schema or SDK change (ship-sequencing spec, approach D).

Success: an adopter with an existing Starlight repository installs the package and, in one session, imports their
English, compiles two locales with AI, reviews and approves, exports, and their unchanged static-host build serves the
approved pages, with Starlight's own fallback for untranslated pages. No AI text reaches the built site without a
recorded human approval. A later English edit appears as stale in `mogging status` with no manual bookkeeping.

## 2. Goals, non-goals, anti-goals

- Goals: the adopter's English stays where it is; the site build needs no database, no network and no licence key;
  nothing the team wrote by hand is overwritten or deleted without being told; renames keep translations.
- Non-goals: a CI bot that runs Mogging for the team (roadmap v0.2); frameworks other than Starlight (roadmap item 6
  picks the next ones from purchaser answers); a local review web page (TODO.md, v0.2); materializing per-field
  fallback into files.
- Anti-goals: an adopter's existing hand-made translations lost or silently marked current on day one; English text
  recorded as a human translation; an Astro integration that makes their build depend on Mogging.

## 3. Constraints

- Owner rule: nothing pushed or published without the owner's word.
- Migration 0001 may still be edited until the freeze (ship-sequencing step 3). Every change this design proposes is
  SDK or package level: no migration change (sections 5.8 and 8 were checked for one and need none).
- Escalation rule (ship-sequencing step 3): if building this turns up a change larger than a TODO-class fix, stop
  and bring it to the owner instead of extending step 2.
- Verified Starlight facts: Starlight supports only file-based loaders, every docs entry has a `filePath`
  (`src/utils/routing/types.ts:61-63`, `src/utils/routing/index.ts:31`); the docs collection is a glob of
  `**/[^_]*.{md,mdx,...}` under the docs collection path (`src/loaders.ts:55-57`); the first path segment is the
  locale and the default language may be the `root` locale with no folder; a page missing in a locale gets a fallback
  route to the default-locale page with `isFallback: true` (`src/utils/routing/index.ts:51-74`), rendered with the
  `FallbackContentNotice` banner (`src/components/Page.astro:108`); front matter has `title` required and
  `description, editUrl, head, tableOfContents, template, hero, lastUpdated, prev, next, sidebar, banner, pagefind,
  draft` optional (`src/schema.ts:16-112`).
- Verified Mogging facts (main 43a5c3e): import layout `<locale>/<collection>/<slug>.md` (core design 9.4,
  `packages/markdown/src/import.ts:133-160`); an undeclared front-matter key is a per-file error
  (`packages/markdown/src/contentFile.ts:114`); a changed non-source file is saved as a human draft and `--publish`
  publishes it (`import.ts:367-379`); a hand-edited file replaces a pending `DRAFT_AI`/`APPROVED` draft with a warning
  only (`import.ts:301-304`, `:365`); `saveDraft` records the CURRENT source hash for a new or changed target value
  (`packages/core/src/documents/saveDraft.ts:90-107`); a target field with no source hash is `untracked`
  (`packages/core/src/sync/state.ts:66-72`) and `enqueueStale` queues only `stale` and `missing`
  (`packages/ai/src/jobs.ts:140`); export writes unconditionally and never deletes
  (`packages/markdown/src/export.ts:216`); document identity on import is (collection, slug)
  (`import.ts:341-345`); slug is a shared, non-localizable field (`packages/core/src/schema/config.ts:31-32`).

## 4. Approaches considered

- **A. English in git, translations written back as files.** Chosen by the owner (2026-11-13). Matches the buyer;
  the build stays file-only; translations appear in pull requests.
- **B. Mogging's database as the source, read at build time through `resolve`.** Rejected: Starlight supports only
  file-based loaders, the static-host CI would need Postgres, and the English would leave git.
- **C. Hybrid (English in git, translations loaded from the database at build).** Rejected for the same loader and
  CI reasons as B.

Agreed by agy and Claude, approved by the owner (2026-11-13): the dispositions in section 5. Negotiated by agy and
Claude on the owner's request, approved by the owner (2026-11-13): renames (5.6) and the package shape (6).

## 5. Behaviour (decided)

### 5.1 Who runs what

A person runs the `mogging` CLI on a machine that reaches the Postgres database (local, or shared). The site's own
CI runs only `astro build` on the committed files. The locale folders and the manifest (5.4) are committed to git
like any other file.

### 5.2 Folder layout

The package maps Starlight's layout to Mogging documents: `<docsDir>/<path>.md` is the source-locale document of the
configured docs collection with slug `<path>`; `<docsDir>/<localeDir>/<path>.md` is the same document in that locale.
`<docsDir>` defaults to `src/content/docs`. Both Starlight modes are supported: the default language at the root
(Starlight `root` locale) and the default language in its own folder. There is no collection segment in the path; a
Starlight site has one docs collection.

Locale identity: folders use Starlight's locale keys (`zh-cn`, or no folder for `root`); the database keeps canonical
BCP 47 tags as `normalizeLocale` produces them (`packages/core/src/schema/locale.ts:4`). The mapping is declared once
in `mogging.config.ts` and generated by `mogging init --starlight` from the Starlight `locales` config.

### 5.3 Day one: existing translations

Translated pages already in the adopter's repository are imported as published human translations WITHOUT a source
hash, so every field reads `untracked`, not `current`. They are PUBLISHED on import whether or not `--publish` is
given (agy round 3 correction: left as drafts, export would see nothing published and drop every file). "No Mogging
history" is per (document, locale): the locale has no row of any state for that document. A locale that already has
any row, a `DRAFT_AI` included, takes the normal path below. `mogging status` lists untracked fields; compile never
re-translates them on its own. The reviewer either marks a page current with `mogging track` once they have checked
it, or runs `mogging compile --include-untracked` (a new `enqueueStale` option in `@mogging/ai`, Claude's call) to
get AI drafts for untracked fields through the normal review. Core addition: a `saveDraft` option that records no
source hash for the saved target fields (exact name left to the plan).

English (the source locale) is always published on import in Starlight mode: the git file is already the live,
PR-reviewed page, and compile and sync state read only the source locale's published head (`packages/ai/src/jobs.ts:167`,
`packages/core/src/sync/state.ts`). A changed locale file with history is saved as a human draft and published only
with `--publish` (Claude's call).

Starlight-mode import ignores shared front-matter keys in a locale file silently when they equal the source page's
values and warns (today's `contentFile.ts:106` warning) only when they differ, because export writes them (5.4).

### 5.4 Export, the manifest and hand edits

- Starlight-mode export never writes, moves or deletes a source-locale (English) file.
- Export writes a locale file only when the locale's published head has every REQUIRED localized field of the
  collection (Starlight's `title` and the body); missing optional localized fields are left out of the file
  (Claude's call, replacing "every field English has", which would have deleted translations whenever English gained
  an optional field). A page without them gets no file, and Starlight serves the English page with its fallback
  notice. No English text is ever written into a locale file.
- Shared (non-localized) front matter of the source page (`template`, `sidebar.order`, `tableOfContents`, opaque
  fields of 5.8, ...) is copied into every locale file, because Starlight reads these per locale entry
  (`src/utils/navigation.ts:300`, `src/utils/routing/data.ts:54,65`) (Claude's call; today `renderFile` writes shared
  fields only for the source locale).
- Export writes `.mogging/manifest.json` at the repository root: for every file it wrote or adopted, the path, the
  slug, the locale, the version exported and the SHA-256 of the bytes on disk. It holds no database ids (agy round 3),
  so a fresh database or another clone reads it the same way.
- A locale file not in the manifest whose parsed content equals the published head (a day-one hand translation) is
  left byte for byte and adopted into the manifest; it is not rewritten into the serializer's canonical form
  (Claude's call).
- The locale folders are two-way. A hand edit to a locale file (bytes differ from the manifest) is imported as a
  human draft like any changed file. Export refuses to overwrite a locale file whose bytes differ from the manifest
  and whose content has not been imported, names the file, and tells the user to run import first. A pending
  `DRAFT_AI` or `APPROVED` draft that a hand edit replaces is reported as a warning (today's import behaviour, kept).
- When the manifest and the database disagree (a revert, a branch switch, a fresh database), export reports each
  disagreeing file and changes none of them; it never resolves the disagreement on its own.
- An exported page that later goes stale keeps its last approved file until a new translation is approved and
  exported; Starlight serves that older translation in the meantime.

### 5.5 Deletions

- `import --prune` soft-deletes every document of the docs collection whose source-locale file is gone (core
  `deleteDocument`).
- Export removes a locale file only when the manifest lists it, its bytes still match the manifest, and its document
  is deleted or its locale is unpublished. A file never becomes removable only because English changed. A file the
  manifest does not list is never removed.

### 5.6 Renames

- `mogging rename <old-slug> <new-slug>` keeps the document and every locale's history: it saves and publishes the
  shared slug through the existing SDK (core refuses a duplicate, section 8), moves the source file unless it is
  already at the new path (a `git mv` done first is fine, Claude's call), moves the locale files, and updates the
  manifest.
- Import safety stop: when one import run finds, in the docs collection, both documents whose source file is gone and
  source files with no document, it creates and prunes none of them silently. When the pairing is unambiguous (exactly
  one gone and one new in the run) it prints the `mogging rename` command; otherwise it lists both sides without
  guessing a pairing (Claude's call: a wrong guess would move translations onto the wrong page). An explicit
  confirmation flag treats them as deletions plus new pages. Without `--prune` the deleted side is only reported.
- No persistent id is written into the team's files (rejected by both reviewers: undeclared front-matter keys are an
  error today, and a copied page would duplicate its id).

### 5.7 Supported team setup (owner, 2026-11-13; agy and Claude agreed)

Translation state lives only in Postgres. v0.1 supports one shared database per site and one operator (the tech lead
or docs maintainer) running Mogging on a checkout of the default branch, after merges. Running import from a feature
branch against the shared database is unsupported and documented as such (it would publish unmerged English). A
database on a laptop is for evaluation and solo use. The rest of the team works only through git.

### 5.8 Opaque front matter (owner, 2026-11-13; agy and Claude agreed)

Core gains a field kind for opaque values (name left to the plan, e.g. `json`): any JSON value, never localized,
never sent to the model, hashed with the canonical JSON hash, U+0000 refused like every other value. No migration
change. The Starlight preset declares Starlight's union-typed keys (`editUrl`, `lastUpdated`, `prev`, `next`,
`tableOfContents`, `head`, `hero.image`, `sidebar.badge`) with it, and Starlight-mode import stores every front-matter
key the preset does not declare (the adopter's `docsSchema({ extend })` keys) verbatim in one shared opaque field,
which export writes back as top-level keys of every file. Text the reader sees inside a mixed object (`hero.title`,
`hero.tagline`, hero action labels, `sidebar.label`, `banner.content`) stays a localized text field, so it is
translated. Measured scope: the kind is switched on in about 13 source files (10 `case "object"` sites), a mechanical
change; agy's "about 25 lines" estimate is unverified. If the plan finds it larger than a TODO-class fix, the
escalation rule of section 3 applies.

## 6. The package `@mogging/starlight`

- A preset for `mogging.config.ts`: a docs collection declaring the Starlight front-matter keys of section 3 with
  their localization, a body field, and the folder and locale mapping of 5.2. It must accept the adopter's own extra
  front-matter keys (Starlight `docsSchema({ extend })`) as additional fields.
- `mogging init --starlight`: reads the adopter's Astro config for the Starlight `locales`, `defaultLocale` and docs
  path, and writes `mogging.config.ts` with the preset. Like `init` today, it never overwrites an existing config
  (`packages/cli/src/commands/init.ts:39-53`).
- A default export that is a no-op Astro integration, so `npx astro add @mogging/starlight` leaves a working Astro
  config. It must not read the database, the network or the licence, and must print nothing during a build.
- The import and export path mapping, the manifest, the complete-page rule and pruning live in `@mogging/markdown`
  as options of `importFolder` and `exportFolder`, so the CLI and the SDK share one implementation; the Starlight
  package supplies the configuration. The CLI gains the layout selection, `--prune`, the rename confirmation flag and
  `mogging rename`.
- Its README states the licence terms and the zero-price noncommercial key before the install command (roadmap
  section 5).

## 7. The starter template

`templates/starlight/` in this repository: a Starlight site with a few English pages and one translated locale, the
preset already configured, a `compose.yaml` that runs a local Postgres, an `.env.example` for a hosted Postgres, and
a README that puts the licence first and then walks the success flow of section 1. This repository's CI runs the
template's acceptance flow (import, a mocked compile, approve, export, `astro build`) against the packages at HEAD,
which is the freeze trigger of ship-sequencing step 3.

## 8. Slug uniqueness (owner, 2026-11-13: option b; agy and Claude agreed)

Verified: migration 0001 has no uniqueness rule for (collection, slug) among live documents, and no core code checks
it (no slug check in `packages/core/src/documents/`); import avoids duplicates only by looking the slug up first.
`mogging rename` and the import safety stop make a collision easier to reach.

Decided: core refuses, with a `ValidationError`, to save or publish a shared slug that another live (not soft-deleted)
document of the same collection already has as its published or draft slug, under a per-collection lock (for example
a transaction-scoped advisory lock) so two concurrent writers cannot both pass the check. No migration change.
Rejected: (a) a database rule (needs a denormalized column or trigger in 0001); (c) a CLI-only check (bypassable
through the SDK).

## 9. Left to the builder

The exact option names on `importFolder`/`exportFolder`/`saveDraft`/`enqueueStale` and of the opaque kind; the
manifest's JSON field names; how the preset splits Starlight objects with mixed localization within the rule of 5.8
(for example `sidebar.order` shared and `sidebar.label` localized: separate top-level fields mapped to one YAML
object, or a core change if the field model needs it, which then falls under the escalation rule); how
`init --starlight` reads an `astro.config.mjs` it cannot import safely (a static read, or asking); the template's page
content; how the template's dependencies sit relative to the pnpm workspace; the CI job layout.

## 10. Review ledger

- Builder check (Sonnet, 2026-11-13), 8 questions. Answered in the doc as Claude's calls: shared front matter in
  locale files (5.4), source files never written (5.4), day-one byte-for-byte adoption (5.4), required-field
  completeness and no deletion on English change (5.4, 5.5), rename pairing and `git mv` (5.6), untracked to AI via
  `compile --include-untracked` (5.3), source always published, locale edits with `--publish` (5.3). Owner's: union
  front matter (5.8), topology (5.7), slug uniqueness (8), each after an agy-first round 3 consult
  (`.clavity/seams/starlight-builder-first.md`, [VERDICT: ALIGNED]).
- agy round 3 corrections folded: day-one locale files are published on import (5.3); the manifest holds no database
  ids (5.4).
