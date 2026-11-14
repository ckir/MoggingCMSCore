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
Starlight site has one docs collection. In the second mode English and the locales sit at the same depth, so the
rebasing of 5.9 is a no-op. A locale file uses the same extension (`.md` or `.mdx`) as its source file.
Files whose name starts with `_` are skipped on import and never written, as Starlight's glob skips them
(`src/loaders.ts:57`: the `[^_]*` part of `**/[^_]*.{...}` constrains the file name only, so a folder starting with
`_` is NOT skipped and its pages are imported like any other). An `index.md` at any depth keeps `index` as the last slug segment (`index`, `guides/index`),
as import does today; Astro and Starlight strip or normalize `index` in the page id they build
(`src/utils/routing/index.ts:18-22`), which Mogging never needs.
The layout is a setting in
`mogging.config.ts` (written by the preset), so a plain `mogging import` and `mogging export` with no directory
argument use `<docsDir>`; an import that finds no source file exits non-zero instead of reporting success. Only `.md` and `.mdx`
files are imported; other extensions Starlight's loader accepts are listed in one warning per run.

Slugs (panel round 2). Mogging slugs must be lowercase (`packages/markdown/src/import.ts:171`), but an adopter's file
may be named `Getting-Started.md`. Starlight mode derives a document's slug from the file path the same way Starlight
derives the page id, and keeps the real file name for writing the locale files; the plan verifies Astro's id
derivation from source before relying on it, and a path whose derived slug collides with another is a per-file error.
A page whose front matter sets Starlight's `slug` override (`docs/src/content/docs/reference/frontmatter.md:32-36`)
is a per-file error in v0.1 naming the limit, because copying it into locale files would collide with the English
route. When an English file is renamed only by letter case, export moves the locale file in one rename (a
case-insensitive file system would otherwise delete the file it just wrote).
A day-one locale file is matched to its English page by derived slug, not by exact name, so `de/getting-started.md`
next to English `Getting-Started.md` is the same page; export then writes the locale file under the English name and
removes the old-named one only when it classifies as `published` (its content is in the database), otherwise it
leaves both and reports them.

Where the layout lives. `defineConfig` has no slot for it (`packages/core/src/schema/config.ts:14-19`), so, as with
`defineAiConfig` (plan 3 F1; `packages/cli/src/project.ts:92` reads the `ai` export), the Starlight layout is a
separate named export of `mogging.config.ts` that the CLI reads next to `config`. Core's `MoggingConfig` is
unchanged. Unlike `ai` today (cast unvalidated, `packages/cli/src/project.ts:92`), the layout export is validated when
the project loads: a malformed one is a configuration error (exit `2`, usage), never a silent fallback to the generic
layout; a project with no layout export uses the generic layout, as today.

Locale lists in two configs. Starlight's `locales` live in `astro.config`, Mogging's in `mogging.config.ts`.
`init --starlight` writes both from one answer. Afterwards, import and export compare the layout's locale map with a
static read of `astro.config` and warn on any mismatch (best effort: a config they cannot read statically is
reported once, not guessed). Export writes no file for a Mogging locale that the static read shows missing from
Starlight's `locales`, and exits `4`; when the read failed it writes as configured. `init --starlight` reads `astro.config` statically, never by importing it, and asks for
the values on the command line when it cannot.

Locale identity: folders use Starlight's locale keys (`zh-cn`, or no folder for `root`); the database keeps canonical
BCP 47 tags as `normalizeLocale` produces them (`packages/core/src/schema/locale.ts:4`). By default a locale's folder
is its tag in lowercase (`zh-CN` -> `zh-cn`, Starlight's convention); the layout export lists exceptions, and
`init --starlight` always writes the explicit map read from Starlight's `locales` (so a site whose folder `zh-cn`
holds `lang: zh-Hans-CN` is mapped as configured, not by the default). Adding a locale later means adding it to
`mogging.config.ts` and to Starlight's `locales`, plus a map entry when its folder is not the lowercase tag
(documented). The layout is validated at load: every Mogging target locale maps to exactly one folder and no two
locales share one; a violation is a configuration error (exit `2`).

### 5.3 Day one: existing translations

