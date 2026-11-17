# Starlight Engine (plan 6a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SDK half of the Starlight integration: the core and ai additions it needs, and a Starlight layout
mode of `importFolder`/`exportFolder` (plus `renamePage`) in `@mogging/markdown` that implements design sections 5.2
to 5.9 and 8.

**Architecture:** Core gains an opaque `json` field kind, a `translate: false` leaf option, an untracked save, three
bulk reads and a slug-uniqueness guard under a per-collection advisory lock; ai honours `translate: false` and
gains `includeUntracked`. `@mogging/markdown` gets a `starlight/` module set: a validated layout, a safe front-matter
reader with a path map, relative-reference rebasing, a docs-folder scan, a four-class file classifier, a manifest, a
plan-then-apply import, an export that copies follows-English keys from the English file, and a rename. The generic
`<locale>/<collection>/<slug>.md` mode is unchanged.

**Tech Stack:** TypeScript (ESM, NodeNext), postgres.js v4, vitest 5, `yaml` 2.9.1, unified/remark-mdx (already
deps), new: `github-slugger@2.0.0` (dependency of `@mogging/markdown`), `@astrojs/internal-helpers@0.13.0`
(devDependency, test oracle only).

**Spec:** `docs/superpowers/specs/2026-11-13-starlight-integration-design.md` (APPROVED 2026-11-17). Ship order:
`docs/superpowers/specs/2026-11-13-v01-ship-sequencing-design.md` step 2.

**Scope (owner, 2026-11-17, option C after an agy-first consult):** this is plan 6a of two. Plan 6b (CLI flags and
`mogging rename`, `init --starlight`, the static `astro.config` read and locale-drift check, `@mogging/starlight`
preset and no-op integration, `templates/starlight/`, the existing-adopter fixture with `astro build`, the CI
workflow, `compile --include-untracked`, a whole-collection `track` if needed) is written only after 6a is merged,
against the code 6a leaves. Nothing in 6a touches `packages/cli`.

## Global Constraints

- Node >= 22, pnpm, ESM with `.js` relative imports and `import type` for types (AGENTS.md "Conventions").
- Every test touches Postgres. On the dev machine: `export DATABASE_URL=postgres://mogging:mogging@127.0.0.1:54329/mogging_test`.
  A `password authentication failed` error means a wrong `DATABASE_URL`, not a regression.
- Commands: `pnpm --filter <pkg> test <file-filter>` and `pnpm typecheck`. **Never insert `--`** after `test`.
  Gate per task: the task's tests pass, `pnpm typecheck` is clean, and the whole suite (`pnpm test`) passes with the
  baseline count plus the task's new tests. There is no linter or formatter; do not add one.
- No migration change (spec 3). `packages/core/migrations/0001_engine.sql` is not edited by this plan.
- JSDoc on every exported function and type (summary, params, returns, throws), in the style of the existing files.
- `test/api.test.ts` of core and markdown pins the exact runtime surface; each new export is added there in the same
  commit, and nothing else leaks through `src/index.ts`.
- Entry-guard order on licence-guarded writes: `assertLicensed(ctx)` then `assertActor(ctx)`; never inside a helper a
  loop calls. Lock order: `ai_budgets`, `ai_jobs`, `documents` rows, then (new, Task 5) the collection slug lock.
- Data safety: U+0000 refused at every text boundary; no caller string interpolated into SQL text (bind values;
  field names and locales bind as JSONB or parameters); deletes are soft.
- Commit subjects `type(scope): summary`, ending with the repository's attribution line.
- Escalation rule (spec 3): if a task needs a change larger than a TODO-class fix, or a migration change, STOP and
  report to the controller; the controller brings it to the owner.

## Verified external facts (read from source 2026-11-17; report kept in the session scratchpad)

Tags fetched: `@astrojs/starlight@0.43.0` (01f8863), `astro@7.4.4` (883e672; Starlight's peer range `^7.2.10`,
its lockfile pins 7.4.4), `yaml` v2.9.1, `github-slugger` 2.0.0. These are the oracles Tasks 6, 7, 9 and 10 pin.

- F-ID. Astro derives a docs entry id from its path: each `/`-separated segment of the path without its last
  extension goes through github-slugger `slug()` (lowercase; removes `.`, ASCII punctuation except `-` and `_`,
  symbols and controls; one space becomes `-`; non-ASCII letters and combining marks kept), joined with `/`, then a
  trailing `/index` is removed (astro `packages/astro/src/content/utils.ts:370-378`). A truthy front-matter `slug`
  replaces the id verbatim (`packages/astro/src/content/loaders/glob.ts:60-61`). Worked: `Getting-Started.md` ->
  `getting-started`, `guides/Hello World.md` -> `guides/hello-world`, `a_b/c.d.md` -> `a_b/cd`, `Über/naïve.mdx` ->
  `über/naïve`.
- F-GLOB. Starlight's loader: `glob({ base: <srcDir>/content/docs, pattern: '**/[^_]*.{markdown,mdown,mkdn,mkd,mdwn,md,mdx}' })`,
  no custom `generateId` (starlight `packages/starlight/src/loaders.ts:6,55-59`); `mdoc` is added only when the
  Markdoc integration is installed (`loaders.ts:48-53`), so Mogging lists `.mdoc` with the other unsupported
  extensions unconditionally.
- F-YAML. Astro parses `---` front matter with `parseDocument(source, { customTags: ['timestamp'], merge: true, schema: 'core' })`
  (`@astrojs/internal-helpers@0.13.0` `src/yaml.ts:4-8`, exported as `@astrojs/internal-helpers/frontmatter`
  `parseFrontmatter`); `+++` front matter is TOML; leading blank lines before `---` are allowed
  (`src/frontmatter.ts:17`). An unquoted `2024-01-01` is a `Date`, a quoted one a string.
- F-LOCALE. Starlight takes a page's locale from the first id segment by exact, case-sensitive key lookup
  (`packages/starlight/src/integrations/shared/slugToLocale.ts:15`), so a locale folder must equal its own slugified
  form (lowercase).
- F-SCHEMA. `prev`/`next`: boolean | string | strict `{ link?, label? }` (`schemas/prevNextLink.ts`); `sidebar.badge`:
  string | `{ text, variant, class }` (`schemas/badge.ts:25-34`); `hero.actions[]` has `text, link, variant, icon,
  attrs` (`schemas/hero.ts:43-68`); `hero.image` is `{ alt, file }` | `{ alt, dark, light }` | `{ html }`;
  `lastUpdated: z.union([z.date(), z.boolean()])` (`schema.ts:52`); there is no `slug` key in Starlight's schema.

Measured on main 256726f (yaml 2.9.1): Mogging's core-schema read gives the string `"2024-01-01"` for both the plain
and the quoted form; `new YAML.Document({ title: "2024-01-01" }).toString()` writes it plain (Astro would read a
Date); with `{ schema: "core", customTags: ["timestamp"] }` a string is written quoted and a `Date` plain. remark-mdx
attaches `data.estree` to an `mdxjsEsm` node; each `ImportDeclaration`/`Export*Declaration` `source` literal carries
`start`/`end` offsets, quotes included, into the parsed text (`import A from '../../components/A.astro'` -> 14..40).

## Owner rulings and plan-level decisions

- R1 (owner, 2026-11-17; agy-first ALIGNED after one counter-turn, seam `.clavity/seams/starlight-datestyle-first.md`):
  a locale file's follows-English front matter is written from the English FILE's YAML nodes as on disk at export,
  with the localized mapped paths replaced by the locale's values. Scalar style, quoting, key order and comments are
  English's; stored shared values stay in the database for SDK readers. This settles 5.8's "plain stays plain, quoted
  stays quoted" (impossible from stored JSON). Every value the writer creates (localized values) is stringified with
  `{ schema: "core", customTags: ["timestamp"] }`, so a date-like localized string is quoted. Recorded in spec 5.8
  (the plan's own commit).
- D1 (Claude's call). A collection field with no explicit path entry maps to the top-level front-matter key of its
  own name, so a preset lists only non-trivial paths and an adopter's declared extended key needs no entry.
- D2. Starlight mode refuses (layout validation error) a collection that has a `reference` field anywhere: the spec
  never maps one and porting reference resolution to the new path is not needed for v0.1.
- D3. In the root-locale layout a top-level folder cannot be told apart from a Starlight locale folder Mogging does
  not manage (for example `fr/`). The layout lists such folders in `otherLocaleDirs`; import skips them with one
  warning each. Plan 6b's `init --starlight` writes the list from Starlight's `locales`, and its drift check compares
  it with `astro.config`.
- D4. `json` is never localized: `defineConfig` refuses it as a localized field, as a body, and anywhere inside a
  localized field's list or object. `translate: false` is accepted on `text` fields only.
- D5. Starlight-mode front matter with keys the mapped field does not declare inside a mapped object (for example
  `hero.actions[].attrs`, spec 5.9) drops those keys with a per-file warning naming the path; the English file keeps
  them (it is never rewritten).
- D6. A Starlight file whose front matter Astro would read differently from Mogging is a per-file error naming the
  limit: `readStarlightFile` runs Astro's own front-matter regex
  `/(?:^\uFEFF?|^\s*\n)(?:---|\+\+\+)([\s\S]*?\n)(?:---|\+\+\+)/` (`@astrojs/internal-helpers@0.13.0`
  `src/frontmatter.ts:17`) and refuses the file when that block differs from the one `splitFrontMatter`'s rule
  extracts, or when it is TOML (`+++`). Measured: `--- \n` (trailing space), a closing `---x`, and blank lines before
  `---` are read by Astro and not by Mogging (panel round 2 BS-5). A front-matter `slug` key is a per-file error
  (spec 5.2).
- D7. Import is plan-then-apply: phase 1 reads (files, then heads in pages of documents) and computes every outcome;
  phase 2 writes. `dryRun` returns phase 1's report and writes nothing, which is the "simulates the creating pass in
  memory" of spec 5.4.
- D8. Core gains `getDocuments` (heads for many documents in a constant number of queries), which the spec's
  performance bar (6: "per page of documents, not per file") needs; `listPublishedVersions` is the classification
  read of 5.4.
- D9. A corrupt `.mogging/manifest.json` is treated as empty with a warning (nothing becomes removable) and is
  rewritten by the next export.
- D10. Starlight mode requires the collection's `slug`-kind field to be named `slug`: core's slug readers use that
  key (`packages/core/src/read/resolve.ts:165,212`, `read/review.ts:85`; logged in `.clavity/local-anomalies.md`).
- D11 (spec erratum, panel round 1 AB-1). Rebasing follows 5.9's exact rule (resolve against the file it was read
  from, re-express relative to the file it is written to) for every locale file. Spec 5.2's "the rebasing of 5.9 is a
  no-op" in the own-folder layout, and 5.9's "only when the depth difference is not zero", hold only for references
  that leave both locale folders: measured, a colocated `./img.png` of `en/guides/a.md` is `../../en/guides/img.png`
  from `de/guides/a.md`, and of root-mode `guides/a.mdx` it is `../../guides/img.png` from `de/guides/a.mdx`. So the
  MDX re-parse runs for every `mdxjsEsm` block of a file export decides to write (never for a file it keeps or
  refuses). Erratum lines added to spec 5.2 and 5.9.
- D12. Every lookup keyed by a name from the repository or the manifest (folder names, locales, slugs, paths) uses a
  `Map` or `Object.hasOwn`, never a plain-object index (`constructor/`, `__proto__` folders and manifest locales).

## File Structure

Core (`packages/core/src`):
- `schema/fields.ts` (modify): `json` kind and factory; `translate` option.
- `schema/config.ts` (modify): the D4 checks in `defineConfig`.
- `values/normalize.ts` (modify): the `json` case.
- `documents/saveDraft.ts` (modify): `untracked` option; slug guard.
- `documents/slugGuard.ts` (create, internal): the per-collection lock and the uniqueness check.
- `documents/publishCore.ts`, `releases/releases.ts` (modify): slug guard on shared publishes.
- `read/resolve.ts` (modify): `getDocuments`.
- `read/versions.ts` (create): `listPublishedVersions`, `listLocaleRows`.
- `index.ts` (modify): exports.

AI (`packages/ai/src`): `fields.ts` (json, translate leaves, wire projection, fixed-leaf merge), `validate.ts`
(projection and merge), `translate.ts` (wire schema), `jobs.ts` (`includeUntracked`).

Markdown (`packages/markdown/src/starlight/`, all new; `import.ts`, `export.ts`, `index.ts` modified to dispatch):

| File | Responsibility |
|---|---|
| `layout.ts` | `defineStarlightLayout`, the layout types, locale <-> folder maps |
| `slugs.ts` | slug derivation from a docs-relative path (F-ID, keeping `index`) |
| `frontMatter.ts` | safe YAML read of a Starlight file; split into fields by the path map; union/stringAs normalization |
| `rebase.ts` | reference grammars, canonical form, tree and MDX ESM rewriting |
| `render.ts` | writing a locale file from the English YAML document plus the locale's values (R1) |
| `scan.ts` | walking `<docsDir>`: pages, locale files, skips, collisions |
| `classify.ts` | the localized-field comparison rule and the four classes |
| `manifest.ts` | reading and atomically writing `.mogging/manifest.json` |
| `fsSafe.ts` | symlink-refusing atomic file writes, moves and removals inside `<docsDir>` |
| `importStarlight.ts` | plan-then-apply import (5.3, 5.4 import side, 5.5 prune, 5.6 safety stop, 5.9 draft rule) |
| `exportStarlight.ts` | export (5.4, 5.5 removals) |
| `rename.ts` | `renamePage` (5.6) |

Tests: `packages/markdown/test/starlight/*.test.ts` plus `packages/markdown/test/starlight/fixtures.ts` (the test
collection, config and layout below, shared by Tasks 6 to 17).

## Review Focus

The inputs most likely to bite an adopter that no single task's happy path exercises; each line's test is added to
the owning task (named).

1. A file named with upper case, spaces or dots (`Getting Started.md`, `v1.2.md`) beside a locale file that uses the
   slugified name: one document, the locale file written under the English name, never a second document (Tasks 10,
   13, 14).
2. A follows-English value that is a plain date, a quoted date, a comment or a flow sequence in English: read by
   Astro's parser with the same values and types in every exported locale file, comments and key order kept (yaml may
   re-space a flow sequence and writes a full timestamp in ISO form; panel round 1 AB-3) (Task 9).
