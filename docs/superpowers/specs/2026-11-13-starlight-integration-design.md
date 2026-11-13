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
  SDK or package level; the only open schema question is section 8.
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
hash, so every field reads `untracked`, not `current`. `mogging status` lists them; compile never re-translates an
untracked field on its own. The reviewer marks a page current with `mogging track` once they have checked it, or
lets it be replaced by an AI draft through the normal review. This needs one SDK addition: a `saveDraft` option that
records no source hash for the saved target fields (core; exact name left to the plan), used by import on the first
import of a locale file that has no Mogging history.

### 5.4 Export, the manifest and hand edits

- Export writes a locale file only for a COMPLETE page: every localized field present in the source locale's
  published head is present in that locale's published head. An incomplete page gets no file, and Starlight serves
  the English page with its fallback notice. No English text is ever written into a locale file.
- Export writes `.mogging/manifest.json` at the repository root: for every file it wrote, the path, the document
  id, the locale, the version exported and the SHA-256 of the bytes written.
- The locale folders are two-way. A hand edit to a locale file (bytes differ from the manifest) is imported as a
  human draft like any changed file. Export refuses to overwrite a locale file whose bytes differ from the manifest
  and that has not been imported, names the file, and tells the user to run import first. A pending `DRAFT_AI` or
  `APPROVED` draft that a hand edit replaces is reported as a warning (today's import behaviour, kept).
- An exported page that later goes stale keeps its last approved file until a new translation is approved and
  exported; Starlight serves that older translation in the meantime.

### 5.5 Deletions

- `import --prune` soft-deletes every document of the docs collection whose source-locale file is gone (core
  `deleteDocument`).
- Export removes a locale file only when the manifest lists it and its document is deleted or no longer complete in
  that locale. A file the manifest does not list is never removed.

### 5.6 Renames

- `mogging rename <old-slug> <new-slug>` keeps the document and every locale's history: it refuses when another live
  document of the collection already has `<new-slug>` (section 8), saves and publishes the shared slug through the
  existing SDK, moves the source and locale files on disk, and updates the manifest.
- Import safety stop: when one import run finds, in the docs collection, both a document whose source file is gone
  and a source file with no document, it does not create or prune those silently. It lists the pairs, prints the
  `mogging rename` command for each, and needs an explicit confirmation flag to treat them as a deletion plus a new
  page. Without `--prune` the deleted side is only reported.
- No persistent id is written into the team's files (rejected by both reviewers: undeclared front-matter keys are an
  error today, and a copied page would duplicate its id).

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

## 8. Open: slug uniqueness before the 0001 freeze (owner decision)

Verified: migration 0001 has no uniqueness rule for (collection, slug) among live documents, and no core code checks
it (no slug check in `packages/core/src/documents/`); import avoids duplicates only by looking the slug up first.
`mogging rename` and the import safety stop make a collision easier to reach. Options:
- (a) enforce it in the database, edited into 0001 before the freeze (slug lives in `document_shared.data`, the
  collection on `documents`, so this needs a denormalized column or a trigger);
- (b) enforce it in core where a shared slug is saved and published, under a lock;
- (c) check only in `mogging rename` and import (bypassable through the SDK).

## 9. Left to the builder

The exact option names on `importFolder`/`exportFolder`/`saveDraft`; the manifest's JSON field names; how the
preset splits Starlight objects with mixed localization (for example `sidebar.order` shared and `sidebar.label`
localized); how `init --starlight` reads an `astro.config.mjs` it cannot import safely (a static read, or asking);
the template's page content; how the template's dependencies sit relative to the pnpm workspace; the CI job layout.