Translated pages already in the adopter's repository are imported as published human translations WITHOUT a source
hash, so every field reads `untracked`, not `current`. Except for a locale file marked `draft: true` while its
English page is not (5.9), they are PUBLISHED on import whether or not `--publish` is
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
values and warns (today's `contentFile.ts:105` warning) only when they differ, because export writes them (5.4).

A NEW source page (no document yet) whose front matter has `draft: true` is reported as skipped and not imported, so
an unfinished page is never published into Mogging or queued for AI; it is imported once the flag is removed. An
EXISTING page that becomes `draft: true` is imported normally: `draft` is shared front matter, so export copies it
into the locale files and Starlight hides the translations together with the English page (panel round 2). "Source
file gone", for the safety stop and `--prune`, is computed from the files this run finds on disk: a draft page is
not gone, a page renamed to a `_` name is. A document is gone only when neither its published slug nor its draft
slug has a source file (an interrupted rename leaves the two different). A skipped new `draft: true` file still
counts as a "source file with no document" for the safety stop, so renaming a page and marking it draft in one change
stops instead of letting `--prune` delete its translations.
A locale file whose source page has no live document (for example after a prune) is a warning, not a per-file error.

Pre-existing content is the team's: the promise that no AI text reaches the site without a recorded human approval
covers text Mogging generates. Day-one files are recorded as human and visibly `untracked`, whatever their origin.

### 5.4 Export, the manifest and hand edits

- Starlight-mode export never writes, moves or deletes a source-locale (English) file.
- Export writes a locale file only when the locale's published head has every REQUIRED localized field that the
  source page's published head has (Starlight's `title`, and the body when the English page has one: a splash page
  with an empty body, which import treats as absent at `contentFile.ts:128`, needs no body), plus every per-locale
  key the preset marks "required when English has it", which for v0.1 is `hero` (a splash page without its hero
  would render empty; panel round 6); missing optional localized fields are left out of the file (Claude's call). A page without them gets no file, and Starlight serves
  the English page with its fallback notice. No English text Mogging stores as a localized field is ever written into
  a locale file.
- Non-text front matter is owned per key (owner, 2026-11-13, agy and Claude agreed; section 5.9). "Follows English"
  keys are copied from the source page into every locale file on every export, because Starlight reads them per
  locale entry (`src/utils/navigation.ts:300`, `src/utils/routing/data.ts:54,65`); "per locale" keys are written
  from the locale's own value.
- Export writes `.mogging/manifest.json` at the repository root: for every file it wrote or adopted, the path, the
  slug, the locale, the version exported (informational only, never compared) and the SHA-256 of the bytes on disk.
  It holds no database ids (agy round 3), so a fresh database or another clone reads it the same way. Entries are
  sorted by path, one per line, so a diff is readable. The manifest is replaced atomically (temporary file, then
  rename) after the files.
- Classifying a locale file (panel round 2, refined in round 3). Import and export classify every existing locale
  file the same way, by the canonical hash of its LOCALIZED fields as the layout parses them (shared keys copied from
  English are ignored, so no history of the shared record is needed; formatting, CRLF or a BOM never matter). The
  classes are tested in this order and the first match wins:
  1. **published**: equal to the CURRENT published head of that (document, locale);
  2. **pending**: equal to the current draft head (a hand edit already imported, not yet published);
  3. **behind**: equal to an EARLIER published version of that (document, locale), i.e. a file Mogging exported
     before a newer translation was published;
  4. **hand work**: anything else.
  The earlier-version test needs a core read of a (document, locale)'s published versions (core addition, name left
  to the plan; no migration change: 0001 stores no content hash, `0001_engine.sql:36-56`, so hashes are computed from
  `data` in the client). It runs only for a file that matched neither 1 nor 2, so its cost is bounded by the number
  of divergent files.