3. A hand-edited locale file that drops `prev` while English has `prev: false`: classified `published`, never `hand
   work`, and a later hand edit of its title keeps the stored `prev` (Tasks 11, 13).
4. A docs folder reached through a symbolic link, or a manifest entry pointing outside `<docsDir>` (`../../etc/x`):
   nothing written, moved or removed outside `<docsDir>` (Tasks 14, 15).
5. A run interrupted between files (export, rename): the next run completes without duplicating, losing or
   mis-classifying a file (Tasks 14, 16).

---

## Test fixture used from Task 6 onward (`packages/markdown/test/starlight/fixtures.ts`)

Created in Task 6 and extended by later tasks only with helpers. It is the draft of plan 6b's preset, so its field
names are the ones 6b ships.

```ts
export const docs = defineCollection("docs", {
  slug: slug(),
  title: text({ localized: true, required: true }),
  description: text({ localized: true }),
  template: text(), draft: boolean(), pagefind: boolean(),
  sidebarOrder: number(), sidebarHidden: boolean(), sidebarAttrs: json(),
  sidebarLabel: text({ localized: true }),
  sidebarBadge: object({ text: text(), variant: text({ translate: false }), class: text({ translate: false }) }, { localized: true }),
  prevToggle: boolean(), prev: object({ label: text(), link: text({ translate: false }) }, { localized: true }),
  nextToggle: boolean(), next: object({ label: text(), link: text({ translate: false }) }, { localized: true }),
  hero: object({
    title: text(), tagline: text(),
    image: object({ alt: text(), file: text({ translate: false }), dark: text({ translate: false }),
                    light: text({ translate: false }), html: text({ translate: false }) }),
    actions: list(object({ text: text(), link: text({ translate: false }), variant: text({ translate: false }),
                           icon: text({ translate: false }) })),
  }, { localized: true }),
  banner: object({ content: text() }, { localized: true }),
  editUrl: json(), lastUpdated: json(), tableOfContents: json(), head: json(),
  extra: json(),
  body: richText({ localized: true, body: true }),
});
export const config = defineConfig({ collections: [docs], locales: { source: "en", chains: { de: ["en"], "zh-CN": ["en"] } } });
export const layoutInput: StarlightLayoutInput = {
  collection: "docs", passthrough: "extra", otherLocaleDirs: ["fr"],
  paths: [
    { path: "sidebar.order", field: "sidebarOrder" }, { path: "sidebar.hidden", field: "sidebarHidden" },
    { path: "sidebar.attrs", field: "sidebarAttrs" }, { path: "sidebar.label", field: "sidebarLabel" },
    { path: "sidebar.badge", field: "sidebarBadge", stringAs: "text" },
    { path: "prev", union: { toggle: "prevToggle", value: "prev", stringAs: "label" } },
    { path: "next", union: { toggle: "nextToggle", value: "next", stringAs: "label" } },
  ],
  fileRefs: ["hero.image.file", "hero.image.dark", "hero.image.light"],
  requiredWhenSource: ["hero"],
};
export const layout = defineStarlightLayout(layoutInput, config);   // docsDir "src/content/docs", root-locale mode
```

Plus, all created in Task 6: `layoutOwn` (the same input with `sourceDir: "en"`, the own-folder mode; Tasks 12 to 16
each run at least one test against it), `ctxFor(sql)`, `writeTree` (as `packages/markdown/test/fixtures.ts`),
`project(files)` (a temp project root with files under it), `readTree(root)` (every file under root as POSIX path ->
text), `extraConnection(sql)` (a second connection on the same per-test schema, as `core/test/fixtures.ts:28`), and
`countingSql(sql)` (an `extraConnection` with a postgres.js `debug` callback that counts queries, returning
`{ sql, count(): number, reset(): void }`).

---

### Task 1: core `json` field kind

**Files:**
- Modify: `packages/core/src/schema/fields.ts:1-48`, `packages/core/src/schema/config.ts:29-40`,
  `packages/core/src/values/normalize.ts:11-32,34-87`, `packages/core/src/index.ts:9`,
  `packages/ai/src/fields.ts:5-19,34-46,92-128`
- Test: `packages/core/test/schema.test.ts`, `packages/core/test/values.test.ts`, `packages/core/test/api.test.ts`,
  `packages/ai/test/fields.test.ts`, `packages/markdown/test/import.test.ts`

**Interfaces:**
- Produces: `json(o?: FieldOptions): Field` exported from `@mogging/core`; `Field` gains `(Base & { kind: "json" })`.

- [ ] **Step 0: State check.** Open the files above and confirm `Field` has exactly the nine kinds of
  `fields.ts:15-24` and that `normalizeAt` has no `default` branch (`normalize.ts:35`). If not, STOP:
  `STATE_MISMATCH: <what>`.
- [ ] **Step 1: Write the failing tests.**
  - `schema.test.ts` "json is a shared opaque kind": `expect(json()).toMatchObject({ kind: "json", localized: false })`;
    `defineConfig` with `json({ localized: true })` throws `ValidationError` matching `/json cannot be localized/`;
    with `list(json(), { localized: true })` and `object({ a: json() }, { localized: true })` throws the same; with
    `json({ body: true })` throws `/only a richText field can be the body/` (existing message, `config.ts:36`).
  - `values.test.ts` "a __proto__ key is refused in json and richText": `normalizeValue(json(), JSON.parse('{"a":{"__proto__":{"x":1}}}'))`
    and `normalizeValue(richText(), JSON.parse('{"type":"root","children":[],"__proto__":{"x":1}}'))` both throw
    `ValidationError(/__proto__/)`, and `({}).x` stays undefined.
  - `values.test.ts` "json normalizes any JSON value": `normalizeValue(json(), { a: [1, null, "é"] })` equals the NFC
    form with the nested null kept; `normalizeValue(json(), "x\u0000")` throws `ValidationError`;
    `normalizeValue(json(), JSON.parse('{"a":{"__proto__":{"x":1}}}'))` throws `ValidationError(/__proto__/)`; a `Date`, `NaN`,
    and `{ k: undefined }` -> `{}` (dropped) behave as `nfcDeep` does (`normalize.ts:11-32`); a key `"a\u0000"` throws.
  - `api.test.ts`: add `"json"` to `FUNCTIONS`.
  - `ai/test/fields.test.ts` "a json leaf is never sent and is compared by value": `prompt.ts` `contextValues`
    leaves out a SHARED field `object({ t: text(), j: json() })` (a json leaf anywhere makes `isTranslatable` false,
    and `contextValue` uses it, `prompt.ts:41`); `checkShape(json(), {a:1}, {a:1})` is `[]` and
    `checkShape(json(), {a:1}, {a:2})` is `["$: non-text value changed"]`.
  - `markdown/test/import.test.ts` "a shared json field round-trips through the generic layout": a source file with
    front matter `meta: { a: [1, null], b: "x" }` on a collection with `meta: json()` imports, publishes, exports,
    and the exported front matter parses back to the same object.
- [ ] **Step 2: Run them and see them fail.** `pnpm --filter @mogging/core test schema values api`,
  `pnpm --filter @mogging/ai test fields`, `pnpm --filter @mogging/markdown test import`. Expected: FAIL (`json` is
  not exported).
- [ ] **Step 3: Implement.** `json = (o?: FieldOptions): Field => ({ kind: "json", ...base(o) })`. `normalizeAt`
  case `"json"`: `return nfcDeep(value, path)`. `nfcDeep` (`normalize.ts:11-32`, object branch 22-30, shared by `json` and `richText`)
  refuses an object key `__proto__` at any depth with `ValidationError(\`${path}.__proto__: forbidden key\`)`
  (assignment would drop it and set the prototype, measured; panel rounds 2 AX-1 and 3, which found `richText`
  affected too). This one check in `nfcDeep` covers both kinds; Step 1's `values.test.ts` bullet includes
  `normalizeValue(richText(), JSON.parse('{"type":"root","children":[],"__proto__":{"x":1}}'))` throws
  `ValidationError(/__proto__/)` (panel round 4 FR4-2). `defineConfig`: refuse `json` with `localized: true`, and walk each
  localized field's `item`/`fields` refusing a nested `json` (message
  `` `${col.name}.${fname}: json cannot be localized` ``). ai `leafKinds`: `case "json": into.add("json")`, with
  `LeafKind` gaining `"json"`, and `isTranslatable` returns false when `kinds.has("json")`; `fieldSchema` `case
  "json": return z.unknown()`; `walk` handles `"json"` with the existing `isDeepStrictEqual` branch. The markdown
  switches already fall through `default` and need no change; do not add any.
- [ ] **Step 4: Run the tests, typecheck, whole suite.** Expected: PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(core,ai): opaque json field kind (never localized, never sent to the model)`.

### Task 2: `translate: false` leaves (core option, ai wiring)

**Files:**
- Modify: `packages/core/src/schema/fields.ts` (FieldOptions, Base, `base()`), `packages/core/src/schema/config.ts`,
  `packages/ai/src/fields.ts:25-32` and the switches, `packages/ai/src/validate.ts:22-29,95-100`,
  `packages/ai/src/translate.ts:98`, `packages/ai/src/jobs.ts:79,90` (the enqueue estimate)
- Test: `packages/core/test/schema.test.ts`, `packages/ai/test/fields.test.ts`, `packages/ai/test/validate.test.ts`,
  `packages/ai/test/translate.test.ts`

**Interfaces:**
- Produces (core): `FieldOptions.translate?: boolean`; `Base.translate?: false` present only when false (so existing
  `toEqual` assertions on field objects are unchanged, as `fallback` already does at `fields.ts:32`).
- Produces (ai, internal): `wireField(field: Field): Field | null` (the field with every `translate: false` leaf and
  every emptied object/list removed; null when no translatable leaf remains), `wireValue(field: Field, value:
  unknown): unknown` (the value projected onto `wireField`; list items are never dropped: an item that projects to
  nothing becomes `{}` and a null item stays null, so list lengths always match the source; only object keys are
  dropped; panel round 4 FR4-4), `withFixedLeaves(field: Field, source: unknown, draft:
  unknown): unknown` (the draft completed from the source: the draft is compared with `wireValue(field, source)`,
  not with the source; where their list lengths or object keys agree, each `translate: false` leaf, and each subtree
  made only of such leaves (absent from the wire), is copied from the source at the same path, list items aligned by
  index, a null element kept null; where they disagree the draft is returned unchanged so `checkShape` rejects it).

- [ ] **Step 0: State check** as in Task 1, for `ai/src/validate.ts:22-29` (`prepareField`) and
  `ai/src/translate.ts:98` (`schemaFields`). STOP on mismatch.
- [ ] **Step 1: Failing tests.**
  - core "translate: false is a text option": `text({ translate: false })` has `translate: false`; `text()` has no
    `translate` key; `defineConfig` with `number({ translate: false })` throws `/translate: false is only valid on text/`.
  - ai `fields.test.ts`, using `hero = object({ title: text(), actions: list(object({ text: text(), link: text({ translate: false }) })) }, { localized: true })`:
    `isTranslatable(hero)` true; `isTranslatable(text({ localized: true, translate: false }))` false;
    `wireValue(hero, { title: "T", actions: [{ text: "Go", link: "/start" }] })` equals
    `{ title: "T", actions: [{ text: "Go" }] }`; `withFixedLeaves(hero, source, { title: "Ü", actions: [{ text: "Los" }] })`
    equals `{ title: "Ü", actions: [{ text: "Los", link: "/start" }] }`; `checkShape(hero, source, { ..., link: "/x" })`
    contains `"$.actions[0].link: non-text value changed"`. With the fixture-shaped `image: object({ alt: text(),
    file: text({ translate: false }) })` and a source image holding only `file`, the wire value has no `image` and the
    merged draft has the source's `image`; a source list `[null, { text: "a", link: "/b" }]` keeps the null; a list
    item `{ link: "/c" }` (no translatable leaf) projects to `{}`, so `wireValue` of `[{ text: "a", link: "/b" },
    { link: "/c" }]` is `[{ text: "a" }, {}]` (length 2).
  - "the enqueue estimate counts what is sent" (`estimateJob` is private, `jobs.ts:70`): two documents whose `hero`
    values differ only in the length of a `translate: false` link get equal `estimateMicros` from `enqueueStale`.
  - ai `translate.test.ts` "a field with nothing to translate is not sent": a job of `title` and `prev` where `prev`
    is `{ link: "/a" }` makes one call whose schema and message have no `prev`, and the outcome's `prev` is
    `{ link: "/a" }`; a job of only such fields makes no call.
  - ai `prompt.test.ts` "context never carries translate: false leaves": a sibling `hero` with `link: "/start"`
    yields context without `/start`.
  - ai `translate.test.ts` "translate: false leaves never reach the model and come back from the source": with a
    mock model that records its call, the request's JSON schema and user message contain no `link` and no `/start`,
    the model answers without `link`, and the outcome's field value has `link: "/start"`.
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement.** `isTranslatable` line 27: a `text` with `translate === false` returns false.
  `leafKinds`: a `text` with `translate === false` adds `"other"`. `estimateJob` (`jobs.ts:79,90`) leaves out a field whose wire value has no string leaf (it is
  not sent; panel round 4 FR4-5) and uses
  `wireValue(field, value)` for the candidate wire value and the character count. `prepareField` (value
  branch) sets `wire: wireValue(field, value)` and keeps `source: value`. `validateField` (value branch) computes
  `const merged = withFixedLeaves(field, prepared.source, draft)` first and uses `merged` for the U+0000 scan,
  `checkShape`, the text comparisons and the returned `value`. `translate.ts:98` maps each field through
  `wireField(field)!` (the planner already excluded untranslatable fields). A job field whose `wireValue` holds no
  string leaf for this source (for example `prev: { link: "/a" }`) is not sent to the model at all: its draft value is
  the source value, and its provenance records no call (panel round 3 AW-1: sent, the model could add a key and fail
  the whole request). Context values (`prompt.ts:33-41` `contextValue`, used for siblings and shared fields,
  `context.ts:35-36`) go through `wireValue` too, so a `translate: false` leaf never reaches the model in any role
  (panel round 3). `walk`'s `text` case: when
  `field.translate === false`, compare with `isDeepStrictEqual` like a non-text kind.
- [ ] **Step 4: Tests, typecheck, suite.** PASS.
- [ ] **Step 5: Commit** `feat(core,ai): translate: false text leaves are copied from the source, never sent`.

### Task 3: untracked saves and `includeUntracked`

**Files:**
- Modify: `packages/core/src/documents/saveDraft.ts:11-16,115-135`, `packages/ai/src/jobs.ts:18,140`,
  `packages/ai/src/compile.ts:24` (and `CompileInput`)
- Test: `packages/core/test/saveDraft.test.ts`, `packages/ai/test/jobs.test.ts`, `packages/ai/test/compile.test.ts`

**Interfaces:**
- Produces: `SaveDraftInput.untracked?: boolean`; `EnqueueInput.includeUntracked?: boolean`;
  `CompileInput.includeUntracked?: boolean`, passed through to `enqueueStale` (`compile.ts:24` builds its own enqueue
  input; plan 6b's `compile --include-untracked` needs it; panel round 3 AW-2).

- [ ] **Step 0: State check** of `saveDraft.ts:115-135` (the hash vector) and `jobs.ts:140`. STOP on mismatch.
- [ ] **Step 1: Failing tests.**
  - `saveDraft.test.ts` "an untracked save records no source hash and publishes as untracked": source published; a
    `de` save with `untracked: true` of `title` and `body` stores `source_hashes = {}`; after `publish`,
    `getSyncState` reports both fields `untracked`. A following ordinary save that changes only `title` stamps
    `title` and leaves `body` untracked (the existing carry-forward, `saveDraft.ts:129-133`).
  - "untracked is refused for shared and for the source locale": `ValidationError` matching
    `/untracked applies to a target locale/`, and no row written.
  - `jobs.test.ts` "includeUntracked queues untracked fields; the default does not": after an untracked publish,
    `enqueueStale({ locales: ["de"] })` enqueues 0; with `includeUntracked: true` it enqueues one job whose
    `fieldPaths` are the untracked translatable fields in schema order.
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement.** In `saveDraft`, validate before any query (after the locale checks): `untracked` with
  `isShared` or the source locale throws `ValidationError("untracked applies to a target locale only")`. When true,
  skip the hash vector entirely (`sourceHashes = {}`). In `enqueueStale`, the state filter becomes
  `stale | missing | (untracked when input.includeUntracked === true)`; `compile` forwards `includeUntracked`. Test:
  "compile with includeUntracked drafts untracked fields" (mock model).
- [ ] **Step 4: Tests, typecheck, suite.** PASS.
- [ ] **Step 5: Commit** `feat(core,ai): untracked target saves and enqueueStale includeUntracked`.

### Task 4: bulk reads `getDocuments`, `listPublishedVersions` and `listLocaleRows`

**Files:**
- Modify: `packages/core/src/read/resolve.ts` (beside `getDocument`), `packages/core/src/index.ts:33-34`
- Create: `packages/core/src/read/versions.ts` (`listPublishedVersions`, `listLocaleRows`)
- Test: `packages/core/test/resolve.test.ts`, `packages/core/test/versions.test.ts` (new), `packages/core/test/api.test.ts`

**Interfaces:**
- Produces: `listLocaleRows(ctx: Ctx, input: { collection: string; docIds: string[] }): Promise<Array<{ docId: string; locale: string }>>`:
  every (document, locale) pair with at least one `document_localized` row in ANY state, head or not (a rejected
  draft and an unpublished locale keep rows with no head, `rejectDraft.ts:52`; `getDocument` reads heads only,
  `resolve.ts:172`); one query; at most 1000 ids. It is spec 5.3's "no row of any state" test (panel round 2 BS-4).
- Produces: `getDocuments(ctx: Ctx, input: { collection: string; docIds: string[] }): Promise<DocumentRecord[]>`
  (records in `docIds` order, unknown or malformed ids omitted, deleted documents included with `deletedAt` set,
  exactly 3 queries whatever the number of ids; at most 1000 ids, else `ValidationError`);
  `listPublishedVersions(ctx: Ctx, input: { collection: string; locale: string; docIds: string[] }): Promise<PublishedVersion[]>`
  with `type PublishedVersion = { docId: string; version: number; data: Record<string, unknown> }`: every
  `document_localized` row in state `PUBLISHED` (current head and history, republish copies included) for those
  documents and the normalized declared `locale` (a non-source or source locale; `"shared"` is a
  `ValidationError`), ordered by `docId`, then `version` descending; one query; at most 1000 ids.

- [ ] **Step 0: State check** of `getDocument` (`resolve.ts`, the `pairOf`/`toSnapshot` helpers). STOP on mismatch.
- [ ] **Step 1: Failing tests.** "listLocaleRows sees rows without a head": after `rejectDraft` of a `de` AI draft
  (no other `de` row), and after `unpublish` of the only `zh-CN` version, both pairs are returned; a
  locale with no row is absent. "getDocuments equals getDocument per id": for 3 documents (one deleted, one with a
  draft only) plus one unknown and one malformed id, `getDocuments` returns 3 records each `toEqual` to
  `getDocument` for that id, in input order. "getDocuments issues 3 queries for 1 and for 50 ids" (count with a
  postgres.js `debug` callback on an `extraConnection`, `core/test/fixtures.ts`). "listPublishedVersions returns
  every published version newest first": publish v1, publish v2, unpublish, republish v1 (copy v3): versions
  `[3, 2, 1]` with their data; a draft-only row is absent; `locale: "shared"` throws. API test adds `getDocuments`, `listPublishedVersions` and `listLocaleRows`.
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement** with `docIds` bound as one JSONB array (`jsonb_array_elements_text`), never interpolated;
  hoist `pairOf` (today a closure inside `getDocument`, `resolve.ts:174`) to module scope beside `toSnapshot`
  (`resolve.ts:133`) and use both. Export `PublishedVersion` as a type. Callers with more than 1000 ids call in
  chunks of 1000 (Tasks 12 to 15 do; panel round 1 CA-1).
- [ ] **Step 4: Tests, typecheck, suite.** PASS.
- [ ] **Step 5: Commit** `feat(core): getDocuments and listPublishedVersions bulk reads`.

### Task 5: slug uniqueness under a per-collection lock (spec 8)

**Files:**
- Create: `packages/core/src/documents/slugGuard.ts`
- Modify: `packages/core/src/documents/saveDraft.ts:78-113`, `packages/core/src/documents/publishCore.ts:44-99`,
  `packages/core/src/releases/releases.ts:198-205,251-257`
- Test: `packages/core/test/slugGuard.test.ts` (new)

**Interfaces (internal, not exported):**
- `lockSlugs(tx: Tx, collections: string[]): Promise<void>`: `select pg_advisory_xact_lock(hashtext('mogging_slug:' || $1))`
  for each distinct name in sorted order (the name binds as a parameter).
- `assertSlugFree(tx: Tx, ctx: Ctx, input: { collection: string; docId: string; data: Record<string, unknown> }): Promise<void>`:
  finds the collection's `slug`-kind field (none: return); when `data` holds a string at that key, throws
  `ValidationError(\`Slug "${slug}" is already used by another document in collection "${collection}"\`)` if a
  different live document (`deleted_at is null`) of the collection has that value in its shared published head or
  shared draft head. The field name binds as a parameter (`data ->> $field`).

- [ ] **Step 0: State check** of the three call sites. STOP on mismatch.
- [ ] **Step 1: Failing tests (`slugGuard.test.ts`).** "a second live document cannot save the same slug":
  ValidationError, and no row written. "a published or a draft slug both block". "a soft-deleted document's slug
  is free". "a document may re-save its own slug". "publishing a shared draft whose slug another document took
  meanwhile is refused" (draft saved before the guard existed is simulated by inserting the second row with raw
  SQL). "republishing an old shared version is checked too". "publishRelease checks shared items". "two concurrent
  saves of the same slug on different documents: exactly one succeeds" (two `extraConnection`s, repeated 10 times,
  as `saveDraft.test.ts:139`). "a collection with no slug field is never checked" (ai fixtures' `docs`).
  "two releases spanning two collections in opposite order both complete": the documents are inserted with raw SQL
  and chosen ids so that each release's item order (`order by doc_id`, `releases.ts:195`) visits the collections in
  the opposite order from the other; the two releases run concurrently on two `extraConnection`s, 10 times; and a
  test of the up-front lock: a third connection holds `pg_advisory_xact_lock(hashtext('mogging_slug:' || 'B'))`, a
  release with shared items of collections `A` and `B` starts, and a fourth connection's `pg_locks` read shows the
  release's backend holding `A`'s lock and waiting on `B`'s before any item is published (panel round 2 TO-3).
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement.** In `saveDraft`, shared scope only, after the `documents` row lock: `lockSlugs` then
  `assertSlugFree` with the normalized `data`. In `publishWithinTx` (whose input has no collection,
  `publishCore.ts:44`), shared scope: read `collection` from `documents` by `docId` and the target row's data,
  then `lockSlugs` (re-entrant inside the transaction) and `assertSlugFree` before the flip or copy. In `publishRelease`,
  after the document locks, `lockSlugs` once with the sorted collections of all shared items, so two releases never
  take collection locks in opposite orders.
- [ ] **Step 4: Tests, typecheck, WHOLE suite.** An existing test that now fails because it saved one slug on two live
  documents is NOT edited by you: STOP and report the list (`SLUG_DUPLICATE_TESTS: <file:test>`); the controller
  decides each one.
- [ ] **Step 5: Commit** `feat(core): refuse a slug another live document of the collection holds (spec 8)`.

### Task 6: Starlight layout and slug derivation

**Files:**
- Create: `packages/markdown/src/starlight/layout.ts`, `packages/markdown/src/starlight/slugs.ts`,
  `packages/markdown/test/starlight/fixtures.ts`, `packages/markdown/test/starlight/layout.test.ts`
- Modify: `packages/markdown/package.json` (`pnpm --filter @mogging/markdown add github-slugger@2.0.0`),
  `packages/markdown/src/index.ts`, `packages/markdown/test/api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StarlightPathEntry =
    | { path: string; field: string; stringAs?: string }
    | { path: string; union: { toggle: string; value: string; stringAs: string } };
  export type StarlightLayoutInput = {
    collection: string; docsDir?: string; sourceDir?: string | null; localeDirs?: Record<string, string>;
    otherLocaleDirs?: string[]; paths?: StarlightPathEntry[]; passthrough: string; fileRefs?: string[];
    requiredWhenSource?: string[];
  };
  export type StarlightLayout = { readonly kind: "starlight"; readonly collection: string; readonly docsDir: string;
    readonly sourceDir: string | null; readonly localeDirs: Readonly<Record<string, string>>;
    readonly otherLocaleDirs: readonly string[]; readonly entries: readonly LayoutEntry[];
    readonly passthrough: string; readonly fileRefs: readonly string[]; readonly requiredWhenSource: readonly string[] };
  export type LayoutEntry =
    | { kind: "plain"; path: readonly string[]; field: string; localized: boolean; stringAs: string | null }
    | { kind: "union"; path: readonly string[]; toggle: string; value: string; stringAs: string };
  export function defineStarlightLayout(input: StarlightLayoutInput, config: MoggingConfig): StarlightLayout;
  export function deriveSlug(relPath: string): string;        // starlight/slugs.ts, internal
  export function localeOfDir(layout: StarlightLayout, dir: string): string | null;   // internal
  ```
  `localeDirs` in the result maps EVERY declared non-source locale to its folder; `entries` holds the explicit
  entries plus one implicit `plain` entry per remaining declared field (D1) other than the `slug` field, the body
  field and the passthrough field, sorted by path.

- [ ] **Step 0: State check**: `packages/markdown/src/index.ts` exports exactly the 9 runtime names pinned by
  `test/api.test.ts:6`. STOP on mismatch.
- [ ] **Step 1: Failing tests.** `deriveSlug` table (F-ID, but `index` kept as the last segment):
  `Getting-Started.md` -> `getting-started`, `guides/Hello World.md` -> `guides/hello-world`, `guides/index.md` ->
  `guides/index`, `index.md` -> `index`, `a_b/c.d.md` -> `a_b/cd`, `Über/naïve.mdx` -> `über/naïve`, `!!.md` throws
  `ValidationError(/empty slug segment/)`. `defineStarlightLayout(layoutInput, config)` yields `docsDir
  "src/content/docs"`, `sourceDir null`, `localeDirs { de: "de", "zh-CN": "zh-cn" }`, implicit entries for `title`,
  `hero`, `extra` is NOT an entry (it is the passthrough); an NFD file name (`U\u0308ber.md`) derives the NFC slug
  `über`. Each of these is a `ValidationError` naming the problem: a slug-kind field not named `slug` (D10);
  unknown collection; passthrough not a shared `json` field; a field mapped twice; a path mapped twice; a path that
  is a prefix of another (`sidebar` and `sidebar.order`); a union whose toggle is not a shared boolean or whose value
  is not a localized object with a text `stringAs` key; `stringAs` naming a non-text sub-field; a path segment
  `__proto__`, `constructor` or `prototype`; a path or field named `slug`; a `reference` field in the collection
  (D2); a locale folder that is not its own slugified form (`zh-CN`); two locales on one folder; a folder in both
  `localeDirs` and `otherLocaleDirs`; `docsDir` absolute or containing `..`; a `fileRefs` path whose first segment is
  not a localized field or whose leaf is not `text`, or that crosses a list; `requiredWhenSource` naming a shared
  field. API test adds `defineStarlightLayout`.
- [ ] **Step 2: Run, see FAIL** (`pnpm --filter @mogging/markdown test layout`).
- [ ] **Step 3: Implement.** `deriveSlug`: split on `/`, strip the last extension from the last segment,
  NFC-normalize each segment, map it through `slug` from `github-slugger`, refuse an empty segment, join with `/`;
  then require `isSafeSlug` (`src/slug.ts:2`). The layout is frozen (`Object.freeze`, deep for arrays); its
  folder/locale maps are `Map`s or are read with `Object.hasOwn` (D12). Create every fixture helper listed under
  "Test fixture" in this task.
- [ ] **Step 4: Tests, typecheck, suite.** PASS.
- [ ] **Step 5: Commit** `feat(markdown): Starlight layout definition and slug derivation`.

### Task 7: reading a Starlight file into fields

**Files:**
- Create: `packages/markdown/src/starlight/frontMatter.ts`, `packages/markdown/test/starlight/frontMatter.test.ts`

**Interfaces:**
- Produces (internal):
  ```ts
  type StarlightFile = { frontMatter: string | null; doc: YAML.Document | null; data: Record<string, unknown>; body: string };
  function readAstroFrontMatter(frontMatter: string | null): Record<string, unknown>;   // Astro's options, toJS
  function readStarlightFile(text: string): StarlightFile;      // throws ValidationError per D6 / unsafe YAML
  type SplitPage = {
    localized: Record<string, unknown>;   // localized fields, normalized, references NOT yet rebased
    shared: Record<string, unknown>;      // shared mapped fields + passthrough, normalized
    toggles: Record<string, boolean>;     // union toggles found (shared)
    remainder: Record<string, unknown>;   // unmapped keys (what the passthrough holds), for the follows-English report
    warnings: string[];
  };
  function splitPage(layout: StarlightLayout, col: Collection, file: StarlightFile, mode: "md" | "mdx"): SplitPage;
  ```
  `readStarlightFile` strips a BOM, converts CRLF to LF, NFC-normalizes (as `splitFrontMatter`,
  `contentFile.ts:21-41`), and parses with `YAML.parseDocument(fm, { schema: "core", merge: true, uniqueKeys: true })`;
  `frontMatter` is the raw text between the fences (null when there is none); `readAstroFrontMatter` parses it with
  Astro's options (F-YAML) and returns `toJS()` (Dates kept), used by Task 9 (which re-parses `frontMatter`, it does
  not copy `doc`) and by Task 14's keep test (panel round 4 IC4-2).