- Import: `published`, `pending` and `behind` files are unchanged, never re-imported as edits, so an old exported
  file can never revert a newer translation; import reports each `behind` file. Restoring an older translation on
  purpose (a git revert of a locale file) is done with `import --restore <file>`, which saves that file as a human
  draft (Claude's call, panel round 3). `hand work` is saved as a human draft (published only with `--publish`, or on
  day one per 5.3). A pending `DRAFT_AI` or `APPROVED` draft that a hand edit replaces is reported as a warning
  (today's import behaviour, kept).
- Export: a `published` file is left byte for byte when what export would write has the same parsed content
  (day-one hand translations keep their formatting) and is rewritten when it would differ, for example after the
  English shared front matter changed; a rewrite keeps every localized value, so no hand-written TEXT changes. A
  `behind` file is rewritten with the current published head and reported; a `pending` or `hand work` file is left
  untouched, named, and reported (run import, then review or publish). Export self-checks every file it writes: the
  file must re-parse to the published content, otherwise export stops with an internal error, so a serializer
  defect can never turn published AI text into `hand work` that a later import would record as human. One
  comparison rule serves the self-check and all four classes, for every version compared (the head, the draft head,
  earlier published versions) and whatever English's current state (panel rounds 8 and 9): a per-locale value that a
  follows-English rule can suppress (today only the `prev`/`next` label, suppressed while English sets `false`, 5.9)
  is ignored when the FILE side lacks it. So a file written while English had `prev: false` is `published` (or
  `behind`), never `hand work`, both while the link is off and after English turns it back on; the next export then
  writes the stored label again, and import never records the label-less file as an edit. The cost, documented: a
  translator deleting a German `prev` label by hand is not detected as an edit. Locale-only
  front-matter keys that the preset does not map are warned about on import and dropped when a file is rewritten.
- The manifest lists only files whose content is in the database: files export wrote and files classified
  `published`. `pending` and `hand work` files are never listed, so 5.5 can never remove them.
- File paths. The database stores slugs, not file names. Export derives a locale file's path from the English file
  as it is on disk now (its real name and extension, found by the slug derivation of 5.2), never from the slug alone,
  so `Getting-Started.md` gets `de/Getting-Started.md`. When the English file's extension changes (`.md` to `.mdx`), a
  locale file under the other extension is the same file: export replaces it when it is listed in the manifest and
  classifies as ours, and otherwise leaves it and reports both.
- Export skips, with a warning, every locale file of a LIVE document whose English source file is missing at the
  document's slug path (a deleted document follows 5.5 instead) (a `git mv` before `mogging rename`, or a deletion not yet pruned), so it never recreates old
  paths. A manifest-listed locale file deleted by hand is recreated with a warning: the database is the record of
  approved translations, and `mogging unpublish --locale` is how a translation is withdrawn (Claude's call).
- Files are written one by one through a temporary file and a rename, never through a symbolic link (export checks
  with `lstat` and refuses), so a crash leaves whole files only; a file written before a crash classifies as
  `published` on the next run.
- Manifest paths are never trusted for a write or delete: export recomputes each path from the English file, locale
  and layout, checks it stays inside `<docsDir>`, and ignores (with a warning) a manifest entry whose path does not
  match. The manifest lives at `.mogging/manifest.json` next to `mogging.config.ts`, and its paths are relative to
  that directory, so a docs site in a subdirectory, or two sites in one repository, each have their own.
- Exit codes (panel rounds 3 to 6), on the CLI's existing scheme. Exit `4` (partial) only for something the
  operator must act on: export left any `pending` or `hand work` file, refused to write through a symbolic link,
  skipped a live document whose English file is missing, skipped a locale missing from Starlight's config, or skipped
  a page whose stored MDX block does not parse (5.9); an import safety stop when other files were imported. Exit `1`:
  an import safety stop when nothing else was imported; an import that found no source file; a `rename` that stopped
  on a differing target; the export self-check failing (an internal error). Exit `0`, with the event in the output:
  rewriting a `behind` file, a page not written because its translation is incomplete (Starlight's fallback is the
  intended outcome), a `pending` locale file that says `draft: true` while its English page does not (5.9), skipped
  new `draft: true` files, orphan locale files, unsupported extensions, an ignored manifest
  entry, a manifest entry for a document the database does not know, locale drift reported without skipping,
  `--restore` on a file that is already current.
  `--dry-run` prints one line per planned action (`write`, `keep`, `remove`, `skip`, `refuse`, `move`) with the path,
  `--json` carries the same list, and it exits as the real run would, except that a conflict only the real run's lock
  can see (a concurrent rename) is not predicted; a day-one `import --dry-run` simulates the creating pass in memory.
  `--json` keeps the CLI contract (`ok` is true for exit `0` and `4`, `packages/cli/src/output.ts:86-87`).
- An exported page that later goes stale keeps its last approved file until a new translation is approved and
  exported; Starlight serves that older translation in the meantime.

### 5.5 Deletions

- `import --prune` soft-deletes every document of the docs collection whose source-locale file is gone (core
  `deleteDocument`). Core has no undelete, so a prune is final for that page's translations. Guards (panel round 1):
  prune refuses when the run found no source file at all (a wrong directory or an empty checkout), and every command
  that writes, moves or deletes (`import`, `import --prune`, `export`, `rename`) takes `--dry-run`, which prints
  exactly what it would do and changes nothing.
- Export removes a locale file only when the manifest lists it, its bytes still match the manifest, and its document
  is deleted or its locale is unpublished. A manifest entry whose document the database does not know at all (a
  fresh or restored database, a wrong `DATABASE_URL`) is never a reason to remove anything; export reports it. A file never becomes removable only because English changed. A file the
  manifest does not list is never removed.

### 5.6 Renames

- `mogging rename <old-slug> <new-slug>` keeps the document and every locale's history. It validates `<new-slug>`
  with the same slug derivation import uses (5.2), not only `isSafeSlug` (`packages/markdown/src/slug.ts:2-4`, which
  checks neither case nor a leading `_`), and checks the path stays inside `<docsDir>`. `--dry-run` checks
  uniqueness with a plain read; the real run checks again under the lock (section 8). It saves and publishes the WHOLE shared head with only the slug changed (a shared save stores the data
  it is given, `packages/core/src/documents/saveDraft.ts:51`), so no other shared field is lost; core refuses a
  duplicate (section 8). Then it moves the source file unless it is already at the new path (a `git mv` done first is
  fine), moves the locale files that exist on disk under the old path, and updates the manifest. Database first, files
  second; every step is idempotent, so re-running an interrupted rename completes it: the re-run finds the document
  by `<old-slug>`, or, when the database step already ran, by `<new-slug>`, and continues with the file steps. A
  move whose target already exists proceeds only when the target has the same parsed content as the file being
  moved; otherwise rename stops and names both files.
- After a rename, the command searches `astro.config.*` and the Markdown files under `<docsDir>` for the old slug as
  text and lists every hit, because Starlight fails the build when a sidebar entry names a slug that no longer exists
  (`src/utils/navigation.ts:157-160`); it does not edit them. It also reminds the operator that old URLs need a
  redirect.
- Import safety stop: when one import run finds, in the docs collection, both documents whose source file is gone and
  source files with no document, it creates none of the new documents and prunes none of the gone ones, with or
  without `--prune`, and exits non-zero (panel round 1: without this, a plain import would create the new slug and a
  later `rename` would then be refused as a duplicate). Everything else in the run is imported normally. When the
  pairing is unambiguous (exactly one gone and one new in the run) it prints the `mogging rename` command, with the
  English title of both sides so the operator can see a stale unpruned document is not the page they renamed;
  otherwise
  it lists both sides without guessing a pairing (a wrong guess would move translations onto the wrong page). An
  explicit confirmation flag treats them as deletions plus new pages: it creates the new documents, and it
  soft-deletes the gone ones only when `--prune` is also given (without `--prune` they stay live, and export skips
  their locale files because their source is missing, 5.4). An unrelated deletion plus addition in one run also
  stops and needs the flag; that is the accepted cost of not guessing.
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
change. The Starlight preset declares the union-typed keys that follow English (`editUrl`, `lastUpdated`,
`tableOfContents`, `head`) with it, and Starlight-mode import stores every front-matter key the preset does not
declare (the adopter's `docsSchema({ extend })` keys) verbatim in one shared opaque field, which export writes back as
top-level keys of every file. Keys that carry reader text (`hero`, `prev`, `next`, `sidebar.label`, `sidebar.badge`,
`banner`) are per-locale localized fields as specified in 5.9; a union shape is split into a follows-English part
and a per-locale part there (for example `prev: false` is a shared boolean, `prev: "Back"` a per-locale
`{ label }`), so the opaque kind is never localized, as ruled. No key is declared both ways; except for the "union"
map entry of 5.9, a path declared twice
in the preset is a configuration error. Measured scope: the kind is switched on in about 13 source files (10 `case "object"` sites), a mechanical
change; agy's "about 25 lines" estimate is unverified. If the plan finds it larger than a TODO-class fix, the
escalation rule of section 3 applies.

Mixed objects (panel round 1). Core's localization is per top-level field (a localized field cannot be saved under
`shared`, `saveDraft.ts:43-47`), so one `sidebar` object cannot be half shared and half localized. Starlight mode
therefore maps each front-matter PATH to its own top-level field: the preset declares, for example, `sidebarOrder`
(shared, path `sidebar.order`) and `sidebarLabel` (localized, path `sidebar.label`); import splits the YAML object
into those fields and export reassembles it. This is a `@mogging/markdown` layout feature, not a core change. The
passthrough field holds only keys and paths the preset does not map; on export a mapped field wins over a passthrough
key of the same path, with a warning. The adopter's extended keys are copied verbatim into every locale file; an
extended key that carries reader-visible text must be declared in `mogging.config.ts` as a localized field to be
translated (documented). The path map lives in the layout export, not in core's field options. Opaque values keep
their YAML form through a round trip, including null inside an opaque value. Dates: the parser uses the YAML `core`
schema (`packages/markdown/src/contentFile.ts:34`), which yields no timestamps, so `lastUpdated: 2024-01-01` arrives
as a string; Starlight's `lastUpdated` needs a date (`src/schema.ts:52`) and gets one only if the scalar is written
back unquoted. The plan therefore pins that a date-like plain scalar is written back plain (and a quoted one quoted),
with a round-trip test through Astro's own front-matter parser. No tagged form.

### 5.9 Front-matter ownership per key (owner, 2026-11-13; agy and Claude agreed; replaces the round-3 list alignment)

Seat consult `.clavity/seams/starlight-ownership-first.md`, [VERDICT: ALIGNED], both chose option C.
- **Follows English** (shared fields or shared opaque values, copied into every locale file on every export):
  `template`, `sidebar.order`, `sidebar.hidden`, `sidebar.attrs`, `pagefind`, `tableOfContents`, `lastUpdated`,
  `editUrl`, `head` (its tag text is not translated, a documented limit), the boolean forms of `prev`/`next`, and the
  adopter's extended keys unless declared otherwise. On day one and on every later import, when a locale file's value
  for a follows-English key differs from English, import reports it ("will be replaced by the English value on
  export"; for `draft: true` on a published translation, "run `mogging unpublish --locale` to withdraw it"), so the
  overwrite is never silent.
- **`draft`** (panel round 6, replacing the round-5 OR rule, which broke the export self-check and classification):
  `draft` follows English like the keys above. A translation that is not ready is expressed the Mogging way, as an
  unpublished draft. Rule, applied on import after classification and only when the locale file says `draft: true`
  while the English page does not (a file that merely carries English's own `draft: true`, copied by export, is not
  a locale draft): the file's content is saved, if it differs from the heads, as an UNPUBLISHED human draft, even on
  day one and even with `--publish`, and import reports it; `--publish` never publishes a pending draft whose file
  says `draft: true`. Its file stays on disk as `pending` (5.4), export leaves it untouched (exit `0` for this case,
  5.4), and Starlight keeps hiding it. When the translator removes the flag, the file is still `pending` (the flag is
  not a localized field), and the next `import --publish` publishes the pending draft, as import already does for a
  human draft equal to its file (`packages/markdown/src/import.ts:373-379`) (panel round 7 correction). The reverse,
  adding `draft: true` to an already published locale file, withdraws nothing by itself: the translator runs
  `mogging unpublish --locale` (documented).
- **Per locale** (one LOCALIZED object or list field per key, holding the whole value): `hero` (title, tagline,
  image, actions), the label/link forms of `prev` and `next`, `sidebar.label`, `sidebar.badge`, `banner`. A
  locale's value comes from its file (day one, hand edits) or from an AI draft; a day-one German
  `hero.actions[].link: /de/start` or `hero-de.png` is kept. A per-locale key the locale has no value for is
  omitted from its file only when the key is optional for Starlight; the completeness rule of 5.4 decides whether
  the page is written at all. For an AI draft, the non-translatable leaves come from English (below). A per-locale
  value belongs to its locale even when the English page has no such key (`orphaned` in sync state,
  `packages/core/src/sync/state.ts:68`, never queued for AI): export writes it, so a German-only `banner` survives,
  and `status` lists it as orphaned for the reviewer to keep or remove (panel round 6, replacing the round-5
  omission, which dropped hand-written text and failed the self-check).
- `hero.actions[].attrs` (an arbitrary record, `src/schemas/hero.ts:65`) cannot be a leaf of a per-locale value,
  because opaque values are never localized; in v0.1 it is kept on the English page only and dropped from locale
  files with a warning (documented limit).
- Union keys `prev` and `next` map ONE YAML path to TWO core fields, which keeps core's rule that a field is either
  shared or localized: `prevToggle` (shared, follows English, from a boolean: `false` removes the link, `true` means
  "use the generated link", the same as absent, `src/utils/navigation.ts:558-560`) and `prev` (localized object
  `{ label, link }`, from a string or an object). The layout's path map has a "union" entry kind naming both fields;
  the "a path declared twice is a configuration error" rule (5.8) applies to plain entries, and a path that appears
  in a union entry and in any other entry is still an error. On export, English wins when it disables the link:
  `false` when the shared toggle is `false`; otherwise the per-locale value when the locale has one; otherwise the
  key is omitted (panel round 7: an orphaned German `prev` no longer overrides an English `prev: false`).
- `sidebar.badge` is not a union with a boolean: Starlight accepts a string or `{ text, variant, class }`, never a
  boolean (`src/schemas/badge.ts:36-45`). It is one per-locale object field, a string normalized to `{ text }`.
- **What the AI touches.** Core gains a field option that marks a text leaf as not translatable (name left to the
  plan, e.g. `translate: false`; `packages/core/src/schema/fields.ts:1-6`); the AI package leaves such leaves out of
  the request schema and copies them from the English value into the draft (`packages/ai/src/fields.ts`:
  `isTranslatable`, the output schema, and the `walk` validator that already rejects a changed non-text value). The
  preset marks links, icons, variants and image files as not translatable, and labels, titles, taglines, badge text,
  banner content and image `alt` as translatable. No migration change. Consequences, documented: an AI redraft of a
  per-locale key takes its links from English again, and the reviewer sees that in the side-by-side review and can
  edit it before approving; a field's source hash covers its whole value (`saveDraft.ts:90-107`), so an English
  change to a link alone makes the per-locale field stale and a recompile pays for a redraft whose text may be
  unchanged (cents; accepted for v0.1).
- **Union shapes** are normalized per key by the preset's table: `prev: "Back"` is `{ label: "Back" }`, `prev: false`
  stays `false` (Starlight's `src/schemas/prevNextLink.ts:6-12`), `badge: "New"` is `{ text: "New" }`. Export writes
  the shortest form that carries the value, and the classification of 5.4 compares normalized values, so the form
  never makes a file look edited.
- **Relative file references are rebased**, never page links. A locale file sits one folder deeper than its English
  file (root-locale layout), so every relative reference to a FILE is adjusted by the depth difference when written
  and reversed when read: front-matter `image()` fields (`hero.image.file`, `.dark`, `.light`; Starlight's example
  uses `../../assets/houston.webp`, `examples/basics/src/content/docs/index.mdx:8`), MDX `import` specifiers, and
  Markdown image sources outside code. Measured in Starlight's own translated docs: the English
  `docs/src/content/docs/environmental-impact.mdx:92` imports `'../../components/...'` and `zh-cn/...:92` imports
  `'../../../components/...'`. Links between pages (`[x](../guide/)`) resolve inside the locale and are left alone.
  The database stores references as they are relative to the English file; rebasing is part of the layout, so
  classification compares the un-rebased values. In the layout where English has its own folder the depth
  difference is zero and nothing changes (5.2).
- **The rebasing rule, exactly** (panel rounds 5 and 6). Two reference grammars:
  - an MDX `import`/`export ... from` specifier is relative only when it starts with `./` or `../` (ESM semantics);
    a bare specifier such as `react` or `astro-embed` is a package name and is never touched;
  - a front-matter `image()` value, or an inline Markdown image source (`![alt](src)`) outside code, is relative
    when it is non-empty and does not start with `/`, `#`, `~`, `@`, or a URL scheme (`[A-Za-z][A-Za-z0-9+.-]*:`).
    Image reference definitions (`[id]: src`) are stored as opaque blocks that cannot be told apart from link
    definitions, so they are not rebased (documented limit: use inline images or root-relative paths).
  The path part (before any `?` or `#`, kept unchanged) is resolved against the directory of the file it was read from
  and re-expressed relative to the directory of the file it is written to, with POSIX separators, in CANONICAL form:
  no `.` or `..` segments after the leading run of `..`, and always prefixed by `./` when it does not start with
  `../` (panel round 7: keeping `./` only "when the original had one" lost it on the way back, and an ESM specifier
  without `./` is a package name). The database stores the canonical form relative to the English file, so
  `reverse(forward(v)) == v` holds for every stored value, and classification compares canonical values; a bare
  image source such as `img.png` is stored as `./img.png` (the English file is never rewritten, 5.4). The plan pins
  this with property tests AND fixture assertions on the exact rewritten strings in both directions (a rebase that
  does nothing must fail a test). MDX ESM blocks are rewritten from an ESM syntax tree, never a regular expression,
  and only the specifier's characters are replaced, so the rest of the block is byte-identical. The stored tree keeps
  only the block's source text (`packages/markdown/src/parse.ts:156-157`), so the layout re-parses that block with
  the same ESM grammar the MDX parser uses (panel round 8). A block stored by import was parsed successfully, but core
  does not check rich-text content (`packages/core/src/values/normalize.ts:44-49`), so a value saved through the SDK
  may hold a block that does not parse (panel round 9). Such a page's locale file is skipped with a per-file error
  naming the block, the rest of the export runs, and the run exits `4` (5.4); it never stops the whole export.
- `mogging rename` to a different folder depth is refused when the page or any of its translations contains a
  relative file reference (the stored references would need rebasing; documented limit, move it by hand); renames
  within the same depth are unaffected.

Untrusted YAML. The passthrough and path-split code builds plain objects from repository content: it uses
null-prototype objects or own-key checks throughout (today's guard is `Object.hasOwn`, `contentFile.ts:113`) and
rejects the keys `__proto__`, `constructor` and `prototype` as a per-file error. YAML anchors, aliases and merge keys
are resolved by the parser before mapping; custom tags are a per-file error.

## 6. The package `@mogging/starlight`

- A preset for `mogging.config.ts`: a docs collection declaring the Starlight front-matter keys of section 3 with
  their localization, a body field, and the folder and locale mapping of 5.2. It must accept the adopter's own extra
  front-matter keys (Starlight `docsSchema({ extend })`) as additional fields.
- `mogging init --starlight`: reads the adopter's Astro config for the Starlight `locales`, `defaultLocale` and docs
  path, and writes `mogging.config.ts` with the preset. Like `init` today, it never overwrites an existing config
  (`packages/cli/src/commands/init.ts:39-53`), and it says so instead of silently ignoring `--starlight`. A
  single-language site has no `locales` to read: `init --starlight` then needs the target locales on the command line
  and prints the matching Starlight `locales` block to paste into `astro.config`. Adding a language later means
  changing both configs (documented); import already skips, with a warning, a locale folder not declared in
  `mogging.config.ts` (`packages/markdown/src/import.ts:144`).
- A default export that is a no-op Astro integration, so `npx astro add @mogging/starlight` leaves a working Astro
  config. It must not read the database, the network or the licence, and must print nothing during a build. Because
  `astro.config` then imports the package, its root entry point must import nothing from `@mogging/core` or the
  database driver; the preset lives in a separate subpath export used only by `mogging.config.ts`. The README says to
  install the package where the site's CI installs dependencies.
- The import and export path mapping, the manifest, the complete-page rule and pruning live in `@mogging/markdown`
  as options of `importFolder` and `exportFolder`, so the CLI and the SDK share one implementation; the Starlight
  package supplies the configuration. The CLI gains the layout selection, `--prune`, the rename confirmation flag and
  `mogging rename`.
- Its README states the licence terms and the zero-price noncommercial key before the install command (roadmap
  section 5), then the whole first session in order: install `@mogging/cli` and `@mogging/starlight` as dev
  dependencies (the CLI is a separate package; the Starlight package does not bundle it), provide Postgres
  (`compose.yaml` from the template, or a hosted URL in `DATABASE_URL`), `mogging init --starlight`, `mogging migrate`,
  add the `ai` export with a provider key and a monthly cap (`defineAiConfig`), `mogging import`, `mogging compile`,
  `mogging review`, `mogging publish`, `mogging export`, then commit. The 30-day evaluation needs no key (design
  12.3); after it, the guarded writers (12.3: saving drafts, so import too, compile, approve, publish) refuse without
  a key while export and the built site keep working; the README says so and links where the key goes.
- Supported versions: the package declares the Starlight and Astro ranges its CI fixtures test (a peer dependency
  range starting at 0.43.0, the version this design was read against) and the README says which; `init --starlight`
  warns when the adopter's installed Starlight is outside it. Starlight is pre-1.0, so each new minor is a deliberate
  range bump after the fixtures pass.
- Performance (panel round 2): export and import read heads per page of documents, not per file, and the version
  hashes for classification in one query per (collection, locale); the plan measures a 2,000-page, 6-locale fixture
  and records the figure; the acceptance bar is that an unchanged re-export of that fixture issues a number of
  database queries independent of the page count (per page of documents, not per file).
  The rename search covers only `astro.config.*` and `<docsDir>`.

## 7. The starter template

`templates/starlight/` in this repository: a Starlight site with a few English pages and no translations yet (so the
first session compiles both target locales, as section 1 describes; the day-one path is covered by the second
fixture below), the preset already configured with two target locales, a `compose.yaml` that runs a local Postgres,
an `.env.example`, and a README that puts the licence first and then walks the success flow of section 1, including
"replace the sample pages with yours" before the first import. The CLI reads the database URL only from flags and the
environment (`packages/cli/src/project.ts:26-31`) and loads no `.env` file, so the template's package scripts load
`.env` themselves (mechanism left to the plan) and the README's commands work after `cp .env.example .env`. This repository's CI runs the
template's acceptance flow (import, a mocked compile, approve, export, `astro build`) against the packages at HEAD,
which is the freeze trigger of ship-sequencing step 3. A second fixture, an "existing adopter" Starlight repository
with hand-made translations, a splash page, a mixed `sidebar` object, an extended front-matter key and one file with
CRLF line endings, a locale page with a relative image, a relative MDX import and a package import, and a German
page with `draft: true`, runs `init --starlight`, the day-one import, a rename and an export, then `astro build`, and
asserts the exact rebased strings, that the package import is untouched, that the draft page stays hidden, and that
no hand-written
text is changed (formatting and copied shared keys may be, 5.4). `npx astro add` needs the network and is checked by hand before release, not in CI.

### 7.1 Known limits of v0.1 (documented in the package README)

- Root-relative links inside a translated page's body (`/guides/x/`) point where the English points; Starlight does
  not localize links itself. Relative page links stay inside the locale. Hero action and prev/next links are per
  locale (5.9), but an AI draft takes them from English until a reviewer edits them.
- A built page does not show whether its text was AI-drafted, human-written or untracked, and a stale translation is
  served without a notice until a new one is exported; `mogging status` is the place to see both.
- Prune is final for a page's translations (no undelete in core).
- `head` tag text is not translated (a shared opaque value, 5.8).
- A git revert of a locale file to an older translation is undone by the next export unless it is imported with
  `import --restore` (5.4).

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
- Panel round 1 (2026-11-13; Sonnet solo seats Axiom Breaker, Cascade Analyst, Literal Implementer, Protocol Pedant,
  Mechanism Gamer, Blindspot Auditor, Activation Auditor: 29 findings; agy seats Axiom Breaker, Cascade Analyst, State
  Corruptor, Boundary Smuggler, Dependency Cynic: 7 findings; seats dropped: Resource Vampire, no unbounded loop or
  external call in this design). Dispositions:
  - FOLDED, export overwrite rule and manifest (AX1, AX2, CA2, CA3, PP3, F-02, F-04): bytes-or-content rule, version
    informational, atomic writes (5.4).
  - FOLDED, completeness (CA5): required fields the English page has; splash pages export (5.4).
  - FOLDED, reader text in opaque keys (F-06, AX4): `prev`/`next`/`sidebar.badge` source-only; extended keys copied,
    declare to translate (5.4, 5.8).
  - FOLDED, mixed objects (F-01): path-mapped top-level fields in the layout (5.8).
  - FOLDED, prune and footguns (CA1, BA2): no-source-file guard, `--dry-run` everywhere (5.5).
  - FOLDED, rename (CA4, F-05, BA1, F-03, LI3, MG2): whole shared head, slug validation, idempotent order, search for
    the old slug, safety stop with or without `--prune` (5.6).
  - FOLDED, layout details (LI2, LI5): extension, `_` files, `index`, layout in config, empty import fails (5.2).
  - FOLDED, `draft: true` and orphan locale files (agy answer 2, CA6) (5.3); day-one provenance stance (MG1) (5.3).
  - FOLDED, opaque collisions and YAML types (F-07, PP1) (5.8).
  - FOLDED, init and the integration entry point (AC1, AC2) (6); acceptance fixtures (AC3) (7).
  - FOLDED as documented limits (LI1, BA3, BA4, MG3) (7.1).
  - FOLDED, manifest shape (LI4): root path, sorted one entry per line; cross-PR conflicts are outside the supported
    setup (5.7).
  - FOLDED, exit codes (PP2): see 5.4 and 5.6; the plan maps them onto the CLI's existing codes (0 ok, 1 error,
    2 usage, 3 licence, 4 partial; the exact list is in 5.4).
  - REJECTED (LI6, "a hand file next to a DRAFT_AI is marked current without review"): a human save is recorded as in
    sync by design (spec 6.4, `saveDraft.ts:90-107`), the text is human-written, and import already reports the
    replaced AI draft (`import.ts:365`).
  - FOLDED (AX3, "day-one pages never go stale"): untracked fields are listed by `status`; `mogging track` makes them
    current, after which English edits flag them. The plan checks whether `track` needs a whole-collection form.

- Panel round 2 (2026-11-13, medium floor; agy seats Fold Regression, Protocol Pedant, Mechanism Gamer, Resource
  Vampire: 5 findings; Sonnet solo seats Fold Regression, State Corruptor, Boundary Smuggler, Dependency Cynic and the
  two core seats: 14 findings). Dispositions:
  - FOLDED, file classification replacing rules (a)/(b) (F-10, FR2, FR3, SC3): published / behind / pending / hand
    work, used by both import and export; a core read of published-version hashes (5.4).
  - FOLDED, missing English source and hand-deleted files (SC1) (5.4); rename re-run and existing target (SC2) (5.6);
    confirmation flag meaning (CA1) (5.6).
  - FOLDED, manifest paths and symlinks (BS1) (5.4); prototype keys and YAML features (BS2) (5.8); slug case and
    rename validation (BS3) (5.2, 5.6).
  - FOLDED, layout export instead of a core config slot (DC1) (5.2); supported versions and extensions (DC2) (6, 5.2).
  - FOLDED, `draft: true` for existing pages and "source file gone" (F-08, FR1) (5.3).
  - FOLDED, reader text in structural keys (F-09, FR4, AX1): localized opaque fields (withdrawn in round 3), flagged for owner
    confirmation (5.8, 5.4); timestamps (F-11) (5.8).
  - FOLDED, performance (F-12) (6).

- Panel round 3 (2026-11-13, medium floor; agy seats Fold Regression, Literal Implementer, Activation Auditor,
  Blindspot Auditor: 5 findings; Sonnet solo seats Fold Regression, Mechanism Gamer, Protocol Pedant, Resource
  Vampire and the two core seats: 17 findings). Dispositions:
  - FOLDED, round-2 "localized opaque" fields withdrawn (FR1, FR8, FR9, F-14): reader text in structural keys is
    path-mapped localized text with list alignment and union-shape normalization; opaque stays shared as ruled (5.8).
  - FOLDED, classification precedence and localized-only hashing (FR3, agy answer 2, F-16); revert path
    `import --restore` (F-13); bounded earlier-version read (RV1) (5.4).
  - FOLDED, day-one rewrites keep text (FR2) and the export self-check (MG1) (5.4).
  - FOLDED, deleted vs live documents with missing English (FR4); manifest lists only content in the database (FR5)
    (5.4).
  - FOLDED, file names and extension changes (FR6, FR7) (5.4); dates without a tagged form (PP1) (5.8).
  - FOLDED, layout export validation (PP2) and locale drift (F-17) (5.2); manifest base (PP3) and exit codes (PP4)
    (5.4).
  - FOLDED, "gone" uses published and draft slugs (CA1) and draft files count for the safety stop (MG2) (5.3);
    ghost-document pairing shows titles (F-15) (5.6).
  - Citation corrected: the shared-key warning is at `contentFile.ts:105` (and `:121`), not `:106`.

- Panel round 4 (2026-11-13, medium floor; agy seats Adopter Walkthrough, Test Oracle Auditor, Fold Regression:
  5 findings; Sonnet solo the same three plus the core seats: 9 findings). Root finding (AW1, AW2, F-19): copying
  English values into locale files overwrites day-one locale values and breaks relative file paths. Owner ruled per-key
  ownership after an agy-first consult (5.9). Dispositions:
  - FOLDED, per-key ownership, the not-translatable leaf option, rebasing of file references (AW1, AW2, F-18, F-19,
    F-20, FR1) (5.9); union shapes split so the opaque kind is never localized, and a key declared twice is a
    configuration error (F-21, FR2) (5.8, 5.9).
  - FOLDED, day-one name/case matching (AW3) and `index` at any depth (AW4) (5.2); first-session install order
    (AW5) (6); locale drift skips the missing locale and exits 4 (FR3) (5.2).
  - FOLDED, exit codes and `--dry-run` output (OR1) (5.4); testable performance bar (OR2) (6).
  - FOLDED, rename after `git mv` (F-22): already covered by 5.6 (the source may already be at the new path; locale
    files are found under the old path); no change.
  - Citation corrected: Starlight's `index` handling is at `src/utils/routing/index.ts:18-22`.

- Panel round 5 (2026-11-13, medium floor; agy seats Fold Regression, Greenfield Adopter, State Corruptor:
  5 findings; Sonnet solo Fold Regression, Greenfield Adopter, Protocol Pedant and the core seats: 14 findings).
  Dispositions:
  - FOLDED, exit codes (F-23) and `--dry-run` limits (PP2, first half) (5.4).
  - REJECTED, rebasing in the English-in-its-own-folder layout (F-24): 5.2 already states the depth difference is
    zero there and rebasing is a no-op.
  - REJECTED, `--json` `ok: true` on a partial safety stop (PP2, second half): that is the CLI contract, `ok` is true
    for exit 0 and 4 (`packages/cli/src/output.ts:86-87`, core design 9.2 notes).
  - FOLDED, follows-English day-one report and `draft` per locale (FR1); `head` consistently follows English (AB2);
    union keys declared once with a split rule (FR2, AB1); `attrs` (FR3); orphaned per-locale keys (F-25) (5.9).
  - FOLDED, exact rebasing rule, MDX import rewriting, no fatal self-check (PP1, F-26); depth-changing rename refused
    with relative references (FR4) (5.9).
  - FOLDED, case-only renames (FR5) and the front-matter `slug` override (PP3) (5.2); locale folders derived by
    default and validated (F-27, GA3) (5.2); unknown-document manifest entries (GA3) (5.5).
  - FOLDED, template has no translations, replace-the-samples step, `.env` loading (GA1, GA2) (7); licence after
    the evaluation in the README (solo answer 2) (6).
  - FOLDED as documented, a link-only English change makes a per-locale field stale (CA1) (5.9).
  - FOLDED, `_` folders are not skipped by Starlight's glob, only `_` files (solo answer 3) (5.2).

- Panel round 6, the round cap (2026-11-13, medium floor; agy seats Fold Regression, Literal Implementer, Cascade
  Analyst: 5 findings; Sonnet solo Fold Regression, Literal Implementer, Mechanism Gamer and the core seats:
  5 findings). Three round-5 folds were wrong and are replaced:
  - FOLDED, `draft` follows English; a locale `draft: true` is an unpublished draft (F-28, R6-1) (5.9).
  - FOLDED, orphaned per-locale values are kept, not omitted (R6-2) (5.9).
  - FOLDED, two reference grammars (bare ESM specifiers never touched), normal form, exact-string fixture assertions,
    unreadable MDX block exits 4 (R6-3, R6-4, F-29) (5.9, 7).
  - FOLDED, union keys as one path mapped to two core fields with a "union" map entry (F-31) (5.9); `hero` required
    when English has it (F-32) (5.4); `init --starlight` writes the explicit locale map (F-30) (5.2); remaining exit
    codes (R6-5) (5.4).

- Panel round 7, narrow, owner-ruled after the cap (2026-11-14; scope: the round-6 corrections only; agy seats Fold
  Regression, Literal Implementer: 4 findings; Sonnet solo the same seats: 5 findings; both found the first two
  independently):
  - FOLDED, the locale-draft lifecycle: applied after classification, only when the locale differs from English,
    publish through import's existing pending-draft publish, unpublish to withdraw (F-33, R7-1) (5.9, 5.3, 5.4).
  - FOLDED, canonical reference form always `./` or `../`, so the round trip holds (F-34, R7-2) (5.9).
  - FOLDED, `sidebar.badge` is one per-locale object, not a union (F-35, R7-4); `prev`/`next` toggle covers `true`
    and English `false` wins over an orphaned locale value (R7-4, R7-5) (5.9); union exception stated in 5.8.
  - FOLDED, image reference definitions out of rebasing scope, documented (R7-3); MDX blocks rewritten from the MDX
    parser's own syntax tree, import side of an unreadable block is a per-file error (F-36) (5.9).

- Panel round 8, narrow, owner-ruled (2026-11-14; scope: the round-7 corrections only): agy CLEAN; Sonnet solo
  3 findings, all FOLDED:
  - the self-check and classification compare the head as export projects it, so an English `prev: false` that
    suppresses a locale label is neither a self-check failure nor `hand work` (R8-1) (5.4);
  - MDX blocks are re-parsed from their stored source text, a re-parse failure is an internal error (exit 1), and
    the unreachable "leave unchanged, exit 4" and import-side clauses are withdrawn (R8-2) (5.9, 5.4);
  - the exit-0 `draft` case carries the "while its English page does not" qualifier (R8-3) (5.4).

- Panel round 9, narrow, owner-ruled (2026-11-14; scope: the round-8 corrections only): agy CLEAN; Sonnet solo
  3 findings, all FOLDED:
  - one comparison rule for the self-check and every class and version: a suppressible `prev`/`next` label missing
    from the file is ignored, so re-enabling a link never turns a file into `hand work` (R9-1, R9-2) (5.4);
  - a stored MDX block that does not parse (core does not check rich-text content, `normalize.ts:44-49`) skips that
    page with exit 4 instead of failing the run (R9-3) (5.9, 5.4);
  - import reports a follows-English difference on every import, not only day one, including `draft: true` on a
    published translation (solo answer 2) (5.9).

## Stand-downs

None in rounds 1 to 9: no finding was discarded below the floor.