- [ ] **Step 1: Failing tests.**
  - Safety: `__proto__`, `constructor` or `prototype` as a key at any depth (found by visiting the YAML pairs before
    `toJS`) is `ValidationError(/forbidden key/)` and `Object.prototype` gains nothing; an unknown tag `!x 1` and any
    `doc.errors`/`doc.warnings` entry is a `ValidationError`; an alias and a `<<` merge resolve before mapping; a
    nested alias bomb (`maxAliasCount` exceeded in `toJS`) is a `ValidationError`, not a thrown `ReferenceError`; a file
    starting `+++` and one with blank lines before `---` are `ValidationError(/front matter/)` naming the limit; a
    `slug:` key is `ValidationError(/slug override/)`; a body field name in front matter keeps the existing error.
  - Mapping (fixture layout): `sidebar: { order: 2, label: "Intro", badge: "New", attrs: { class: "x" } }` gives
    shared `sidebarOrder: 2`, `sidebarAttrs: { class: "x" }`, localized `sidebarLabel: "Intro"`,
    `sidebarBadge: { text: "New" }` and no `sidebar` in `remainder`; `prev: false` gives `toggles.prevToggle =
    false` AND `shared.prevToggle = false` (a toggle is a shared field and is saved with the shared scope; agy round 5
    F2), no localized `prev`; `prev: true` gives `toggles.prevToggle = true` and `shared.prevToggle = true`; no `prev`
    key gives neither; a file with no unmapped key gives no `extra` in `shared` (absent, never `{}`; panel round 5
    ED-5); `prev: "Back"` gives localized
    `prev: { label: "Back" }`; `prev: { link: "/a" }`
    gives `prev: { link: "/a" }`; `prev: {}` and `prev: null` give neither; `prev: 3` is a per-file error; an
    unmapped `owner: "team-a"` and `seo: { noindex: true }` give shared `extra: { owner: "team-a", seo: { noindex: true } }`
    and the same in `remainder`; `hero.actions[0].attrs` is dropped with the warning
    `hero.actions[0].attrs: not part of the field; dropped (the English file keeps it)` (D5); `lastUpdated:
    2024-01-01` and `lastUpdated: "2024-01-01"` both give the string `"2024-01-01"`; an empty body gives no body
    field; a body gives the richText tree in the file's mode.
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement** with null-prototype objects or `Object.hasOwn` throughout; the whole read (parse, key
  visit, `toJS`) sits in one try/catch that rethrows as `ValidationError` (as `contentFile.ts:32-36` does). Each entry
  is extracted from a
  structured clone of `data` and deleted; a parent emptied by an extraction is deleted; a path whose parent is not a
  mapping stays in the remainder. Values are normalized with `normalizeValue` (core) after the D5 pruning.
- [ ] **Step 4: Tests, typecheck, suite.** PASS.
- [ ] **Step 5: Commit** `feat(markdown): safe Starlight front-matter read and path-mapped split`.

### Task 8: rebasing relative file references (spec 5.9)

**Files:**
- Create: `packages/markdown/src/starlight/rebase.ts`, `packages/markdown/test/starlight/rebase.test.ts`

**Interfaces:**
- Produces (internal), all with POSIX file paths relative to the project root:
  ```ts
  function rebaseSpecifier(spec: string, fromFile: string, toFile: string): string;   // ESM grammar
  function rebaseSource(src: string, fromFile: string, toFile: string): string;      // image()/Markdown image grammar
  function rebaseTree(tree: RichTextRoot, fromFile: string, toFile: string): { tree: RichTextRoot; errors: string[] };
  function rebaseValueAt(value: unknown, leaf: readonly string[], fromFile: string, toFile: string): unknown;
  ```
  Canonical form: the path part (before `?`/`#`, which are kept) is resolved against `dirname(fromFile)`,
  re-expressed relative to `dirname(toFile)` with `path.posix`, has no `.`/`..` segment after the leading `..` run,
  and starts with `./` unless it starts with `../`. ESM: relative only when it starts with `./` or `../`; anything
  else is returned unchanged. Image grammar: relative when non-empty and not starting with `/`, `#`, `~`, `@`, or a
  scheme `^[A-Za-z][A-Za-z0-9+.-]*:`. `rebaseTree` rewrites `image` nodes (never `link` nodes, never inside
  `code`/`inlineCode`) and the `source` of `opaqueBlock` nodes whose `node` is `mdxjsEsm`, re-parsed with
  `parseMdast(source, "mdx")` (`parse.ts:24`) and rewritten by replacing only the characters inside each
  `source` literal's quotes (`start + 1 .. end - 1`), back to front; a block that does not parse is left as is and
  reported in `errors` (the caller decides, Task 14).

- [ ] **Step 1: Failing tests.** Exact strings, both directions, English `src/content/docs/guides/a.mdx` to German
  `src/content/docs/de/guides/a.mdx` (values measured with `path.posix`, D11): `../../assets/h.webp` ->
  `../../../assets/h.webp`; `./img.png` -> `../../guides/img.png`; bare `img.png` canonical on the English side ->
  `./img.png`, then -> `../../guides/img.png`; `./a/../b.png?x=1#y` -> `../../guides/b.png?x=1#y`; `/abs.png`,
  `https://x/y.png`, `#top`, `~/x`, `@assets/x`, `data:image/png;base64,AA` unchanged; ESM `import A from
  '../../components/A.astro'` -> `'../../../components/A.astro'` with every other byte of the block identical;
  `export { b } from "./b.js"` -> `"../../guides/b.js"`; `import 'react'` and `import x from "astro-embed"`
  untouched; a `[x](../guide/)` link and an image inside a code block unchanged. Own-folder layout
  (`src/content/docs/en/guides/a.md` -> `src/content/docs/de/guides/a.md`): `./img.png` -> `../../en/guides/img.png`,
  and `../../../assets/h.webp` (leaving both locale folders) unchanged.
  Property test (300 generated relative paths, depth 0 to 4, with `?`/`#` suffixes): `rebase(rebase(v, E, L), L, E)
  === canonical(v)` and canonical is idempotent. A rebase that returns its input unchanged must fail the first block
  of exact-string assertions (the plan's oracle: spec 5.9 "a rebase that does nothing must fail a test"), and a
  "prepend one `../`" implementation must fail the colocated rows. A tree test (panel round 2 TO-1) puts `./a.png`
  in a list item, a table cell, a blockquote, a heading, a container label and inside a link (`[![x](./a.png)](/p)`),
  English to German and back, and asserts each `url` exactly (`../../guides/a.png`, then `./a.png`).
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement** per the interface; no regular expression touches an ESM block.
- [ ] **Step 4: Tests, typecheck, suite.** PASS.
- [ ] **Step 5: Commit** `feat(markdown): canonical rebasing of relative file references for locale files`.

### Task 9: writing a locale file (R1)

**Files:**
- Create: `packages/markdown/src/starlight/render.ts`, `packages/markdown/test/starlight/render.test.ts`
- Modify: `packages/markdown/package.json` (`pnpm --filter @mogging/markdown add -D @astrojs/internal-helpers@0.13.0`)

**Interfaces:**
- Consumes: Task 7 `readStarlightFile`, `splitPage`; Task 8 `rebaseTree`, `rebaseValueAt`.
- Produces (internal):
  ```ts
  function renderLocaleFile(args: {
    layout: StarlightLayout; col: Collection; english: StarlightFile; englishPath: string; localePath: string;
    localized: Record<string, unknown>;  // the locale's published values, canonical (relative to the English file)
  }): { text: string; errors: string[] };
  ```
  Algorithm: re-parse the English front matter text with Astro's options
  `YAML.parseDocument(fm, { schema: "core", customTags: ["timestamp"], merge: true })` (F-YAML; a clone of Task 7's
  core-schema document would write a created date-like string unquoted, measured) and clone it; when that document
  holds any alias or merge key, use `new YAML.Document(doc.toJS(), sameOptions)` instead (values and types kept,
  comments lost; one warning per file; panel round 1 AB-2). Then, for each localized `plain` entry: when the locale
  has a value, `setIn(path, createNode(value))` (in place when English had the path, so key order and leading
  comments stay; a trailing comment on that key may be dropped, measured; else appended to its parent mapping,
  creating parents); when it has none, `deleteIn(path)`. For each union, read English's value at its path: `false` ->
  keep `false`; otherwise the locale's value field when present, else delete the key. Every value of an entry with
  `stringAs` (union or plain, for example `sidebar.badge`) is written in the shortest form: an object whose only key
  is `stringAs` becomes that string (panel round 2 TO-4). Rebase
  `fileRefs` leaves and the body tree from `englishPath` to `localePath`. Stringify with `{ lineWidth: 0 }`; the body
  is `treeToMarkdown(tree)` (empty tree -> empty body); the output is `---\n<doc>---\n<body>` (no front matter block
  when the document is empty).

- [ ] **Step 1: Failing tests.**
  - "follows-English keys are English's bytes": English front matter with `lastUpdated: 2024-01-01`,
    `publishedAt: "2024-02-02"` (unmapped), a comment line, `tags: [a, b]`, `sidebar: { order: 3, label: Intro }`
    and German values `title: Hallo`, `sidebarLabel: Einführung`: Astro's `parseFrontmatter`
    (`@astrojs/internal-helpers/frontmatter`) reads every key of the German file except `title` and `sidebar.label`
    with the same value and type as English's (`lastUpdated` a `Date`, `publishedAt` the string `"2024-02-02"`), the
    comment line and the English key order are present, and `title`/`sidebar.label` hold the German values.
  - "merged keys never leak": English with `base: &b { description: English }` and `<<: *b` at the top level, German
    without `description`: the German file has no `description` value under Astro's parser.
  - "a date-like localized string is quoted": German `title: "2024-01-01"` renders `title: "2024-01-01"` and Astro
    reads a string.
  - "union rule": English `prev: false` + German prev `{ label: "Zurück" }` -> `prev: false`; English `prev: "Back"`
    + German `{ label: "Zurück" }` -> `prev: Zurück`; English absent + German `{ label: "Zurück", link: "/de/a" }`
    -> the object; English `prev: true` + no German value -> no `prev` key; German `sidebarBadge: { text: "Neu" }`
    -> `badge: Neu` and `{ text: "Neu", variant: "tip" }` -> the object.
  - "orphaned per-locale value is written": English without `banner`, German `banner: { content: "Nur hier" }` ->
    written.
  - "file references are rebased": hero image `../../assets/h.webp` (canonical, English at depth 0) renders
    `../../../assets/h.webp` for `de/`.
  - "round trip": `splitPage(readStarlightFile(rendered))` gives back exactly the German localized values (after
    reverse rebasing) and toggles equal to English's, `true` and absent counting as equal (the self-check of Task 14
    relies on this).
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement** per the interface.
- [ ] **Step 4: Tests, typecheck, suite.** PASS.
- [ ] **Step 5: Commit** `feat(markdown): render Starlight locale files from the English document (owner ruling R1)`.

### Task 10: scanning the docs folder

**Files:**
- Create: `packages/markdown/src/starlight/scan.ts`, `packages/markdown/test/starlight/scan.test.ts`

**Interfaces:**
- Produces (internal):
  ```ts
  type ScannedFile = { path: string; locale: string; rel: string; slug: string; ext: ".md" | ".mdx"; error: string | null };
  type Scan = {
    sources: ScannedFile[];                    // source-locale files, by slug
    locales: ScannedFile[];                    // locale files (locale = BCP 47 tag)
    unsupported: Array<{ path: string; locale: string; slug: string }>;  // files with another Starlight extension (F-GLOB)
    symlinks: Array<{ path: string; locale: string; slug: string; kind: "file" | "folder" }>;  // not followed
    warnings: FileMessage[];                   // skipped other-locale folders, non-regular files
  };
  function scanDocs(root: string, layout: StarlightLayout, config: MoggingConfig): Scan;
  ```
  `path` is the project-relative POSIX path; `rel` the path inside the locale (`guides/Getting-Started.md`). In
  `symlinks` and `unsupported`, `slug` is relative to the locale folder (never including `en/` in own-folder mode):
  a file's slug is `deriveSlug(rel)`, a FOLDER's is its segments slugified with no extension stripping (`v1.2/` ->
  `v12`, the prefix its pages carry; panel round 5 FR5-1). A symlink is classified by its NAME, never by following
  it (a dangling link, for example into an absent submodule, has no type; panel round 6 FR6-1): a name with a
  Starlight extension is a `file`, a name with no extension is a `folder`, and both are listed; any other symlink (an
  image under `assets/`) is a warning only (FR5-2). Tests (FR6-2): `v1.2/` symlinked gives folder slug `v12`; a
  dangling `guides` link is a listed folder; `assets/logo.png` linked is a warning only; under `layoutOwn` a
  symlinked `en/guides` has slug `guides`. Files
  whose NAME starts with `_` are skipped silently (folders starting with `_` are walked, spec 5.2); dot entries are
  skipped; a symbolic link anywhere under `<docsDir>` (file or folder), or `<docsDir>` or one of its components
  below the project root being one, is a warning and not followed. A top-level folder is matched to a locale by
  its slugified name (`DE/` is German, as Starlight reads it, F-ID/F-LOCALE); two folders slugifying to one locale
  are both errors. In root-locale mode a top-level folder that no layout map names and whose name `normalizeLocale`
  accepts with a 2-letter language (for example `es`, `pt-br`) gets one warning: "imported as English pages; if it
  is a Starlight locale, list it in otherLocaleDirs". Two files of one
  locale with the same derived slug are both `error: "slug collides with <other path>"`; `.md` and `.mdx` twins keep
  today's message (`import.ts:204`).

- [ ] **Step 1: Failing tests** over a temp tree, root-locale mode: `index.mdx`, `Getting-Started.md`,
  `guides/_draft.md` (skipped), `_partials/x.md` (scanned, slug `_partials/x`), `notes.txt` (ignored, not
  unsupported), `old.markdown` and `x.mdoc` (unsupported), `de/getting-started.md` (German, slug `getting-started`),
  `zh-cn/index.mdx` (locale `zh-CN`), `fr/a.md` (skipped: other locale folder, one warning), `a.md` + `A.md`
  (collision errors), a symlinked folder (warning), `DE/b.md` (German), `es/c.md` (English page `es/c` plus the
  warning), and a folder named `constructor` (an English page, no crash, D12). Own-folder mode (`sourceDir: "en"`): `en/a.md` is a source,
  `de/a.md` German, a top-level `x.md` is a warning "outside every locale folder".
- [ ] **Step 2: Run, see FAIL.** **Step 3: Implement.** **Step 4: Tests, typecheck, suite.**
- [ ] **Step 5: Commit** `feat(markdown): scan a Starlight docs folder into pages and locale files`.

### Task 11: classification and the comparison rule

**Files:**
- Create: `packages/markdown/src/starlight/classify.ts`, `packages/markdown/test/starlight/classify.test.ts`

**Interfaces:**
- Produces (internal):
  ```ts
  type FileClass = "published" | "pending" | "behind" | "hand work";
  function sameLocalized(layout: StarlightLayout, col: Collection, file: Record<string, unknown>, version: Record<string, unknown>): boolean;
  function classifyHeads(layout: StarlightLayout, col: Collection, file: Record<string, unknown>,
    heads: { published: Record<string, unknown> | null; draft: Record<string, unknown> | null }): "published" | "pending" | null;
  function classifyEarlier(layout: StarlightLayout, col: Collection, file: Record<string, unknown>,
    earlier: Record<string, unknown>[]): "behind" | "hand work";
  ```
  `sameLocalized`: for each union `value` field (the `value` of each `layout.entries` item with `kind === "union"`;
  agy round 5 F3), when the file lacks it or holds `{}`, drop it from both sides; set the root `mode` of every
  top-level richText field's value (found through `col.fields`; panel round 5 ED-1) on both sides to `"md"` (the mode follows the file extension, not the
  content; panel round 3 FR-3); then compare `hashValue` of the two records (all values already normalized, file
  side un-rebased to canonical). Test: the same body stored as an `md` tree and read from an `.mdx` file is
  `published`. Two passes (panel round 4 IC4-3): callers run `classifyHeads` on every file, collect the ids of files
  that returned null, read their earlier versions in one batched `listPublishedVersions` call per locale, then run
  `classifyEarlier`.

- [ ] **Step 1: Failing tests.** published / pending / behind / hand work in that precedence (a file equal to both
  the draft head and an earlier version is `pending`, because `classifyHeads` returns it first); a file
  without `prev` vs a head with `prev: { label }` is `published`, and after English re-enables the link the same file
  is still `published` (R9-1/R10-1); a file with `prev: {}` equals absent; a file whose `prev` differs from the head is
  `hand work`; CRLF/BOM/formatting differences never change the class (they are gone after Task 7's read).
- [ ] **Steps 2-4** as usual. **Step 5: Commit** `feat(markdown): four-class locale file classification`.

### Task 12: Starlight import, source pages (5.3 source side, 5.5, 5.6 safety stop)

**Files:**
- Create: `packages/markdown/src/starlight/importStarlight.ts`, `packages/markdown/test/starlight/importSource.test.ts`
- Modify: `packages/markdown/src/import.ts:13-21,107` (types; dispatch when `input.starlight` is set),
  `packages/markdown/src/index.ts` (export types `StarlightImportOptions`, `SafetyStop`, `StarlightImportDetails`;
  panel round 4 IC4-4)

**Interfaces:**
- Produces:
  ```ts
  export type StarlightImportOptions = { layout: StarlightLayout; prune?: boolean; acceptNewAndGone?: boolean; restore?: string[]; dryRun?: boolean };
  export type ImportInput = { dir: string; publish?: boolean; starlight?: StarlightImportOptions };
  export type FileOutcome = { file: string; docId: string | null; outcome: "created" | "updated" | "unchanged" | "error" | "skipped"; published: boolean };
  export type SafetyStop = { gone: Array<{ slug: string; title: string | null }>; added: Array<{ file: string; slug: string; title: string | null }>; command: string | null };
  export type StarlightImportDetails = { dryRun: boolean; stop: SafetyStop | null; pruned: string[]; behind: string[]; unsupported: string[] };
  // pruned: slugs; behind and unsupported: project-relative POSIX paths. SafetyStop titles: a gone document's
  // source-locale published `title` (null when none); an added file's front-matter `title` (null when none). Every
  // warning about a key starts with "<key>: " (for example "template: export will write the English value ...");
  // the one warning listing unsupported files has `file` set to the layout's docsDir (panel round 6 ED6-8, agy ED-1/2).
  export type ImportReport = { files: FileOutcome[]; warnings: FileMessage[]; errors: FileMessage[]; starlight?: StarlightImportDetails };
  // starlight/importStarlight.ts (internal; importFolder dispatches to it when input.starlight is set):
  async function importStarlight(ctx: Ctx, input: ImportInput & { starlight: StarlightImportOptions }): Promise<ImportReport>;
  ```
  In Starlight mode `dir` is the project root. The generic path is untouched; `"skipped"` occurs only in Starlight mode.
- Consumes: Tasks 3, 4, 5, 6, 7, 8, 10; core `createDocument`, `saveDraft`, `publish`, `deleteDocument`,
  `listDocuments`, `getDocuments`.

- [ ] **Step 0: State check**: `importFolder` starts at `import.ts:107` with the signature `(ctx, input: ImportInput)`
  and `ImportInput` is `{ dir: string; publish?: boolean }` (`import.ts:13`). STOP on mismatch.
- [ ] **Step 1: Failing tests** (database, fixture layout):
  - "no source file at all": `ValidationError(/no source file/)`; with `prune: true` the same, and nothing deleted.
  - "English is always published": a new page is created and its shared and `en` scopes published without
    `publish`; a changed page is saved and published; an unchanged page (its PUBLISHED head equals the file) is
    `unchanged` with no new row; a page whose draft head equals the file but is not published is published.
  - "a new draft: true page is skipped; an existing one is imported": outcome `skipped`, no document; an existing
    page that turns `draft: true` is updated and published (`draft` is a shared field).
  - "the canonical form is stored": English body image `img.png` stores `./img.png`; the English file is unchanged on
    disk.
  - Safety stop: one page renamed on disk (gone `a`, new `b`): neither created nor pruned, `stop.command` is
    `mogging rename a b`, titles of both sides present, other pages imported, file outcomes for `b` are `skipped`;
    two gone and one new: `command: null`; `acceptNewAndGone: true` creates `b` and keeps `a` live; with `prune: true`
    as well it soft-deletes `a`; a gone page whose new name is a `draft: true` file still stops (5.3).
  - "gone uses published and draft slugs": a document whose draft slug is `b` (interrupted rename) and whose file is
    `b.md` is not gone.
  - Prune without a stop: `prune: true` soft-deletes every live document of the collection with no source file;
    `pruned` lists their slugs.
  - "dry run writes nothing": the same report as the real run (minus document ids of new documents, which are
    `null`), and the database row counts are unchanged.
  - Review Focus 1: `Getting Started.md` creates slug `getting-started`; a second run is `unchanged`.
  - "other Starlight extensions are listed once": `a.markdown` and `b.mdoc` give one warning naming both and appear in
    `starlight.unsupported`; nothing is imported from them.
  - "a source file that cannot be read is never gone" (panel round 2 BS-1): a page whose English file has a
    front-matter error, a page in a slug collision, and pages `guides/a` and `guides/b` under a symlinked folder
    `guides` are not gone: no prune, no safety stop pairing, no rename suggestion; and `prune: true` refuses with
    `ValidationError(/could not be read/)` naming them while any source entry is unreadable, deleting nothing. A new
    `draft: true` page does not block prune; a page whose English file is now `a.markdown` is not gone (FR5-3); a
    symlinked English FILE `b.md` keeps document `b` found; a symlink under `de/` does not block prune.
  - "first run, English only": a fresh database with English files of new pages imports them in one call; the dry
    run reports the same outcomes (the locale half is Task 13's "first run"; panel round 6 ED6-1).
  - "a crash between save and publish is completed" (panel round 6 ED6-4): an English draft head equal to its file
    but never published (simulated with `saveDraft` alone) is published by the next import (outcome `updated`).
  - "heads are read per page of documents": the run issues no per-file `getDocument` (assert with the counting sql:
    the query count for 10 and for 40 unchanged pages is equal).
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement** phase 1 (scan; read source files; list the collection's documents with
  `listDocuments(includeDeleted: false)` pages of 200 and `getDocuments` per page; compute created/updated/unchanged,
  gone, new, stop, prune) and phase 2 (one transaction per page as `import.ts:277-283` does, then publish; prune with
  `deleteDocument`; a `NotFoundError` there means a concurrent prune already deleted it and is not an error). A
  source document is "found" when the scan saw a source file with its derived slug in ANY state (read, per-file
  error, collision, a file with another Starlight extension (`unsupported`; panel round 4 FR4-6), or a symlink to a
  file, whose slug is derived from its path without following it; all read from `Scan.symlinks` and
  `Scan.unsupported`, panel round 4 IC4-1), and every
  document whose slug lies under a symlinked FOLDER (its derived slug is a prefix of the document's slug at a `/`
  boundary) counts as found (panel round 3 FR-1). Prune refuses while any SOURCE-LOCALE entry is UNREADABLE: a
  per-file error, a collision, or a listed symlink (a locale folder's symlink or an asset symlink never blocks prune;
  panel round 5 FR5-2); a skipped new `draft: true` page is not unreadable (FR-2). A
  `LicenceError` aborts the run as in `import.ts:264`. Add one own-folder test (`layoutOwn`): a new page and a changed
  page.
- [ ] **Step 4: Tests, typecheck, suite.** PASS, and every existing `import.test.ts` test passes unchanged.
- [ ] **Step 5: Commit** `feat(markdown): Starlight import of source pages with the rename safety stop and prune`.

### Task 13: Starlight import, locale files (5.3 day one, 5.4 import side, 5.9 draft rule and report)

**Files:**
- Modify: `packages/markdown/src/starlight/importStarlight.ts`
- Test: `packages/markdown/test/starlight/importLocale.test.ts`

**Interfaces:** as Task 12; consumes Task 7's `readStarlightFile`/`splitPage`, Task 8's rebasing, Task 11's `classifyHeads`/`classifyEarlier`, Task 4's
`listPublishedVersions` (one call per locale with the ids of files that matched neither head).

- [ ] **Step 1: Failing tests.**
  - Day one: a German file for a page with no German row of any state is saved `untracked` and published without
    `publish`; `getSyncState` reports its fields `untracked`. A German row in `DRAFT_AI` makes the next German file
    take the normal path (5.3).
  - Classes: `published`, `pending` and `behind` files produce no row (`behind` listed in `starlight.behind`);
    `hand work` is saved as a human draft and published only with `publish`; a replaced `DRAFT_AI`/`APPROVED` draft
    keeps today's warning text (`import.ts:365`).
  - Review Focus 3 / R10-1: a hand-work German file without `prev` while the head has `prev: { label: "Zurück" }`
    saves a draft that still holds that `prev`.
  - Draft rule: English `draft` absent, German file `draft: true` and different content: saved unpublished even on
    day one and with `publish`, reported; with the flag removed the next `import` with `publish` publishes the
    pending draft (`import.ts:373-379` behaviour); a German file that only carries English's own `draft: true` is not
    a locale draft; a `published` file with locale `draft: true` gets the report with "run `mogging unpublish
    --locale` to withdraw it".
  - Follows-English report: German `template: splash` while English has `doc`, once per file and key, text
    "export will write the English value the next time it writes this file"; equal values silent; a German-only
    unmapped key warns "not mapped by the layout; export drops it when it rewrites this file"; this replaces the
    generic warning, which does not appear in Starlight mode.
  - Union toggles: English `prev: false` and a German file with `prev: "Zurück"` store the German label and report
    `prev` once ("export will write the English value ..."); English `prev: "Back"` and German `prev: false` report it
    the same way.
  - "first run" (moved from Task 12, panel round 2 TO-5 / round 6 ED6-1): a fresh database with English, `de/` and
    `zh-cn/` files of new pages imports all of them in one call (German and Chinese as day-one, published,
    untracked); the dry run of the same tree reports the same outcomes.
  - Day one under the locale-draft rule: a German `draft: true` file with no German row is saved `untracked` and NOT
    published (panel round 6 ED6-5).
  - Orphans: a German file whose slug has no live document is a warning, not an error.
  - `restore: ["src/content/docs/de/a.md"]` saves that `behind` file as a human draft; on a `published` file it
    reports "already current" and writes nothing.
  - Review Focus 1: `de/getting-started.md` next to English `Getting-Started.md` is the same page.
  - References: a German hero image `../../../assets/h.webp` is stored canonical `../../assets/h.webp`.
  - Not day one (panel round 2 BS-4): after a `de` AI draft is rejected (no `de` head left) a hand-written German file
    is saved as an unpublished human draft (published only with `publish`); the same after `unpublish` of `de`.
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement**, per locale file, in this order: (1) skip with a warning when its slug has no live
  document, where live includes documents this run creates (or, in a dry run, would create) (outcome `skipped`); (2) read and split it, un-rebase `fileRefs` and the body to canonical; (3) classify
  against the heads (from Task 12's page reads) and, only for files matching neither, the earlier versions
  (`listPublishedVersions` per locale, ids in chunks of 1000). The English path used to un-rebase (step 2) is the
  scanned source file with the same derived slug in this run; when there is none (the English file is missing or
  unreadable), it is the path the English file would have (the locale file's `rel` under the source location), so
  canonical values stay relative to the English page's place (panel round 6 ED6-3); (4) `--restore` overrides `behind`/`published`
  (save as a human draft; "already current" when `published`); (5) the follows-English report (union toggles and
  `draft` included); (6) the locale-draft rule (file `draft: true`, English not); (7) for `hand work`, carry a
  suppressed union value forward from the current head, then save: `untracked` and published when the locale has no
  row of any state (`listLocaleRows`, one call per page of documents; day one) unless rule 6 applies; otherwise a human draft, published only with `publish` and never
  under rule 6 (a day-one file under rule 6 is saved `untracked` and left unpublished; ED6-5); (8) with `publish`, a
  `pending` file whose draft head is a `DRAFT_HUMAN` equal to it, and which rule 6 does not hold back, is published
  (`import.ts:373-379` behaviour; panel round 6 ED6-2). Outcomes: no row written and nothing published ->
  `unchanged`; a row written or a draft published -> `updated`; skipped -> `skipped`; read or save failure -> `error`.
- [ ] **Step 4: Tests, typecheck, suite.** Add one own-folder test (`layoutOwn`): day one and a hand edit.
- [ ] **Step 5: Commit** `feat(markdown): Starlight import of locale files (day one, classes, draft rule)`.

### Task 14: Starlight export, writing files and the manifest

**Files:**
- Create: `packages/markdown/src/starlight/exportStarlight.ts`, `packages/markdown/src/starlight/manifest.ts`,
  `packages/markdown/src/starlight/fsSafe.ts`, `packages/markdown/test/starlight/export.test.ts`,
  `packages/markdown/test/starlight/manifest.test.ts`
- Modify: `packages/markdown/src/export.ts:10-11,133` (types; dispatch), `packages/markdown/src/index.ts` (export
  types `StarlightExportOptions`, `ExportAction`, `StarlightExportDetails`)

**Interfaces:**
- Consumes (agy round 5 F1): Task 4 `getDocuments`, `listPublishedVersions`; Task 6 `deriveSlug`, layout maps;
  Task 7 `readStarlightFile`, `splitPage`, `readAstroFrontMatter` (`./frontMatter.js`); Task 8 `rebaseTree`,
  `rebaseValueAt` (`./rebase.js`); Task 9 `renderLocaleFile` (`./render.js`); Task 10 `scanDocs` (`./scan.js`);
  Task 11 `classifyHeads`, `classifyEarlier`, `sameLocalized` (`./classify.js`); core `listDocuments`.
- Produces:
  ```ts
  export type StarlightExportOptions = { layout: StarlightLayout; dryRun?: boolean; starlightLocaleDirs?: string[] | null };
  export type ExportInput = { dir: string; collections?: string[]; locales?: string[]; starlight?: StarlightExportOptions };
  export type ExportAction = { action: "write" | "keep" | "remove" | "skip" | "refuse" | "move"; path: string; to?: string; reason: string };
  export type StarlightExportDetails = { dryRun: boolean; actions: ExportAction[]; attention: FileMessage[] };
  export type ExportReport = { files: string[]; warnings: FileMessage[]; starlight?: StarlightExportDetails };
  // starlight/exportStarlight.ts (internal; exportFolder dispatches to it when input.starlight is set):
  async function exportStarlight(ctx: Ctx, input: ExportInput & { starlight: StarlightExportOptions }): Promise<ExportReport>;
  type ManifestEntry = { path: string; slug: string; locale: string; version: number; sha256: string };  // internal
  // manifest.ts (internal; Tasks 15 and 16 use these):
  function readManifest(root: string): { entries: ManifestEntry[]; warning: string | null };
  function writeManifest(root: string, entries: ManifestEntry[]): void;
  // fsSafe.ts (internal; Tasks 15 and 16 use these; every path is project-relative POSIX):
  function assertNoSymlink(root: string, rel: string): void;            // throws on a symlinked component below root
  function writeFileAtomic(root: string, rel: string, text: string): void;
  function moveFile(root: string, from: string, to: string): void;     // one rename; parents created
  function removeFile(root: string, rel: string): void;
  ```
  `attention` holds exactly the exit-4 causes of spec 5.4 (a `pending` or `hand work` file left, except a pending
  locale `draft: true` file; a symlink refusal; a live document whose English file is missing or cannot be read
  (Task 7 per-file error; panel round 1 CA-4); a locale whose folder is not in `starlightLocaleDirs` when that list
  is given; a page skipped because a stored MDX block does not parse; a page skipped because its body does not
  survive a change of extension (`.md` <-> `.mdx`, below; an addition to spec 5.4's list, recorded in its erratum,
  panel round 4 FR4-3)).
  The keep test ("same parsed content", spec 5.4), without rendering (panel round 2 FR-1): a file is kept when it
  classifies `published` (so its localized content, body included, already equals the head in canonical space) AND
  its follows-English front matter equals what export would copy: both the file and the English file are read with
  Astro's options (F-YAML, so a plain date and a quoted one differ), the localized mapped paths and union value forms
  are removed from both, the file's top-level keys that English lacks and the layout does not map are removed, and the
  rest is deeply equal (a `Date` compared by time) with each union toggle equal, where a toggle of `true` and an
  absent toggle are the same (spec 5.9: `true` means the generated link, as absent; export writes no key for it;
  panel round 5 ED-2; the Task 9 round-trip test compares toggles the same way). A kept file is never rendered and so
  never re-parsed. Comparisons of body trees (classification and self-check) ignore the root's `mode`; export stamps
  the stored tree with the mode of the extension it writes, and when that mode differs from the stored tree's (an
  English `.md` <-> `.mdx` change) a rendered body that does not re-parse to the same tree in the new mode (`{` or
  `<` in an md body written as mdx; an ESM or JSX block in an mdx body written as md) skips the page into
  `attention` instead of failing the self-check (panel rounds 2 CA-1 and 3 FR-4); the self-check's internal error
  stays for a mismatch with an unchanged mode.
  The manifest lists every file export wrote AND every file it kept as `published` (spec 5.4), with the SHA-256 of
  the bytes on disk; entries for files this run did not evaluate (a locale skipped or filtered out, a page whose
  English file is missing or unreadable, a refused symlink, an MDX skip) are carried over unchanged; entries are
  dropped only for files this run evaluated and classified `pending`/`hand work`, or removed (panel round 2 BS-2).
  `input.collections` is ignored in Starlight mode (one collection); `input.locales` restricts the locales evaluated.
  At the start of a run, files named `*.<hex>.mogging-tmp` under `<docsDir>` and `.mogging/` (found with `lstat`, not
  followed) are leftovers of an interrupted run: they are unlinked without following (a symlinked leftover loses
  only the link, never its target; panel round 5 ED-4) and each is reported in `warnings` (panel round 2
  BS-6); a real run AND a dry run list them as `remove` actions (so the two runs' actions stay equal), and a dry run removes
  nothing (panel rounds 3 FR-5 and 4 FR4-1). A self-check failure throws `Error("internal: export self-check failed for <path>: <field>")`.
  Manifest file: `{"version":1,"files":[` newline, one compact JSON entry per line sorted by `path`, `]}` newline;
  written to a temporary file in `.mogging/` and renamed.

- [ ] **Step 0: State check**: `exportFolder` starts at `export.ts:133` and `ExportInput`/`ExportReport` are as
  `export.ts:10-11`. STOP on mismatch.
- [ ] **Step 1: Failing tests.**
  - Completeness: German published head without `title` -> no file, action `skip` reason `incomplete`, exit cause
    none; splash page with empty English body needs no German body; English `hero` present and German without
    `hero` -> skip.
  - Writes: a new German file under the English name and extension; `files` and the manifest list it with the
    SHA-256 of its bytes and the published version; `pending` and `hand work` files are never listed (5.4).
  - Locale-only keys: a German `published` file holding an unmapped key English lacks keeps it while kept byte for
    byte, and loses it when English changes and the file is rewritten.
  - Keep: a day-one German file (`published`) with its own formatting is kept byte for byte; after English changes
    `sidebar.order` it is rewritten with its German text unchanged.
  - Behind / pending / hand work: `behind` rewritten and reported; `pending` and `hand work` untouched, in
    `attention`; a pending locale `draft: true` file untouched and NOT in `attention`.
  - Self-check: a serializer fault (a `vi.mock` of `../../src/starlight/render.js` whose `renderLocaleFile` wraps the
    real one and deletes the `description:` line) throws the internal error and leaves the target file unchanged.
  - Never English: the English files' bytes and mtimes are unchanged by any export.
  - Missing English: a live document whose English file is gone -> its locale files are skipped, in `attention`,
    and not recreated elsewhere.
  - Extension change: English `a.md` -> `a.mdx`, manifest-listed `de/a.md` classified `published` -> written as
    `de/a.mdx`, `de/a.md` removed; an unlisted `de/a.md` -> both left, reported.
  - Day-one name: `de/getting-started.md` (published) next to English `Getting-Started.md` -> moved with one
    `fs.renameSync` to `de/Getting-Started.md`, then written (move first, so a case-insensitive file system never
    deletes the file it just wrote; panel round 1 F7); `de/Getting Started.md` (same derived slug, a name that
    differs beyond case) next to English `Getting-Started.md` -> written as `de/Getting-Started.md` and the old file
    removed; when the old file is `hand work`, both are left and reported.
  - Kept files are listed: after a day-one import, an export that keeps the German file lists it in the manifest
    with the SHA-256 of its unchanged bytes (panel round 1 F3/PP-2); a second unchanged export leaves the manifest
    byte for byte.
  - Toggle `true` (panel round 6 FR6-3): English `prev: true` and a German file without `prev` -> kept byte for byte on
    every export; a symlinked leftover `de/a.md.0a1b.mogging-tmp -> ../../secret.txt` is unlinked and `secret.txt`
    still exists.
  - Keep rule edges: English changes `lastUpdated` from plain to quoted -> the German file is rewritten; a German
    file whose stored ESM block does not parse but which is kept is not re-parsed and is not in `attention`.
  - Case-only rename: English `Foo.md` -> `foo.md` with `de/Foo.md` -> one rename to `de/foo.md`, then written.
  - Symlinks (Review Focus 4): a symlinked `de` folder, target file, `<docsDir>` or `.mogging` folder -> `refuse`, in
    `attention`, nothing written through it; a pre-existing `de/a.md.<anything>.mogging-tmp` symlink is never written
    through.
  - Own-folder mode (`layoutOwn`): a new German file and a day-one name adoption.
  - Locale skip: `starlightLocaleDirs: ["de"]` -> no `zh-cn` file, in `attention`; `null` -> written as configured.
  - MDX: a German body holding a stored `mdxjsEsm` block that does not parse (saved through the SDK) -> that page
    skipped, its existing file and manifest entry unchanged, in `attention`, the rest exported; the same under
    `layoutOwn` (D11; panel round 2 FR-2 / agy F1).
  - Mode: English `a.md` -> `a.mdx` with a German body that is valid Markdown and valid MDX -> `de/a.mdx` written,
    self-check passes; with a German body holding `{x}` -> skipped into `attention`, `de/a.md` untouched; English
    `b.mdx` -> `b.md` with a German body holding `import X from "./x.astro"` -> skipped into `attention`, no internal
    error.
  - Manifest carry-over: an export with `locales: ["de"]` keeps every `zh-CN` entry; a page whose English file was
    deleted keeps its locale entries.
  - Leftovers: a `de/a.md.0a1b.mogging-tmp` file is removed and reported at the next run; a dry run lists it and
    leaves it.
  - Crash (Review Focus 5): after writing one file, a thrown error from the second `fs.renameSync` (spy) leaves the
    first file whole and the second's old content whole; the next run classifies the first `published` and keeps it.
  - Dry run: `actions` equal to the real run's, no file or manifest written.
  - Manifest: a corrupt manifest gives one warning and is treated as empty (D9).
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement.** Heads come from `listDocuments({ limit: 200 })` pages + `getDocuments` (no per-file
  read; the default limit is 50, `resolve.ts:203`; panel round 5 ED-3); earlier
  versions from one `listPublishedVersions` per locale for the divergent files. The English file of each document is
  the scanned source file whose derived slug equals the published shared slug. Every target path is computed from
  the English file's `rel`, the locale folder and `docsDir`, and checked with `path.resolve` to stay inside
  `<root>/<docsDir>`; `fsSafe` checks with `lstat` every existing path component below the project root (so
  `<docsDir>`, the locale folder, the target and `.mogging/` are covered; the project root and its ancestors are not),
  creates `<target>.<random hex>.mogging-tmp` with `fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)`,
  writes, closes, then renames over the target. When an old path and its replacement differ only by letter case,
  the old file is renamed to the new name first. Earlier versions are read with `listPublishedVersions` per locale
  in chunks of 1000 ids. The manifest is written after all files, the same way.
- [ ] **Step 4: Tests, typecheck, suite.** PASS, and every existing `export.test.ts` test passes unchanged.
- [ ] **Step 5: Commit** `feat(markdown): Starlight export with classification, self-check and manifest`.

### Task 15: export removals (5.5)

**Files:**
- Modify: `packages/markdown/src/starlight/exportStarlight.ts`; Test: `packages/markdown/test/starlight/exportRemove.test.ts`

- [ ] **Step 1: Failing tests.** A manifest-listed German file whose bytes match the manifest is removed when its
  document is soft-deleted, and when its German translation is unpublished; a listed file whose bytes changed is
  left and reported; an unlisted file is never removed; a manifest entry whose slug no document of the database has
  (live or deleted) removes nothing and is reported (a fresh database); an entry whose path fails validation is
  ignored with a warning (Review Focus 4). Validation (panel round 2 BS-3; the English file is usually gone when its
  document is deleted): the entry's path must resolve inside `<docsDir>`, its first folder below `<docsDir>` must be
  the layout's folder for `entry.locale` (looked up with `Object.hasOwn`), its extension `.md`/`.mdx`, and
  `deriveSlug` of the rest must equal `entry.slug`; tests: `../../etc/passwd`, another locale's folder, and a valid
  path whose slug differs, each with a deleted document's slug; and a prune-then-export run that removes the German
  file of the pruned page; a file never becomes removable because English changed; a hand-deleted listed file of a live
  published translation is recreated with a warning.
- [ ] **Steps 2-4.** Deleted documents are found with `listDocuments({ includeDeleted: true, limit: 200 })` in a
  loop over `next` until it is null (panel round 1 F4; the default limit is 50).
- [ ] **Step 5: Commit** `feat(markdown): Starlight export removes only manifest-listed, unchanged, withdrawn files`.

### Task 16: `renamePage` (5.6)

**Files:**
- Create: `packages/markdown/src/starlight/rename.ts`, `packages/markdown/test/starlight/rename.test.ts`
- Modify: `packages/markdown/src/index.ts`, `packages/markdown/test/api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RenameInput = { dir: string; layout: StarlightLayout; from: string; to: string; dryRun?: boolean };
  export type RenameReport = { dryRun: boolean; actions: ExportAction[]; references: Array<{ file: string; line: number; text: string }>; reminder: string };
  export async function renamePage(ctx: Ctx, input: RenameInput): Promise<RenameReport>;
  ```
- Consumes (panel round 6 ED6-7, agy ED-3): Task 4 `getDocuments`; Task 5's guard through core `saveDraft`/`publish`;
  Task 6 `deriveSlug`; Task 7 `readStarlightFile`, `splitPage`; Task 10 `scanDocs`; Task 11 `sameLocalized`; Task 14
  `readManifest`, `writeManifest`, `moveFile`, `assertNoSymlink` (`./manifest.js`, `./fsSafe.js`); core
  `getDocument`, `saveDraft`, `publish`. Every `ExportAction` it returns has `action: "move"` and `reason: "rename"`.
  Errors: `ValidationError` for a `to` that is not a derived-form slug (`deriveSlug` of itself plus an extension
  must equal itself), whose last segment starts with `_` (the scan would skip it; agy round 2 F2), or that leaves
  `<docsDir>`, a depth change when the page or any translation holds a relative file
  reference, an unknown `from`; core's `ValidationError` for a duplicate slug; `ConflictError` when a move target
  exists with different parsed content (naming both files).

- [ ] **Step 1: Failing tests.** The whole shared head is saved with only the slug changed and published (other
  shared fields kept); the English file and every German/Chinese file move, the manifest follows; a `git mv` done
  first is fine; an interrupted rename (database done, files not) completes on re-run found by `to`; a re-run after
  completion is a no-op; a differing existing target -> `ConflictError`, nothing moved; dry run checks uniqueness
  with a read and changes nothing; `references` lists each line of `astro.config.mjs` and of Markdown under
  `<docsDir>` containing the old slug; `reminder` mentions redirects; a depth change with a relative image is
  refused; a case-only rename on the English file moves in one rename; `to: "guides/_old"` is refused; one own-folder
  rename (`layoutOwn`). API test
  adds `renamePage`.
- [ ] **Step 0: State check**: `getDocument` by slug (`resolve.ts:156-170`) still returns a deleted document only
  after live ones. STOP on mismatch.
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement** in this order (panel round 6 ED6-6): (1) validate `to`; find the document live by `from`,
  else live by `to` (a re-run); unknown -> `ValidationError`; (2) scan, and plan every move: the English file (from
  the path whose derived slug is `from`, unless a file with slug `to` already exists, as after a `git mv`) and each
  locale file under the old path; a target that exists is acceptable only when it is the same file or has the same
  parsed content (`sameLocalized` of both files' localized fields, both bodies included), otherwise
  `ConflictError` BEFORE any database write; refuse the depth change rule here too; (3) database: when the shared
  published head's slug is not `to`, save the whole shared head with only the slug changed and publish it; when a
  shared draft head already holds `to` but is not published (an interrupted run), publish it; (4) move the files
  with `moveFile`; (5) manifest: every entry whose slug is `from` gets slug `to` and the path it now has (also for a
  file the user moved with `git mv`); (6) search `astro.config.*` and Markdown under `<docsDir>` for `from`; build
  the report. A dry run stops after (2) and reports the planned moves, with uniqueness checked by a read.
- [ ] **Step 4: Tests, typecheck, suite.** Add: an interrupted run whose shared draft holds `to` unpublished is
  completed; a `git mv`-ed English file leaves the manifest entries renamed.
- [ ] **Step 5: Commit** `feat(markdown): renamePage keeps a document and its translations`.

### Task 17: query bound and the 2,000-page measurement

**Files:**
- Create: `packages/markdown/test/starlight/queries.test.ts`, `packages/markdown/test/starlight/perf.test.ts`

- [ ] **Step 1: Failing test** "an unchanged re-export issues a query count independent of the page count":
  fixtures of 50, 150, 250 and 450 pages x 2 locales, imported and exported once, then a second export counted with a
  postgres.js `debug` callback: 50 and 150 (one page of 200 documents) give equal counts, and the count grows by the
  same amount from 250 to 450 as from 50 to 250 (per page of documents, never per file; panel round 4); the same for
  an unchanged re-import.
- [ ] **Step 2-4.** Fix any per-file read the test exposes.
- [ ] **Step 5: Measurement (CONTROLLER ONLY, never a subagent; owner's timing discipline).** `perf.test.ts` is
  skipped unless `MOGGING_PERF=1` (as `packages/ai/test/live.test.ts` is gated); it generates 2,000 pages x 6
  locales in a temp project, runs import and export twice each, and prints wall time and query counts per run. Run
  with `MOGGING_PERF=1 pnpm --filter @mogging/markdown test perf` (no `--`). The controller runs it backgrounded on an idle machine with no other tool calls until it
  finishes, twice, and records the warm range and the uncontrolled background load in the plan's execution ledger.
- [ ] **Step 6: Commit** `test(markdown): Starlight import/export query count is independent of page count`.

---

## Execution notes

- Baseline: measure `pnpm test` on the branch point before Task 1 and record "N passed / 1 skipped".
- Order: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17. Tasks 1 to 5 are independent of each other except
  for `api.test.ts` edits; run them sequentially.
- Every implementer brief carries the Step 0 state check, the shape-divergence stop for the interfaces above, the
  named oracle (the tests listed in the task and the cited spec lines), and the exact commands of Global
  Constraints.
- After Task 17: whole-branch review, AGY-CAPSTONE on the range, AGY-TEST-AUDIT, owner's merge decision. Plan 6b is
  written only after the merge.

## Self-audit (2026-11-17)

- Spec coverage. 5.2 layout, slugs, `_` files, index, extensions, locale map: Tasks 6, 10. 5.2 the static
  `astro.config` read, `init`, CLI exit mapping: 6b. 5.3: Tasks 3, 12, 13. 5.4 classification, export, manifest, exit
  causes, dry run: Tasks 11, 13, 14, 15. 5.5: Tasks 12, 15. 5.6: Tasks 12 (safety stop), 16 (rename); the CLI command
  is 6b. 5.7: documentation, 6b README. 5.8: Tasks 1, 7, 9 (R1). 5.9: Tasks 2, 7, 8, 9, 11, 13. 6 package/preset/
  integration: 6b; performance: Tasks 4, 12, 14, 17. 7 template and fixtures: 6b. 8: Task 5.
- Open items left on purpose, each with its place: CLI exit-code mapping of the report fields (6b); `track` for a
  whole collection (6b checks, spec ledger round 1 AX3); the preset's final field names (6b moves the Task 6 test
  fixture into `@mogging/starlight`).
- Line citations were read on main 256726f; tasks that modify a cited region carry a Step 0 state check.

## Review ledger

- Panel round 1 (2026-11-17; persona relentless-adversarial-auditor; Sonnet solo seats Axiom Breaker, Cascade Analyst,
  Literal Implementer, Protocol Pedant, Boundary Smuggler: 23 findings; agy seats Axiom Breaker, Cascade Analyst,
  State Corruptor, Mechanism Gamer, Dependency Cynic, Resource Vampire: 7 findings, 3 overlapping). Every finding
  was verified against the code or by measurement before folding; all FOLDED:
  - AB-1 rebasing strings wrong, own-folder no-op false (measured with `path.posix`): Task 8 strings, D11, spec errata.
  - AB-2 merge keys leak through a cloned English document: Task 9 materializes such documents.
  - AB-3 / LI-3 / F2 clone keeps the core schema (measured: created `title: 2024-01-01` unquoted), delete-then-set
    loses key order: Task 9 re-parses with Astro's options, sets in place, `lineWidth: 0`; Review Focus 2 reworded.
  - CA-1 / F4 1000-id cap vs divergent files; `listDocuments` default limit 50: chunking (Tasks 4, 13, 14), paging (15).
  - CA-2 lock-order test could not fail: chosen ids, concurrency and a `pg_locks` assertion (Task 5).
  - CA-3 estimate counted unsent leaves: `estimateJob` uses `wireValue` (Task 2).
  - CA-4 unreadable English file: an `attention` cause (Task 14).
  - CA-5 own-folder mode untested end to end: `layoutOwn` tests in Tasks 12 to 16.
  - LI-1 `isTranslatable` line 27, LI-2 `withFixedLeaves` defined against the wire projection (Task 2).
  - LI-4 keep rule undefined: defined in Task 14's interface.
  - LI-5 helpers created in Task 6; LI-6 hoist `pairOf` (Task 4); LI-7 Task 13 Step 3; LI-8 perf as a gated test.
  - PP-1 NFC in `deriveSlug`; PP-2 / F3 kept files listed in the manifest; PP-3 kept files never re-parsed (Task 14).
  - BS-1 symlinked `<docsDir>`/`.mogging`, exclusive no-follow temp files (Task 14); BS-2 own-key lookups (D12);
    BS-3 alias bomb wrapped (Task 7); BS-4 locale folders matched by slugified name, warning for locale-shaped
    folders (Task 10).
  - F1 the json test moved to the context path (Task 1); F5 prune tolerates a concurrent delete (Task 12); F6
    `publishWithinTx` reads the collection (Task 5); F7 move before write on case-only differences (Task 14).
  - Anomaly (outside the plan): core readers hard-code the key `slug`; logged in `.clavity/local-anomalies.md`,
    D10 keeps Starlight mode inside it.

- Panel round 2 (2026-11-17; Sonnet solo seats Fold Regression, Test Oracle Auditor, Blindspot Auditor, Activation
  Auditor, Axiom Breaker, Cascade Analyst: 16 findings; agy seats Fold Regression, Test Oracle Auditor, State
  Corruptor: 3 findings, 1 overlapping). Verified (yaml/regex/JS probes, `rejectDraft.ts:52`, `resolve.ts:172`,
  `contentFile.ts:23`); all FOLDED:
  - BS-1 prune could delete a page whose file exists but failed to read: "found" counts every source entry; prune
    refuses while any is unreadable (Task 12).
  - FR-1 keep rule needed rendering: keep = `published` class + follows-English equality, no render (Task 14).
  - FR-2 / agy F1 stale "non-zero depth difference" (Task 14); FR-3 trailing comment wording (Task 9).
  - TO-1 nested images untested (Task 8); TO-2 `.mdoc` (F-GLOB, Task 10); TO-3 private `estimateJob` and an
    impossible `pg_locks` read (Tasks 2, 5); TO-4 shortest form for every `stringAs` entry (Task 9); TO-5 first run
    with new pages and locale files (Tasks 12, 13).
  - BS-2 manifest carry-over and the `locales` filter; BS-6 leftover temp files (Task 14); BS-3 removal path
    validation without the English file (Task 15); BS-4 day one needs an any-state read: `listLocaleRows` (Tasks 4,
    13); BS-5 Astro-vs-Mogging front-matter divergence (D6).
  - AX-1 `__proto__` in json values (Task 1); CA-1 body `mode` after an extension change (Task 14).
  - agy F2 rename to a `_` name refused; agy F3 implicit entries exclude slug, body and passthrough (Tasks 16, 6).

- Panel round 3 (2026-11-17, narrow; seats Fold Regression on the round-2 folds and Adopter Walkthrough of design
  section 1; agy CLEAN; Sonnet solo 7 findings + 3 anomalies). Verified (`compile.ts:24`, `context.ts:35-36`,
  `normalize.ts:44-49`, `0001_engine.sql:33`); all FOLDED:
  - FR-1 pages under a symlinked folder counted as gone; FR-2 "skipped" ambiguity in the prune guard (Task 12).
  - FR-3 body `mode` ignored in classification (Task 11); FR-4 `.mdx` -> `.md` change skips into `attention`; FR-5 a
    dry run never removes leftover temp files (Task 14).
  - AW-1 a field with nothing to translate is not sent (Task 2); AW-2 `compile` forwards `includeUntracked` (Task 3).
  - Anomaly: `nfcDeep` drops `__proto__` for `richText` too: the refusal moves into `nfcDeep` (Task 1). Anomaly:
    context values carried `translate: false` leaves: they go through `wireValue` (Task 2). Anomaly: no index on the
    shared slug: logged in `.clavity/local-anomalies.md` (a migration change is outside this step, spec 3).

- Panel round 4 (2026-11-17, narrow; seats Fold Regression on the round-3 folds and Interface Consistency Auditor;
  agy CLEAN with a per-fold census, citations spot-checked; Sonnet solo 10 findings + 5 notes). All FOLDED except
  one note stood down below:
  - IC4-1 `Scan.symlinks`; IC4-2 `StarlightFile.frontMatter` and `readAstroFrontMatter`; IC4-3 two-pass
    classification; IC4-4 public types and the manifest/fsSafe signatures (Tasks 7, 10, 11, 12, 14).
  - FR4-1 temp-file actions equal in real and dry runs; FR4-2 richText `__proto__` test; FR4-3 the extension-change
    skip is an `attention` cause (spec 5.4 erratum); FR4-4 list items never dropped by `wireValue`; FR4-5 the
    estimate skips unsent fields; FR4-6 files with another Starlight extension count as found (Tasks 1, 2, 12, 14).
  - Notes: "three bulk reads", `read/versions.ts`, `normalize.ts:11-32`, `compile.test.ts`, and the Task 17 test
    now crosses page boundaries.

- Panel round 5 (2026-11-17, narrow; seats Fold Regression on the round-4 folds and Executor Dry Run of Tasks 7, 11,
  14; Sonnet solo 9 findings + 5 notes; agy 3 findings, its reply flagged ECHO MISSING because it quoted the last
  line without its backticks: each agy finding was verified against the plan before folding). All FOLDED:
  - FR5-1 folder slugs without extension stripping; FR5-2 `Scan.symlinks`/`unsupported` carry locale and a
    locale-relative slug, only source-locale entries block prune; FR5-3 tests for those folds (Tasks 2, 10, 12).
  - ED-1 `sameLocalized` takes `col`; ED-2 toggle `true` equals absent in the keep test and round trip; ED-3
    `listDocuments` limit 200 in export; ED-4 leftovers unlinked without following; ED-5 empty remainder gives no
    `extra` (Tasks 7, 9, 11, 14).
  - agy F1 `importStarlight`/`exportStarlight` signatures and Task 14's Consumes; F2 toggles saved in `shared`; F3
    union fields come from `layout.entries` (Tasks 7, 11, 12, 14).
  - Notes: `jobs.ts:79,90`, `normalize.ts:11-32`, the richText `__proto__` test moved into Task 1 Step 1.

- Panel round 6, the cap (2026-11-17, narrow; owner asked for it; seats Fold Regression on the round-5 folds and
  Executor Dry Run of Tasks 12, 13, 16; Sonnet solo 11 findings; agy 3 findings, 2 overlapping). All FOLDED:
  - FR6-1 dangling folder symlinks counted as found (by name); FR6-2/FR6-3 tests for the round-5 folds (Tasks 10, 14).
  - ED6-1 the first-run test moved to Task 13; ED6-2 `publish` publishes a pending human draft; ED6-3 the English path
    used to un-rebase; ED6-4 an unpublished English draft equal to its file is published; ED6-5 day one under the
    locale-draft rule stays unpublished (Tasks 12, 13).
  - ED6-6/ED6-7, agy ED-3 Task 16 Consumes, Step 0, ordered Step 3 (conflicts before the database, resume, manifest
    after `git mv`); ED6-8, agy ED-1/ED-2 report value formats and key-prefixed warnings (Task 12).
  Findings per round: 30, 18, 7, 10, 12, 14 (no high after round 2; rounds 4-6 were cross-task gaps and unstated
  formats).

## Stand-downs

- DISCARDED-BELOW-FLOOR (round 4 note): `packages/core/src/read/resolve.ts:185` keys `locales` by locale on a plain
  object; unreachable because every stored locale passed `normalizeLocale`, whose language subtag must match
  `/^[A-Za-z]{2,3}$/` (`packages/core/src/schema/locale.ts:9`), so `__proto__` or `constructor` never occur.
