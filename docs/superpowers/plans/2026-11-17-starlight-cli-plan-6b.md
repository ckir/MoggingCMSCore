# Starlight integration, plan 6b: CLI, package, template and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the adopter-facing half of the Starlight integration: the `mogging` CLI's Starlight mode (`import`,
`export`, `rename`, `init --starlight`, `compile --include-untracked`, a whole-collection `track`), the
`@mogging/starlight` package (no-op Astro integration plus preset), the starter template, the existing-adopter fixture,
and the repository's first CI workflow that runs both with `astro build`.

**Architecture:** The SDK half is merged (plan 6a, main `361f6c3`): `@mogging/markdown` does every file operation. This
plan adds thin CLI layers over it, reads `astro.config.*` statically in the CLI (acorn, never an import), adds a new
package whose root entry imports nothing and whose `./preset` subpath builds the docs collection and layout, and proves
the whole flow outside the repository by installing packed tarballs into a copy of the template and of an
existing-adopter site.

**Tech Stack:** TypeScript (Node >= 22, ESM, NodeNext), pnpm 12 workspace, vitest 5, PostgreSQL, `acorn` 8.19.0, Astro
7.4.4 and `@astrojs/starlight` 0.43.0 (template and fixture only), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-13-starlight-integration-design.md` (APPROVED 2026-11-17, with dated errata).
Ship order: `docs/superpowers/specs/2026-11-13-v01-ship-sequencing-design.md` step 2 (this plan's CI run of the
template is the freeze trigger of step 3). Previous plan: `docs/superpowers/plans/2026-11-17-starlight-engine-plan-6a.md`.

**Design decisions (owner, 2026-11-17, "Accept all", after an agy-first consult, seam
`.clavity/seams/plan6b-forks-first.md`, reply `.clavity/scratch/plan6b-forks/notes.md`, [VERDICT: ALIGNED]):**

- F1. The static `astro.config` reader and `init --starlight` live in `packages/cli`. The CLI has NO runtime dependency
  on `@mogging/starlight`; the config `init --starlight` writes imports `@mogging/starlight/preset` from the adopter's
  `node_modules`. (`@mogging/starlight` is a devDependency of the CLI, for tests only: Task 8.)
- F2. The reader parses with `acorn` 8.19.0 (a direct, exact-pinned CLI dependency). It parses the file as is first;
  only a `.ts`/`.mts` file that fails to parse is retried after `module.stripTypeScriptTypes`, with that call's
  `ExperimentalWarning` suppressed (measured on Node 24.21.0: the call prints `ExperimentalWarning:
  stripTypeScriptTypes is an experimental feature`). Anything that is not a literal is "cannot read statically".
- F3. `mogging.config.ts` exports `export const starlight = <StarlightLayoutInput>`; the CLI validates it with
  `defineStarlightLayout` when the project loads; a bad export is a usage error (exit 2) raised before connecting.
- F4. `@mogging/starlight/preset` exports `starlightPreset(options)` returning `{ collection, layout }`.
- F5. `templates/starlight/` is not a workspace member. CI and a local script pack the five packages and install the
  tarballs into a copy of the template outside the repository.
- F6. The template's `mogging` script loads `.env` with `node --env-file=.env`.
- F7. The acceptance run uses the REAL installed `mogging compile` with an acceptance-only config whose `ai` export is
  a `custom` provider over a mock model (no network, no money).
- F8. `mogging track --collection <c> --locale <l> [--dry-run]` tracks every untracked field of every live document.
- F9. One `.github/workflows/ci.yml` with a Postgres service.
- F10. One plan. agy's addition, adopted: `init --starlight` never prompts; what it cannot read comes from flags.

## Global Constraints

- Node >= 22, pnpm, ESM with `.js` relative imports and `import type` for types (AGENTS.md "Conventions").
- Every database test needs `export DATABASE_URL=postgres://mogging:mogging@127.0.0.1:54329/mogging_test` on the dev
  machine. A `password authentication failed` or `ECONNREFUSED` error is the environment, not a regression.
- Commands: `pnpm --filter <pkg> test <file-filter>`, `pnpm typecheck`, `pnpm test`. **Never insert `--`** after `test`.
  Gate per task: the task's tests pass, `pnpm typecheck` exits 0, and `pnpm test` ends with `Tests  N passed | 2
  skipped` and no `failed` (N = 1609 at `361f6c3` plus the tests this plan has added so far).
- `pnpm test` stays offline: nothing in it may reach the npm registry, a provider or the network. Only the scripts of
  Tasks 10 and 11 install from the registry, and they are not part of `pnpm test`.
- No change to `packages/core/migrations/0001_engine.sql` and no change to `packages/core`, `packages/markdown` or
  `packages/ai` source (spec 3). If a task finds it needs one, it STOPS and reports (`ESCALATE: <what>`), because the
  ship-sequencing escalation rule makes the owner decide.
- JSDoc on every exported function and type (summary, params, returns, throws), in the style of the existing files.
- Each package's `test/api.test.ts` pins its exact runtime surface; a new export is added there in the same task.
- CLI exit codes keep the existing scheme (`packages/cli/src/run.ts:53-58`, `types.ts:27-35`): 0 success, 1 failure
  (needs `error`), 2 usage (`UsageError`), 3 licence, 4 partial. `--json` stays `{ ok, partial, data, ... }` with `ok`
  for exit 0 and 4 (`packages/cli/src/output.ts:86-98`). A usage error is raised before `deps.connect` whenever the
  facts it needs are known before connecting (`project.ts:75-78`).
- Exact pins: `acorn` `8.19.0` (CLI); template and fixture `astro` `7.4.4`, `@astrojs/starlight` `0.43.0`, `sharp`
  `0.35.3`; `@mogging/starlight` peer ranges `@astrojs/starlight: ">=0.43.0 <0.44.0"`, `astro: "^7.2.10"` (Starlight
  0.43.0's own Astro peer range), both optional peers.
- Owner rule: never push, never publish. Writing `.github/workflows/ci.yml` is fine; it first runs when the owner pushes.
- Every implementer brief carries the Step 0 state check (open the cited files and confirm the cited lines before
  editing; `STATE_MISMATCH: <what>` otherwise), the shape-divergence stop for the interfaces below, the named oracle
  (the task's tests and cited spec lines) and these commands.

## Review Focus

The five input classes most likely to bite an adopter that the spec implies but does not spell out. Each has its test
in the owning task.

1. An `astro.config` whose `locales` comes from an imported constant, a spread or a function call: the reader returns
   "cannot read statically" (never a guess, never a throw); import and export warn once and go on; `init --starlight`
   asks for `--locales`. (Tasks 3, 4, 5, 8)
2. The CLI run from a subdirectory, or with `--config` pointing elsewhere: the project root is the config file's folder,
   never the working directory, for the docs folder, the manifest and `astro.config`. (Tasks 2, 4)
3. A `--restore` path typed relative to the working directory, with `./`, or absolute: converted to the
   project-relative POSIX form the SDK matches (`src/content/docs/de/a.md`); a path outside the project is exit 2.
   (Task 4)
4. A generic (non-Starlight) project given a Starlight-only flag or command (`--prune`, `--dry-run`, `rename`): exit 2
   naming the missing `starlight` export, never silently ignored. (Tasks 4, 5, 6)
5. `--locale zh-cn` (Starlight's folder spelling) on `export`: normalized to the declared tag `zh-CN` instead of an
   "unknown locale" usage error (TODO.md plan 6a follow-up: export's `input.locales` is not normalized). (Task 5)

---

## File structure

- `packages/starlight/` (new): `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`,
  `src/index.ts` (no-op integration), `src/preset.ts` (preset), `test/api.test.ts`, `test/integration.test.ts`,
  `test/preset.test.ts`, `README.md`.
- `packages/cli/src/project.ts`, `types.ts`: load and validate the `starlight` export; `Project.root`.
- `packages/cli/src/starlight/astroConfig.ts` (new): the static reader, the locale-folder list and the drift check.
- `packages/cli/src/starlight/initStarlight.ts` (new): `init --starlight` answers, the config text, the version check.
- `packages/cli/src/commands/import.ts`, `export.ts`, `init.ts`, `track.ts`, `compile.ts`, `index.ts`;
  `commands/rename.ts` (new).
- `packages/cli/test/starlightFixtures.ts` (new) and one test file per command change.
- `templates/starlight/` (new): the starter site.
- `scripts/lib/packed.mjs` (new), `scripts/starlight-accept.mjs` (new), `scripts/starlight-adopter.mjs` (new),
  `scripts/fixtures/starlight-adopter/` (new).
- `.github/workflows/ci.yml` (new).
- `package.json` (root scripts), `AGENTS.md`, `README.md`, `TODO.md`.

## Shared interfaces (later tasks rely on these exact names)

```ts
// packages/starlight/src/index.ts
export type MoggingStarlightIntegration = { name: "@mogging/starlight"; hooks: Record<string, never> };
export default function moggingStarlight(): MoggingStarlightIntegration;

// packages/starlight/src/preset.ts
import type { Collection, Field } from "@mogging/core";
import type { StarlightLayoutInput } from "@mogging/markdown";
export type StarlightPresetOptions = {
  collection?: string;                    // default "docs"
  docsDir?: string;                       // omitted from the layout when undefined (layout default src/content/docs)
  sourceDir?: string | null;              // omitted when undefined (layout default: root-locale mode)
  localeDirs?: Record<string, string>;    // omitted when undefined
  otherLocaleDirs?: string[];             // default []
  extraFields?: Record<string, Field>;    // the adopter's own front-matter keys (docsSchema({ extend }))
};
export type StarlightPreset = { collection: Collection; layout: StarlightLayoutInput };
export function starlightPreset(options?: StarlightPresetOptions): StarlightPreset;

// packages/cli/src/types.ts (Project gains two members)
export type Project = { sql; ctx; ai; starlight: StarlightLayout | undefined; root: string; configPath; close() };

// packages/cli/src/starlight/astroConfig.ts
export type AstroLocale = { key: string; lang: string };          // key "root" = no folder; lang defaults to key
export type AstroConfigRead =
  | { ok: true; file: string; docsDir: string; locales: AstroLocale[] | null; defaultLocale: string | null }
  | { ok: false; file: string | null; reason: string };
export function readAstroConfig(root: string): AstroConfigRead;
export function starlightLocaleDirs(read: Extract<AstroConfigRead, { ok: true }>): string[];
export function localeDrift(read: Extract<AstroConfigRead, { ok: true }>, layout: StarlightLayout): string[];
export function astroConfigWarnings(root: string, layout: StarlightLayout):
  { localeDirs: string[] | null; warnings: Array<{ file: string; message: string }> };

// packages/cli/src/starlight/initStarlight.ts
export type StarlightAnswers = {
  source: string; targets: Array<{ tag: string; dir: string }>; sourceDir: string | null; docsDir: string;
  pasteBlock: string | null; warnings: string[];
};
export function starlightAnswers(read: AstroConfigRead, flags: { locales?: string; sourceLocale?: string }): StarlightAnswers;
export function starlightConfigText(answers: StarlightAnswers): string;
export const STARLIGHT_RANGE: { readonly min: "0.43.0"; readonly below: "0.44.0" };
export function starlightVersionWarning(root: string): string | null;
```

---

### Task 1: The `@mogging/starlight` package (no-op integration and preset)

**Files:**
- Create: `packages/starlight/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`,
  `src/index.ts`, `src/preset.ts`, `test/api.test.ts`, `test/integration.test.ts`, `test/preset.test.ts`
- Modify: root `package.json` (`build` and `typecheck` scripts), `pnpm-lock.yaml` (through `pnpm install`)

**Interfaces:** Produces `moggingStarlight`, `MoggingStarlightIntegration`, `starlightPreset`, `StarlightPresetOptions`,
`StarlightPreset` (block above). Consumes `defineCollection` and the field builders of `@mogging/core`, the type
`StarlightLayoutInput` of `@mogging/markdown`.

- [ ] **Step 1: Scaffold the package.** Copy the shape of `packages/markdown/package.json:1-19` and its tsconfig and
  vitest files (`packages/markdown/tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`), with:
  `"name": "@mogging/starlight"`, `"version": "0.0.0"`, `"private": true`, `"exports": { ".": "./src/index.ts",
  "./preset": "./src/preset.ts" }` and the `publishConfig.exports` equivalent for `dist` (`./dist/index.js`,
  `./dist/preset.js` with their `.d.ts`), no `main`; `"dependencies": { "@mogging/core": "workspace:*",
  "@mogging/markdown": "workspace:*" }`; `"peerDependencies": { "@astrojs/starlight": ">=0.43.0 <0.44.0", "astro":
  "^7.2.10" }` with `"peerDependenciesMeta"` marking both `optional: true` (so pnpm's peer auto-install fetches
  nothing); devDependencies `@types/node ^22`, `typescript ^5`, `vitest ^5`; `prepack` as markdown's. Root
  `package.json`: append `&& tsc -p packages/starlight/tsconfig.build.json` to `build` and `&& tsc --noEmit -p
  packages/starlight` to `typecheck`. Run `pnpm install`.
  Verify: `ls node_modules/.pnpm | grep -cE '^(astro|@astrojs\+starlight)@'` prints `0` (no peer was installed).
- [ ] **Step 2: Write the failing tests.**
  `test/api.test.ts`: `Object.keys(await import("../src/index.js")).sort()` equals `["default"]`;
  `Object.keys(await import("../src/preset.js")).sort()` equals `["starlightPreset"]`.
  `test/integration.test.ts`:
  - "the default export is a no-op integration named @mogging/starlight": `moggingStarlight()` `toEqual({ name:
    "@mogging/starlight", hooks: {} })`, and two calls return distinct objects.
  - "the root entry imports nothing at run time": read `src/index.ts`; every line matching `/^\s*import\b/` also
    matches `/^\s*import type\b/`; the text has no `require(` and no `import(`.
  - "loading and calling the root entry prints nothing": spy `console.log/info/warn/error/debug` and
    `process.stdout.write`/`process.stderr.write`; `await import("../src/index.js")` with `vi.resetModules()` first,
    call the default; every spy has 0 calls.
  `test/preset.test.ts`:
  - "the preset's collection equals plan 6a's fixture collection": `starlightPreset().collection` `toEqual` `docs`
    imported from `../../markdown/test/starlight/fixtures.js` (the field list of `packages/markdown/test/starlight/
    fixtures.ts:14-35`; the preset is that draft made public, 6a plan line 191-192).
  - "the default layout validates": `defineStarlightLayout(p.layout, defineConfig({ collections: [p.collection],
    locales: { source: "en", chains: { de: ["en"], "zh-CN": ["en"] } } }))` has `docsDir` `"src/content/docs"`,
    `sourceDir` `null`, `localeDirs` `{ de: "de", "zh-CN": "zh-cn" }`, `passthrough` `"extra"`, `requiredWhenSource`
    `["hero"]`, `fileRefs` `["hero.image.file", "hero.image.dark", "hero.image.light"]`, `otherLocaleDirs` `[]`.
  - "options reach the layout": `{ docsDir: "site/src/content/docs", sourceDir: "en", localeDirs: { "zh-CN": "zh-hans"
    }, otherLocaleDirs: ["fr"] }` gives exactly those values in the validated layout; `p.layout` has no `docsDir`,
    `sourceDir` or `localeDirs` key when the option is undefined (`Object.hasOwn` is false).
  - "extra fields are added and may not collide": `extraFields: { difficulty: text() }` adds `fields.difficulty`;
    `extraFields: { title: text() }` and `extraFields: { extra: json() }` each throw `ValidationError` with message
    `starlightPreset: extra field "<name>" collides with a preset field`.
  - "the collection name option": `{ collection: "handbook" }` gives `collection.name` and `layout.collection`
    `"handbook"`.
- [ ] **Step 3: Run them to see them fail.** `pnpm --filter @mogging/starlight test` - FAIL (modules missing).
- [ ] **Step 4: Implement `src/index.ts` and `src/preset.ts`.** `index.ts` holds only the type and the function (no
  import at all). `preset.ts`: the fields are the fixture's (`fixtures.ts:14-35`) verbatim; the layout is the
  fixture's `layoutInput` (`fixtures.ts:41-52`) except `otherLocaleDirs` (from the option, default `[]`) and the three
  optional keys set only when given; `extraFields` are added after the preset fields, colliding names refused first.
  JSDoc on both exports, naming the 5.8/5.9 mapping the preset encodes.
- [ ] **Step 5: Run the tests, the typecheck and the suite.** `pnpm --filter @mogging/starlight test` PASS;
  `pnpm typecheck` exit 0; `pnpm test` passes (the root vitest `projects: ["packages/*"]` picks the package up).
- [ ] **Step 6: Commit.** `feat(starlight): @mogging/starlight package with a no-op integration and the preset`.

### Task 2: The CLI loads and validates the `starlight` export

**Files:**
- Modify: `packages/cli/src/types.ts:37-43` (`Project`), `packages/cli/src/project.ts:79-98` (`loadProject`),
  `packages/cli/package.json` (devDependency `"@mogging/starlight": "workspace:*"`)
- Create: `packages/cli/test/starlightFixtures.ts`
- Test: `packages/cli/test/project.test.ts`

**Interfaces:** Produces `Project.starlight` and `Project.root` (block above) and the test helpers below. Consumes
`defineStarlightLayout` (`packages/markdown/src/starlight/layout.ts:120`), `starlightPreset` (Task 1).

`starlightFixtures.ts` exports: `starlightDocs = starlightPreset()`; `starlightConfig = defineConfig({ collections:
[starlightDocs.collection], locales: { source: "en", chains: { de: ["en"], "zh-CN": ["en"] } } })`;
`starlightProject(files: Record<string, string>): string` (a fresh `mkdtemp` project root holding `mogging.config.ts`
(empty) and each file at its project-relative path, removed after the test file); `starlightDeps(sql, root, overrides?)`
= `testDeps(sql, { cwd: root, loadModule: async () => ({ config: starlightConfig, starlight: starlightDocs.layout }),
...overrides })`; `ASTRO_ROOT_DE_ZH` = the text of an `astro.config.mjs` declaring `locales: { root: { label:
"English", lang: "en" }, de: { label: "Deutsch", lang: "de" }, "zh-cn": { label: "简体中文", lang: "zh-CN" } }`.

- [ ] **Step 1: Write the failing tests** in `project.test.ts`:
  - "a starlight export is validated at load and exposed with the project root": `loadProject` with `loadModule`
    returning `{ config: starlightConfig, starlight: starlightDocs.layout }` and `cwd` = a project root gives
    `project.starlight.kind === "starlight"`, `project.starlight.localeDirs` `{ de: "de", "zh-CN": "zh-cn" }`,
    `project.root === dirname(project.configPath)`.
  - "--config in another folder makes that folder the project root": `cwd` = `<tmp>/a`, `--config <tmp>/b/mogging.config.ts`
    gives `project.root === "<tmp>/b"`.
  - "no starlight export leaves project.starlight undefined".
  - "a malformed starlight export is exit 2 before connecting": `run(["status"], deps)` with `starlight: { collection:
    "nope", passthrough: "extra" }`, and separately with `starlight: "docs"`, returns 2; stderr contains
    `must export \`starlight\` as a valid Starlight layout`; a `connect` spy was never called.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @mogging/cli test project` - FAIL.
- [ ] **Step 3: Implement.** In `loadProject`, after the `config` check (`project.ts:83-87`) and before `deps.connect`
  (`:88`): when `mod.starlight !== undefined`, a non-object is a `UsageError`; otherwise call
  `defineStarlightLayout(mod.starlight as StarlightLayoutInput, mod.config)` and turn its `ValidationError` into
  `UsageError(\`${configPath} must export \`starlight\` as a valid Starlight layout: ${message}\`)`. Return `starlight`
  and `root: dirname(configPath)` on the project.
- [ ] **Step 4: Run the tests, typecheck, suite.** All pass.
- [ ] **Step 5: Commit.** `feat(cli): load and validate the starlight layout export`.

### Task 3: The static `astro.config` reader and the locale-drift check

**Files:**
- Create: `packages/cli/src/starlight/astroConfig.ts`, `packages/cli/test/astroConfig.test.ts`
- Modify: `packages/cli/package.json` (dependency `"acorn": "8.19.0"`; run `pnpm install`)

**Interfaces:** Produces `readAstroConfig`, `starlightLocaleDirs`, `localeDrift`, `astroConfigWarnings`,
`AstroConfigRead`, `AstroLocale` (block above). Consumes `StarlightLayout`, `normalizeLocale` (`@mogging/core`).

The read, in order (spec 5.2 "best effort: a config they cannot read statically is reported once, not guessed"):
1. The first of `astro.config.mjs`, `astro.config.js`, `astro.config.ts`, `astro.config.mts` that exists in `root`
   (Astro's own order, `astro/packages/astro/src/core/config/config.ts:29-34`). None: `{ ok: false, file: null, reason:
   "no astro.config file" }`.
2. `acorn.parse(text, { ecmaVersion: "latest", sourceType: "module" })`. On a `SyntaxError` in a `.ts`/`.mts` file,
   and only when `module.stripTypeScriptTypes` is a function, parse its output instead; while calling it, replace
   `process.emitWarning` with a wrapper that drops a warning whose name is `ExperimentalWarning` and whose message
   mentions `stripTypeScriptTypes`, and restore it in `finally`. Still failing: reason `"could not be parsed"`.
3. The `export default` expression: an object literal, or a call whose callee is an identifier named `defineConfig`
   with one object-literal argument. Else reason `"export default is not defineConfig({...}) or an object literal"`.
4. `srcDir`: absent = `"./src"`; a string literal = its value; anything else = reason `"srcDir is not a string
   literal"`. `docsDir` = POSIX-normalized `srcDir` without a leading `./` or trailing `/`, plus `/content/docs`
   (Starlight: `<srcDir>/content/docs`, `starlight/packages/starlight/src/utils/collection.ts:25-35`).
5. The local name of the default import from `"@astrojs/starlight"` (none: reason `"no import of @astrojs/starlight"`);
   the `integrations` array literal of the config holds exactly one call of that name (none: reason `"no starlight()
   call in integrations"`), with one object-literal argument.
6. In that object: `locales` absent = `null`; else an object literal whose keys are identifiers or string literals and
   whose values are object literals with an optional string-literal `lang` (missing `lang` = the key,
   `user-config.ts:201-208`), in source order. `defaultLocale` absent = `null`, else a string literal. A spread, a
   computed key, an identifier, a call or a template literal with an expression anywhere in `locales` or
   `defaultLocale` = reason `"locales is not a literal object"` / `"defaultLocale is not a string literal"`.
7. Never throws: an unexpected error is `{ ok: false, file, reason: "could not be read: <message>" }`.

`starlightLocaleDirs(read)`: the keys of `read.locales` except `"root"` and except `read.defaultLocale`, in order;
`[]` when `locales` is `null`. `localeDrift(read, layout)` returns these messages, in this order:
- for each Mogging target locale whose folder is not in `starlightLocaleDirs(read)`: `locale "<tag>" (folder
  <dir>) is not in Starlight's locales`;
- for each folder of `starlightLocaleDirs(read)` that is neither a `layout.localeDirs` value nor in
  `layout.otherLocaleDirs`: `Starlight locale folder "<dir>" is not a Mogging locale (add it to mogging.config.ts or
  to otherLocaleDirs)`;
- when the source side differs (`layout.sourceDir` is `null` but Starlight's `defaultLocale` is set to a key other
  than `"root"`, or `layout.sourceDir` is set and differs from `defaultLocale`): `the source folder differs: Mogging
  <sourceDir or "(root)">, Starlight <defaultLocale or "root">`.
`astroConfigWarnings(root, layout)`: reads once; ok gives `localeDirs: starlightLocaleDirs(read)` and one warning
`{ file: <basename of read.file>, message }` per drift message; not ok gives `localeDirs: null` and exactly one warning
`{ file: "astro.config", message: "could not be read statically (<reason>); the Starlight locale check was skipped" }`.

- [ ] **Step 1: Write the failing tests** (each writes files into a fresh temp folder; no database):
  - "reads locales, defaultLocale and the docs folder from a plain astro.config.mjs": `ASTRO_ROOT_DE_ZH` gives
    `{ ok: true, docsDir: "src/content/docs", defaultLocale: null, locales: [{ key: "root", lang: "en" }, { key: "de",
    lang: "de" }, { key: "zh-cn", lang: "zh-CN" }] }`.
  - "lang defaults to the key": `de: { label: "Deutsch" }` gives `{ key: "de", lang: "de" }`.
  - "srcDir moves the docs folder": `srcDir: "./site/"` gives `"site/content/docs"`; `srcDir: "src"` gives
    `"src/content/docs"`.
  - "a renamed starlight import is found": `import sl from "@astrojs/starlight"` with `sl({ locales: {...} })`.
  - "a TypeScript config with annotations is read and prints nothing": `astro.config.ts` holding `const title: string
    = "Docs";` and literal locales gives ok; a spy on `process.stderr.write` and `process.emitWarning` records no
    `ExperimentalWarning`; `process.emitWarning` is the original function afterwards.
  - "Astro's file order: .mjs wins over .ts": both present with different locales; the `.mjs` ones are returned.
  - "a single-language site has locales null": `starlight({ title: "Docs" })`.
  - one test per not-readable input, each asserting `ok: false` and the exact reason: no file (`file: null`); a
    syntax error; `locales: LOCALES` (imported constant); `locales: { ...more }`; `locales: { [k]: {} }`;
    `defaultLocale: DEFAULT`; `lang: \`${x}\``; no `starlight(` call; `export default someFunction()`; `srcDir: dir`.
  - "starlightLocaleDirs": root mode gives `["de", "zh-cn"]`; `defaultLocale: "en"` with keys `en`, `de` gives `["de"]`.
  - "localeDrift names each mismatch": layout with `de` and `zh-CN` against a config with `root`, `de`, `fr` gives
    exactly `['locale "zh-CN" (folder zh-cn) is not in Starlight\'s locales', 'Starlight locale folder "fr" is not a
    Mogging locale (add it to mogging.config.ts or to otherLocaleDirs)']`; with `otherLocaleDirs: ["fr"]` only the
    first; a matching config gives `[]`; own-folder Starlight (`defaultLocale: "en"`) against a root-mode layout gives
    the source message.
  - "astroConfigWarnings: one warning when unreadable": `localeDirs` `null` and exactly one warning with file
    `astro.config`.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @mogging/cli test astroConfig` - FAIL.
- [ ] **Step 3: Implement `astroConfig.ts`** with the rules above (an AST walk over acorn's ESTree nodes; no regex over
  source text).
- [ ] **Step 4: Run the tests, typecheck, suite.** All pass.
- [ ] **Step 5: Commit.** `feat(cli): read astro.config statically for Starlight locales`.

### Task 4: `mogging import` in a Starlight project

**Files:**
- Modify: `packages/cli/src/commands/import.ts:1-40`
- Test: `packages/cli/test/importStarlight.test.ts` (new)

**Interfaces:** Consumes `Project.starlight`, `Project.root` (Task 2), `astroConfigWarnings` (Task 3),
`importFolder(ctx, { dir, publish, starlight: { layout, prune, acceptNewAndGone, restore, dryRun } })` and
`ImportReport.starlight` (`packages/markdown/src/import.ts:19-84`).

Behaviour (spec 5.2, 5.4 exit codes, 5.5, 5.6):
- Usage: `mogging import [<dir>] [--publish] [--prune] [--accept-new-and-gone] [--restore <file>]... [--dry-run]
  [--json] [--config <path>] [--database-url <url>]`. Options gain `prune` (boolean), `"accept-new-and-gone"`
  (boolean), `restore` (string, multiple), `"dry-run"` (boolean). Arity `[0, 1]`.
- Generic project (`project.starlight === undefined`): the directory is required (`UsageError("import: missing
  argument\nusage: ...")`); any of the four new flags is `UsageError(\`import: --<flag> needs a Starlight project (an
  \`export const starlight\` in ${configPath})\`)`. Otherwise behaviour and output are exactly today's.
- Starlight project: a directory argument is `UsageError(\`import: a Starlight project imports from its docs folder
  (${layout.docsDir}); drop the directory argument\`)`. `dir` = `project.root`. Each `--restore` value `p`:
  `rel = path.relative(root, path.resolve(cwd, p))`; `rel` empty, starting with `..` or absolute is
  `UsageError(\`--restore ${p} is outside the project ${root}\`)`; else passed as `rel.split(path.sep).join("/")`.
- Output lines, in order: `dry run: nothing was written` (dry run only); the `astroConfigWarnings` warnings as
  `warning: <file>: <message>`; `<outcome> <file>` per file; `pruned <slug>` per pruned slug; for a stop: `stopped:
  <g> page(s) gone and <a> new file(s); nothing was created or pruned`, then `  gone <slug> "<title or (no title)>"`
  and `  new <file> "<title or (no title)>"` lines, then `run: <command>` when `command` is set, else `pair them with
  mogging rename <old> <new>, or pass --accept-new-and-gone`; one line `warning: unsupported extensions (not
  imported): <files joined by ", ">` when `unsupported` is non-empty; then the report's warnings and errors as today.
- Exit (spec 5.4): with a stop, exit 4 when any file outcome is `created`, `updated` or `unchanged`, else exit 1 with
  `error: { code: "ImportStopped", message: "rename safety stop: nothing was imported" }`. Without a stop, today's rule
  (`import.ts:25-37`). A run with no source file throws `ValidationError` in the SDK (`importStarlight.ts:161`): exit 1
  through `exitCodeFor`.

- [ ] **Step 1: Write the failing tests** (database; projects from `starlightProject`; `D = "src/content/docs"`):
  - "a plain import imports the docs folder and publishes English": files `D/a.md`, `D/de/a.md` and
    `astro.config.mjs` = `ASTRO_ROOT_DE_ZH`; exit 0; stdout lines include `created src/content/docs/a.md` and no
    `warning:` line.
  - "a directory argument in a Starlight project is exit 2".
  - "Starlight flags in a generic project are exit 2 naming the export": `--prune`, `--dry-run`,
    `--accept-new-and-gone`, `--restore x` each exit 2 with stderr containing `needs a Starlight project`.
  - "--dry-run writes nothing and says so": exit 0, first stdout line `dry run: nothing was written`, `select count(*)
    from documents` is 0.
  - "the safety stop with other files imported exits 4 and prints the command": import `a.md` and `c.md`, rename
    `a.md` to `b.md` and edit `c.md`; exit 4; stdout contains `run: mogging rename a b`; with `--json`, `ok: true`,
    `partial: true`, `data.starlight.stop.command === "mogging rename a b"`.
  - "a safety stop with nothing else exits 1 with ImportStopped": only `a.md`, renamed to `b.md`; exit 1; `--json`
    error code `ImportStopped`.
  - "--accept-new-and-gone creates the new page, and --prune also deletes the gone one".
  - "--restore takes a path relative to the working directory": `cwd` = `<root>/src/content/docs`, `--restore
    de/a.md` reaches the SDK as `src/content/docs/de/a.md` (no `restore: no locale file` error; the file is saved as a
    human draft); `--restore ../../../../elsewhere.md` is exit 2.
  - "an empty docs folder is exit 1": stderr contains `no source file found`.
  - "locale drift is warned, an unreadable config once": `astro.config.mjs` without `zh-cn` gives the line
    `warning: astro.config.mjs: locale "zh-CN" (folder zh-cn) is not in Starlight's locales`; `locales: L` gives exactly
    one `warning: astro.config: could not be read statically` line.
  - "the project root is the config's folder": `cwd` = `<root>/src`, `--config <root>/mogging.config.ts`; the import
    finds `D/a.md`.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @mogging/cli test importStarlight` - FAIL.
- [ ] **Step 3: Implement** in `import.ts`; keep the generic path byte-for-byte in output.
- [ ] **Step 4: Run the tests (and `pnpm --filter @mogging/cli test import` for the generic ones), typecheck, suite.**
- [ ] **Step 5: Commit.** `feat(cli): Starlight-mode import with prune, restore, dry run and the safety stop`.

### Task 5: `mogging export` in a Starlight project

**Files:**
- Modify: `packages/cli/src/commands/export.ts:1-45`
- Test: `packages/cli/test/exportStarlight.test.ts` (new); `packages/cli/test/export.test.ts` (one new test)

**Interfaces:** Consumes Tasks 2-3 and `exportFolder(ctx, { dir, locales, starlight: { layout, dryRun,
starlightLocaleDirs } })`, `ExportReport.starlight.{ actions, attention }` (`packages/markdown/src/export.ts:16-53`).

Behaviour:
- Usage: `mogging export [<dir>] [--collection <c>]... [--locale <l>]... [--dry-run] [--json] [--config <path>]
  [--database-url <url>]`. Options gain `"dry-run"`. Arity `[0, 1]`.
- Both modes: each `--locale` is normalized with `normalizeLocale` (`@mogging/core`) before the declared check
  (`export.ts:30-33`) and passed normalized; an invalid tag stays a usage error with today's message.
- Generic project: the directory is required; `--dry-run` is `UsageError("export: --dry-run needs a Starlight project
  ...")` in the same form as Task 4. Otherwise unchanged.
- Starlight project: a directory argument and `--collection` are usage errors (`export: a Starlight project exports
  its docs folder ...; drop the directory argument` and `export: a Starlight project has one docs collection; drop
  --collection`). `{ localeDirs, warnings } = astroConfigWarnings(root, layout)`; pass `starlightLocaleDirs:
  localeDirs`.
- Output lines: dry-run header as in Task 4; the astro warnings; one line per action `<action> <path>[ -> <to>]
  (<reason>)`, except that a real run prints no `keep` line and instead ends the action lines with `kept <n> unchanged
  locale file(s)` when `n > 0` (a dry run lists every `keep`, spec 5.4 `--dry-run`); `attention: <file>: <message>` per
  attention entry; the report's warnings.
- Exit 4 when `attention` is non-empty, else 0. A thrown self-check (`exportStarlight.ts:251`) is exit 1 through
  `exitCodeFor`.

- [ ] **Step 1: Write the failing tests:**
  - "a re-export after day one keeps every file": import `D/a.md` + `D/de/a.md`, then `export`; exit 0; stdout has
    `kept 1 unchanged locale file(s)` and no `keep ` line.
  - "--dry-run lists every action, keep included, and writes nothing": stdout has `keep src/content/docs/de/a.md (`;
    the manifest file `.mogging/manifest.json` does not exist afterwards; `--json` `data.starlight.dryRun === true`.
  - "a hand edit puts the run in attention: exit 4, ok and partial in json": after a published day one, edit
    `D/de/a.md`; `export --json` exit 4, `ok: true`, `partial: true`, `data.starlight.attention[0].file` is that path;
    stdout (without `--json`) has an `attention: src/content/docs/de/a.md:` line.
  - "a Mogging locale missing from Starlight's locales is skipped and the run exits 4": a published `zh-CN`
    translation, `astro.config.mjs` without `zh-cn`; exit 4; no file under `D/zh-cn/`; a warning line names `zh-CN`.
  - "an unreadable astro.config writes as configured with one warning": `locales: L`; the `zh-cn` file is written;
    exactly one `could not be read statically` line.
  - "a directory argument and --collection are exit 2 in a Starlight project".
  - In `export.test.ts`: "--locale is normalized": `--locale DE` (generic project) exports the `de` tree, exit 0.
  - In `exportStarlight.test.ts`: "--locale zh-cn selects zh-CN".
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @mogging/cli test export` - FAIL.
- [ ] **Step 3: Implement** in `export.ts`.
- [ ] **Step 4: Run the tests, typecheck, suite.**
- [ ] **Step 5: Commit.** `feat(cli): Starlight-mode export with the locale check, dry run and exit 4 for attention`.

### Task 6: `mogging rename`

**Files:**
- Create: `packages/cli/src/commands/rename.ts`, `packages/cli/test/rename.test.ts`
- Modify: `packages/cli/src/commands/index.ts:21-25` (register `renameSpec` right after `exportSpec`)

**Interfaces:** Consumes `renamePage(ctx, { dir, layout, from, to, dryRun })` and `RenameReport { dryRun, actions,
references, warnings, reminder }` (`packages/markdown/src/starlight/rename.ts:26-53`, throws per `:290-308`).

`renameSpec`: name `rename`, summary `rename a Starlight page's slug and keep its translations`, usage `mogging rename
<old-slug> <new-slug> [--dry-run] [--json] [--config <path>] [--database-url <url>]`, options `{ "dry-run": { type:
"boolean" } }`, project `full`, arity `[2, 2]`. Run: a generic project is `UsageError(\`rename needs a Starlight
project (an \`export const starlight\` in ${configPath})\`)`; else `renamePage` with `dir: project.root`. Lines: the
dry-run header; `move <path> -> <to>` per action; `reference <file>:<line>: <text>` per reference; the warnings as
`warning: <file>: <message>`; the reminder last. Exit 0; the SDK's `ValidationError` and `ConflictError` give exit 1.

- [ ] **Step 1: Write the failing tests:**
  - "rename moves the English and German files and the slug": after a day-one import of `D/guides/a.md`,
    `D/de/guides/a.md`, `rename guides/a guides/b` exits 0; both files exist under `guides/b.md`; stdout has `move
    src/content/docs/guides/a.md -> src/content/docs/guides/b.md`; `getDocument(ctx, { collection: "docs", slug:
    "guides/b" })` is not null.
  - "an astro.config sidebar entry naming the old slug is listed": `astro.config.mjs` holding `slug: 'guides/a'`;
    stdout has `reference astro.config.mjs:` and the reminder line.
  - "--dry-run moves nothing and saves nothing".
  - "a differing target is exit 1 naming both files": an existing different `D/guides/b.md`; exit 1; stderr names both
    paths.
  - "a generic project is exit 2"; "help lists rename" (`run(["help"])` stdout contains `rename`).
- [ ] **Step 2: Run to see them fail.** `pnpm --filter @mogging/cli test rename` - FAIL.
- [ ] **Step 3: Implement and register.**
- [ ] **Step 4: Run the tests, typecheck, suite.**
- [ ] **Step 5: Commit.** `feat(cli): mogging rename for Starlight pages`.

### Task 7: `compile --include-untracked` and a whole-collection `track`

**Files:**
- Modify: `packages/cli/src/commands/compile.ts:14-20`, `:50-56`; `packages/cli/src/commands/track.ts:15-42`
- Test: `packages/cli/test/compile.test.ts`, `packages/cli/test/track.test.ts` (one describe each)

**Interfaces:** Consumes `compile(ctx, { ..., includeUntracked })` (`packages/ai/src/compile.ts:10`, `:28`),
`getSyncState(ctx, { collection, locale })` (`packages/core/src/sync/state.ts:43`, live documents only, `:87`),
`trackFields(ctx, { docId, locale, fields })` (`:107`), `getDocuments(ctx, { collection, docIds })` (at most 1000 ids
per call).

- `compile`: option `"include-untracked": { type: "boolean" }`, usage gains `[--include-untracked]` before `[--json]`;
  passes `includeUntracked: true` only when the flag is set (spec 5.3).
- `track`: usage gains a second form `mogging track --collection <c> --locale <l> [--dry-run] [--json] [--config
  <path>] [--database-url <url>]`; options gain `collection` (string) and `"dry-run"` (boolean); arity `[0, 1]`.
  `validate`: exactly one of the positional and `--collection` (`track: give <collection>/<slug> or --collection <c>`
  when neither, `track: give <collection>/<slug> or --collection <c>, not both` when both); `--fields` and `--dry-run`
  only in their own form (`track: --fields needs <collection>/<slug>`, `track: --dry-run needs --collection`). Run of
  the collection form: an undeclared collection is a `UsageError` naming the declared ones (as `export.ts:23-29`);
  one `getSyncState` call; the `untracked` rows grouped by document; slugs from `getDocuments` in chunks of 1000;
  documents in slug order; `trackFields` once per document unless `--dry-run`. Lines `tracked <collection>/<slug>
  <locale> <field>` (`would track ...` in a dry run, after the header `dry run: nothing was written`); none at all:
  `nothing untracked in <collection> (<locale>)`. `data`: `{ tracked: Array<{ docId, slug, locale, fields }> }`.

- [ ] **Step 1: Write the failing tests:**
  - compile: "untracked fields are queued only with --include-untracked": a document whose `de` title was saved
    untracked (core `saveDraft` with `untracked: true`, then `publish`); `compile --locales de --budget 1` queues 0
    jobs (`data.enqueue.enqueued === 0`); with `--include-untracked`, `data.enqueue.enqueued === 1`, and the mock model's request names `title`.
  - track: "--collection tracks every untracked field of every live document": two documents with untracked `de`
    fields, one fully current; exit 0; stdout lists exactly the two documents' fields; afterwards `getSyncState`
    shows no `untracked` row for `de`; the current document got no `human:track` provenance row.
  - "--dry-run tracks nothing"; "--collection with a positional, and neither, are exit 2"; "--fields with
    --collection is exit 2"; "an undeclared collection is exit 2"; "nothing untracked prints the one line".
- [ ] **Step 2: Run to see them fail.** `pnpm --filter @mogging/cli test compile` and `... test track` - FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests, typecheck, suite.**
- [ ] **Step 5: Commit.** `feat(cli): compile --include-untracked and a whole-collection track`.

### Task 8: `mogging init --starlight`

**Files:**
- Create: `packages/cli/src/starlight/initStarlight.ts`, `packages/cli/test/initStarlight.test.ts`
- Modify: `packages/cli/src/commands/init.ts:42-83`

**Interfaces:** Produces `starlightAnswers`, `starlightConfigText`, `STARLIGHT_RANGE`, `starlightVersionWarning`,
`StarlightAnswers` (block above). Consumes `readAstroConfig` (Task 3), `normalizeLocale`.

`starlightAnswers(read, flags)` (spec 5.2 "Locale identity", 6 `init --starlight`), every refusal a `UsageError`:
- read ok, `locales` not null: `--locales` or `--source-locale` given is `init --starlight: astro.config declares
  Starlight's locales; drop --locales and --source-locale (or edit astro.config)`. Root mode when `defaultLocale` is
  `null` or `"root"`: needs a `root` key (else `init --starlight: astro.config has locales but neither a root locale
  nor defaultLocale`); `source = normalizeLocale(root.lang)`, `sourceDir = null`. Own-folder mode when
  `defaultLocale` is another key: that key must exist and there must be no `root` key; `sourceDir` = that key;
  `source` from its `lang`. Targets: every other key, in order, `{ tag: normalizeLocale(lang), dir: key }`.
  `pasteBlock = null`.
- read ok, `locales` null (single-language site): `--locales` required (`init --starlight: this site has one language;
  pass --locales de,fr (the languages to add)`); `source = normalizeLocale(flags.sourceLocale ?? "en")`; targets from
  the comma list, each `{ tag: normalizeLocale(t), dir: tag.toLowerCase() }`; root mode; `pasteBlock` = the Starlight
  `locales` block to paste, one line per locale, `root` first: `      root: { label: "<label>", lang: "<source>" },`
  then `      "<dir>": { label: "<label>", lang: "<tag>" },`, framed by `    locales: {` and `    },`, where `<label>`
  is `new Intl.DisplayNames([tag], { type: "language" }).of(tag)`.
- read not ok: `--locales` required (`init --starlight: astro.config could not be read statically (<reason>); pass
  --locales de,fr and, if the site's default language is not English, --source-locale <tag>`); as the
  single-language case otherwise, but `pasteBlock = null` and `warnings = ["astro.config could not be read
  statically (<reason>); the locales come from --locales"]`.
- Any case: a duplicate target tag or folder, or a target equal to the source, is a usage error naming it.
  `docsDir` = `read.docsDir` when ok, else `"src/content/docs"`.

`starlightConfigText(a)` returns exactly this text (values JSON-quoted with `JSON.stringify`; `localeDirs` and
`chains` list the targets in order; the AI block is `CONFIG_TEMPLATE`'s commented block, `init.ts:23-35`, verbatim):

```ts
import { defineConfig } from "@mogging/core";
import { starlightPreset } from "@mogging/starlight/preset";

// The Starlight docs collection and its layout (folders, locale folders, front-matter mapping).
const docs = starlightPreset({
  docsDir: "src/content/docs",
  sourceDir: null,
  localeDirs: { "de": "de", "zh-CN": "zh-cn" },
});

export const config = defineConfig({
  collections: [docs.collection],
  locales: { source: "en", chains: { "de": ["en"], "zh-CN": ["en"] } },
});

// Read by the mogging CLI: where the docs live and how front matter maps to fields.
export const starlight = docs.layout;

<the commented AI block of init.ts:23-35>
```

`STARLIGHT_RANGE = { min: "0.43.0", below: "0.44.0" }`. `starlightVersionWarning(root)`: reads
`<root>/node_modules/@astrojs/starlight/package.json`; missing: `@astrojs/starlight is not installed in <root>; install
it before building the site`; a version that does not parse as `x.y.z` numbers, is below `min` or not below `below`:
`@astrojs/starlight <version> is outside the range @mogging/starlight supports (>=0.43.0 <0.44.0)`; else `null`.

`init`: options gain `starlight` (boolean), `locales` (string), `"source-locale"` (string); usage `mogging init
[--starlight [--locales de,fr] [--source-locale en]] [--json] [--config <path>] [--database-url <url>]`; `validate`:
`--locales`/`--source-locale` without `--starlight` is `init: --locales needs --starlight`. With `--starlight`: the
database URL check first (as `init.ts:70`); an existing config is left byte-identical with the line `<path> already
exists: left unchanged; --starlight wrote nothing` and the run still migrates; otherwise read `astro.config` in the
folder of the config file to be written (`dirname` of the `--config` path, else `cwd`),
compute the answers (usage errors before any write and before connecting), write `starlightConfigText` with the same
`wx` rule as `writeTemplate` (`init.ts:42-59`), then load and migrate as today. Lines: `created <path>`, `warning: <w>`
per answer warning and the version warning, then, when `pasteBlock` is set, `add this to the starlight() options in
astro.config:` followed by the block's lines, then the migration lines. `data` gains `starlight: { source, targets,
sourceDir, docsDir }` (only with `--starlight`).

- [ ] **Step 1: Write the failing tests** (the loadable-file tests use the real jiti loader from a folder under
  `packages/cli`, as `packages/cli/test/init.test.ts:11-31` does, so `@mogging/core` and `@mogging/starlight` resolve):
  - "a root-locale site gets a config that loads and validates": `astro.config.mjs` = `ASTRO_ROOT_DE_ZH`; `init
    --starlight` exit 0; the written file loaded with jiti has `config.locales` `{ source: "en", chains: { de: ["en"],
    "zh-CN": ["en"] } }` and `defineStarlightLayout(mod.starlight, mod.config).localeDirs` `{ de: "de", "zh-CN":
    "zh-cn" }`.
  - "an own-folder site (defaultLocale en) gets sourceDir en".
  - "a single-language site needs --locales and gets the block to paste": without it exit 2 and no file; with
    `--locales de` exit 0 and stdout contains `"de": { label: "Deutsch", lang: "de" },`.
  - "an unreadable astro.config needs --locales": exit 2 without; exit 0 with `--locales de`, plus the warning line.
  - "--locales next to readable locales is exit 2"; "--locales without --starlight is exit 2".
  - "an existing config is left unchanged and says --starlight wrote nothing".
  - "the version check": `node_modules/@astrojs/starlight/package.json` with `0.44.1` gives the outside-range line;
    without the file, the not-installed line; `0.43.2` gives none.
  - "STARLIGHT_RANGE matches the package's peer range": `packages/starlight/package.json`
    `peerDependencies["@astrojs/starlight"] === \`>=${STARLIGHT_RANGE.min} <${STARLIGHT_RANGE.below}\``.
  - `starlightConfigText` unit test: the answers of the first case give exactly the text above (with the AI block).
- [ ] **Step 2: Run to see them fail.** `pnpm --filter @mogging/cli test initStarlight` - FAIL.
- [ ] **Step 3: Implement.** Plain `init` output and data stay as today (`init.test.ts` passes unchanged).
- [ ] **Step 4: Run the tests (`... test init`), typecheck, suite.**
- [ ] **Step 5: Commit.** `feat(cli): init --starlight reads astro.config and writes the preset config`.

### Task 9: The starter template

**Files:**
- Create under `templates/starlight/`: `package.json`, `astro.config.mjs`, `tsconfig.json`, `mogging.config.ts`,
  `compose.yaml`, `.env.example`, `.gitignore`, `README.md`, `src/content.config.ts`, `src/content/docs/index.mdx`,
  `src/content/docs/guides/getting-started.md`, `src/content/docs/reference/configuration.md`
- Test: `packages/cli/test/template.test.ts` (new; offline, no database)

The site (spec 7): Starlight's `examples/basics` shape at 0.43.0 (`astro.config.mjs`, `src/content.config.ts` with
`docsLoader()`/`docsSchema()`, `tsconfig.json`) with `title: "Mogging Docs"`, `integrations: [starlight({...}),
moggingStarlight()]` (`import moggingStarlight from "@mogging/starlight"`, proving the no-op integration in a real
build), `locales: { root: { label: "English", lang: "en" }, de: { label: "Deutsch", lang: "de" }, "zh-cn": { label:
"简体中文", lang: "zh-CN" } }`, and a sidebar using `autogenerate` for `guides` and `reference`. Three English pages, no
translations: a splash `index.mdx` with a hero (`title`, `tagline`, one action), and two plain pages with a title, a
description and a few paragraphs (the content is the builder's; each says "replace this page with yours").
`mogging.config.ts` is `starlightConfigText` of the answers `{ source: "en", targets: [de/de, zh-CN/zh-cn], sourceDir:
null, docsDir: "src/content/docs" }` (Task 8), byte for byte. `package.json`: `"name": "mogging-starlight-template"`,
`"private": true`, `"type": "module"`; scripts `dev`, `build`, `preview`, `astro` as Starlight's example, plus
`"mogging": "node --env-file=.env node_modules/@mogging/cli/dist/bin.js"`; dependencies `astro 7.4.4`,
`@astrojs/starlight 0.43.0`, `sharp 0.35.3`, `@mogging/starlight 0.0.0` (the site's CI must install it, spec 6);
devDependencies `@mogging/cli`, `@mogging/core`, `@mogging/ai` at `0.0.0` (the versions are set at publish, ship step
4). `compose.yaml`: one `postgres:17` service, user/password/database `mogging`, port `5432:5432`, a named volume.
`.env.example`: `DATABASE_URL=postgres://mogging:mogging@localhost:5432/mogging` and commented
`OPENROUTER_API_KEY=` and `MOGGING_LICENSE_KEY=` lines. `.gitignore`: `node_modules/`, `dist/`, `.astro/`, `.env`.
`README.md` (spec 6 and 7): the first section after the title is the licence (the terms in one paragraph and the
zero-price noncommercial key, linking `LICENSE.md` of the package), then: `cp .env.example .env`, `docker compose up
-d`, `npm install`, "replace the sample pages with yours", then the session `npm run mogging -- migrate`, `... import`,
add the `ai` export (uncomment the block, set `OPENROUTER_API_KEY` and a monthly cap), `... compile --locales
de,zh-CN --budget <usd>`, `... review`, `... publish`, `... export`, `npm run build`, commit; the 30-day evaluation and
what stops after it; the supported team setup (spec 5.7) and the known limits (spec 7.1), each in a short section.

- [ ] **Step 1: Write the failing tests** in `template.test.ts`:
  - "the template's astro.config reads statically and matches its Mogging config": `readAstroConfig("<repo>/templates/
    starlight")` is ok with locales `root/en`, `de/de`, `zh-cn/zh-CN`; the template's `mogging.config.ts` loaded with
    `createJiti(import.meta.url, { alias: { "@mogging/core": <core src/index.ts>, "@mogging/starlight/preset":
    <starlight src/preset.ts> } })` validates with `defineStarlightLayout`, and `localeDrift(read, layout)` is `[]`.
  - "mogging.config.ts is what init --starlight writes": equals `starlightConfigText` of the answers above.
  - "package.json pins": the exact versions above and the `mogging` script string.
  - "the database URL agrees across .env.example and compose.yaml": user, password, database and port.
  - "README puts the licence first and the session in order": the first `## ` heading contains `Licence`; the indexes
    of `migrate`, `import`, `compile`, `review`, `publish`, `export`, `npm run build` in the text increase.
- [ ] **Step 2: Run to see them fail.** `pnpm --filter @mogging/cli test template` - FAIL.
- [ ] **Step 3: Write the template files.**
- [ ] **Step 4: Run the tests, typecheck, suite.**
- [ ] **Step 5: Commit.** `feat(templates): Starlight starter template`.

### Task 10: The template acceptance run (`pnpm accept:starlight`)

**Files:**
- Create: `scripts/lib/packed.mjs`, `scripts/starlight-accept.mjs`
- Modify: root `package.json` (script `"accept:starlight": "node scripts/starlight-accept.mjs"`)

`scripts/lib/packed.mjs` exports `sh(cmd, args, { cwd, env })` and `check(cond, message)` with the semantics of
`scripts/pack-smoke.mjs:22-34`, `buildAndPack(root, dest)` (runs `pnpm build`, packs `core`, `markdown`, `ai`, `cli`,
`starlight` into `dest`, returns `{ [name]: absoluteTarballPath }`), `throwawaySchema(baseUrl)` (creates a `accept_<hex>`
schema and returns `{ url, drop() }`, the URL carrying `search_path`, as `pack-smoke.mjs:73-78`) and
`installSite(siteDir, tarballs, extraDev)` (rewrites the site's `@mogging/*` dependency versions to `file:<tarball>`,
adds `extraDev` devDependencies, runs `npm install --no-audit --no-fund`). `pack-smoke.mjs` is left unchanged.

The run (spec 7: "import, a mocked compile, approve, export, astro build" against the packages at HEAD), each step
printing `OK <step>` and failing the script with a message on a wrong exit or output:
1. `DATABASE_URL` required (exit 2 otherwise, as pack-smoke). Build and pack; copy `templates/starlight` to
   `<tmp>/site` (no `node_modules`); `installSite(site, tarballs, { ai: "7.0.154" })`.
2. Throwaway schema; write `<site>/.env` with its URL, so every command below runs through the template's own
   `npm run mogging -- <args>` script (proving the `.env` loading).
3. `migrate`; `import` exits 0 and reports `created` for the three English files.
4. Write `<site>/mogging.accept.config.ts`: re-exports `config` and `starlight` from `./mogging.config.ts` and adds an
   `ai` export: `defineAiConfig({ provider: { kind: "custom", models: { "mock/translate": model } }, models: {
   translate: "mock/translate" }, prices: { "mock/translate": { inputUsdPerMtok: 1, outputUsdPerMtok: 2,
   contextTokens: 128000 } }, budgets: { monthlyCapUsd: 5 } })`, where `model` is a `MockLanguageModelV3` (`ai/test`)
   whose `doGenerate` reads the user message's `<<<DATA\n...\nDATA>>>` block (`packages/cli/test/mockModel.ts:66-85`)
   and answers `{ fields, glossaryTermsUsed: [] }`, `fields` being the request's `translate` object with every string
   leaf prefixed `Übersetzt: ` (placeholders and structure untouched), with the usage block of `mockModel.ts:15-22`.
5. `compile --locales de,zh-CN --budget 1 --config mogging.accept.config.ts` exits 0.
6. `review --approve-clean --json` reports `approved` = 6 (three pages, two locales); `review list --state APPROVED
   --json` items, then `publish docs/<slug> --locale <locale>` for each, all exit 0.
7. `export` exits 0; `src/content/docs/de/guides/getting-started.md` and `.../zh-cn/guides/getting-started.md` exist
   and contain `Übersetzt: `; `.mogging/manifest.json` exists.
8. `npx astro build` exits 0; `dist/de/guides/getting-started/index.html` contains `Übersetzt: `; `dist/index.html`
   exists.
9. `finally`: drop the schema, remove the temporary folder and the copied `LICENSE.md` files (as
   `pack-smoke.mjs:115-121`); exit 1 on any failure, else print `accept:starlight passed`.

- [ ] **Step 1: Write `scripts/lib/packed.mjs` and `scripts/starlight-accept.mjs`.**
- [ ] **Step 2: Run it** (needs the npm registry): `DATABASE_URL=postgres://mogging:mogging@127.0.0.1:54329/mogging_test
  pnpm accept:starlight` - expected last line `accept:starlight passed`. A failure in a product step (not the
  environment) is a defect in Tasks 1-9: report it with the step and output; do not weaken the check.
- [ ] **Step 3: Confirm `pnpm smoke:pack` still passes** (unchanged script; it shares nothing but the pattern).
- [ ] **Step 4: Commit.** `test(starlight): template acceptance run against packed packages`.

### Task 11: The existing-adopter fixture (`pnpm accept:adopter`)

**Files:**
- Create: `scripts/fixtures/starlight-adopter/` (the site below), `scripts/starlight-adopter.mjs`
- Modify: root `package.json` (script `"accept:adopter": "node scripts/starlight-adopter.mjs"`)

The fixture (spec 7): a Starlight 0.43.0 site with NO `mogging.config.ts`, `astro.config.mjs` with `locales: { root:
{ label: "English", lang: "en" }, de: { label: "Deutsch", lang: "de" } }` and a sidebar with one explicit entry `{
label: "Setup", slug: "guides/setup" }` plus `autogenerate` for `reference`; `src/content.config.ts` with
`docsSchema({ extend: z.object({ difficulty: z.string().optional() }) })`; `src/components/Note.astro`; package.json as
the template's (no `@mogging/*`). Pages, each English with a hand-made German translation under `de/`:
- `index.mdx`: a splash page (`template: splash`, a hero with title, tagline and one action).
- `guides/setup.md`: `sidebar: { order: 2, label: Setup, badge: New }` (German `label: Einrichtung`, `badge: Neu`).
- `guides/images.md`: `![Diagram](./diagram.svg)` with `guides/diagram.svg` beside it; German
  `![Diagramm](../../guides/diagram.svg)`.
- `guides/components.mdx`: `import Note from '../../../components/Note.astro';` and `import { Card } from
  '@astrojs/starlight/components';` (German: `'../../../../components/Note.astro'` and the same package import).
- `reference/levels.md`: `difficulty: beginner` (the extended key; stored in the preset's passthrough).
- `guides/wip.md` (English, not a draft) and German `de/guides/wip.md` with `draft: true`.

The run (spec 7: "init --starlight, the day-one import, a rename and an export, then astro build"):
1. Build, pack, copy the fixture to `<tmp>/site`, convert `src/content/docs/de/guides/setup.md` to CRLF line endings,
   `installSite(site, tarballs, {})` with the five `@mogging/*` tarballs as devDependencies (`@mogging/starlight` as a
   dependency). Throwaway schema; commands run as `node_modules/.bin/mogging` with `DATABASE_URL` in the environment.
   Record every German file's text.
2. `mogging init --starlight` exits 0 and writes `mogging.config.ts` with `chains: { "de": ["en"] }`.
3. `mogging import` exits 0: English `created`, German `created` and published, a warning line for `de/guides/wip.md`
   (saved as a draft, not published); `de/guides/wip.md` has no published head.
4. Change a follows-English key of English `guides/images.md` and `guides/components.mdx` (add `sidebar: { order: 5
   }`), `mogging import` again, then `mogging export` exits 0. Assert the rewritten German files: `de/guides/images.md`
   contains exactly `![Diagramm](../../guides/diagram.svg)`; `de/guides/components.mdx` contains exactly `import Note
   from '../../../../components/Note.astro';` and `import { Card } from '@astrojs/starlight/components';`; both now
   carry `order: 5`.
5. `mogging rename guides/setup guides/installation` exits 0; stdout lists `reference astro.config.mjs:`; the script
   then replaces `slug: "guides/setup"` in `astro.config.mjs` (the operator's edit the reference asks for).
   `de/guides/installation.md` exists and `de/guides/setup.md` does not.
6. `mogging export` exits 0.
7. No hand-written text changed: for every German file of step 1 (at its renamed path for `setup.md`), the body with
   `\r\n` read as `\n` and trimmed is unchanged, and the localized front-matter values (`title`, `description`,
   `sidebar.label`, `sidebar.badge`, `hero.title`, `hero.tagline`, the action `text`) parsed with `yaml` are unchanged
   (formatting and copied shared keys may differ, spec 5.4); `de/reference/levels.md` still has `difficulty:
   beginner`; `de/guides/wip.md` is byte-identical.
8. `npx astro build` exits 0; `dist/de/guides/installation/index.html` contains `Einrichtung`;
   `dist/de/guides/images/index.html` contains `<img`; `dist/de/guides/wip/` does not exist (Starlight drops drafts in
   production, `starlight/packages/starlight/src/utils/routing/index.ts:38-39`).
9. Cleanup as Task 10; last line `accept:adopter passed`.

- [ ] **Step 1: Write the fixture and the script.**
- [ ] **Step 2: Run it** (needs the npm registry): `DATABASE_URL=... pnpm accept:adopter` - expected `accept:adopter
  passed`. A failing assertion about product behaviour is reported with its output (`ESCALATE` if the fix is in core,
  markdown or ai); the assertion is not weakened.
- [ ] **Step 3: Commit.** `test(starlight): existing-adopter fixture with day one, rename, export and astro build`.

### Task 12: The CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

One workflow, `name: ci`, on `push` and `pull_request`. Two jobs on `ubuntu-latest`, each with a `postgres:17` service
(user/password `mogging`, database `mogging_test`, port 5432, a `pg_isready` health check) and `DATABASE_URL:
postgres://mogging:mogging@localhost:5432/mogging_test`:
- `check`: checkout, pnpm setup with version `12.8.1`, Node `22` with the pnpm cache, `pnpm install --frozen-lockfile`,
  `pnpm typecheck`, `pnpm test`, `pnpm smoke:pack`.
- `starlight` (`needs: check`): the same setup, then `pnpm accept:starlight` and `pnpm accept:adopter`.
Pin each action to its current major (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`): look the majors
up with `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name` at execution time and record them in the commit
body.

- [ ] **Step 1: Write the workflow.**
- [ ] **Step 2: Validate it locally:** `node -e` parsing the file with the `yaml` package (resolved from
  `packages/markdown`) prints the two job names and each job's `run` steps; every `run` command exists as a root
  script or a pnpm built-in. The workflow itself runs only when the owner pushes.
- [ ] **Step 3: Commit.** `ci: typecheck, tests, pack smoke and the Starlight acceptance runs`.

### Task 13: Documentation

**Files:**
- Create: `packages/starlight/README.md`
- Modify: `AGENTS.md:37-48` ("Package layering": the new package; "Commands": `accept:starlight`, `accept:adopter`),
  `AGENTS.md:105` (the Starlight status line: implemented), `README.md` (project structure and scripts sections),
  `TODO.md` (Plan 6a follow-ups: drop "export's input.locales not normalized"; add the items below)
- Test: `packages/starlight/test/readme.test.ts` (new)

`packages/starlight/README.md` (spec 6): the licence terms and the zero-price noncommercial key before the install
command; then the first session in order (install `@mogging/cli` and `@mogging/starlight` as dev dependencies, with
`@mogging/starlight` in the site's dependencies when `npx astro add` is used; Postgres from the template's
`compose.yaml` or a hosted `DATABASE_URL`; `mogging init --starlight`; `mogging migrate`; the `ai` export with a
provider key and a monthly cap; `mogging import`; `mogging compile`; `mogging review`; `mogging publish`; `mogging
export`; commit); the evaluation and what stops after it (design 12.3: guarded writers refuse, export and the built
site keep working); supported versions (`@astrojs/starlight >=0.43.0 <0.44.0`, Astro `^7.2.10`; `init --starlight`
warns outside them); day one (`untracked`, `mogging track --collection docs --locale <l>`, `compile
--include-untracked`); renames (`mogging rename`, the safety stop, `--accept-new-and-gone`); deletions (`--prune` is
final); the supported team setup (spec 5.7); the known limits (spec 7.1). AGENTS.md layering line: `starlight` depends
on `core` and `markdown` (types); the CLI does not depend on it at run time.
TODO.md additions: the template's `@mogging/*` versions are `0.0.0` until publish (ship step 4); `npx astro add
@mogging/starlight` is checked by hand before release (spec 7); per-page `publish` after `review --approve-clean` (a
bulk publish of approved drafts would help large sites).

- [ ] **Step 1: Write the failing test** `readme.test.ts`: the first `## ` heading of `packages/starlight/README.md`
  contains `Licence`; the indexes of `init --starlight`, `migrate`, `import`, `compile`, `review`, `publish`, `export`
  increase; the text contains `>=0.43.0 <0.44.0`.
- [ ] **Step 2: Run to see it fail;** write the README and the doc edits; run it to pass.
- [ ] **Step 3: Typecheck and suite.**
- [ ] **Step 4: Commit.** `docs: @mogging/starlight README, AGENTS.md, README.md and TODO.md for plan 6b`.

---

## Execution notes

- Order: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13. Tasks 4-8 each modify a different command file but share
  `starlightFixtures.ts` (created in Task 2); run them sequentially.
- Tasks 10 and 11 need the npm registry and take minutes; they are run by the implementer once and by CI. They are
  not timing measurements; no timing figure is claimed from them.
- After Task 13: whole-branch review, AGY-CAPSTONE on the range, AGY-TEST-AUDIT, the owner's merge decision. The CI
  workflow's first real run, and the freeze of migration 0001 (ship step 3), happen after the owner pushes.

## Self-audit (2026-11-17)

- Spec coverage. 5.2: layout export and validation at load, exit 2 (Task 2); the static read, the drift warnings,
  export's skip of a locale missing from Starlight and exit 4 (Tasks 3, 5); `init --starlight` writes both locale
  lists from one answer and prints the block to paste (Task 8); an import with no source file exits non-zero (Task 4).
  5.3: `compile --include-untracked`, `track` (Task 7). 5.4: exit causes 0/1/4 and `--dry-run` / `--json` (Tasks 4, 5),
  the remaining causes are already raised by the SDK (attention, self-check). 5.5: `--prune` (Task 4). 5.6: `mogging
  rename`, the safety stop output and the confirmation flag `--accept-new-and-gone` (Tasks 4, 6). 5.7 and 7.1: README
  (Tasks 9, 13). 6: preset with extra fields, no-op integration with a root entry that imports nothing and prints
  nothing, separate `./preset` subpath, README, supported versions and the `init` warning (Tasks 1, 8, 13). 7:
  template, `.env` loading, CI acceptance with a mocked compile, the existing-adopter fixture (Tasks 9-12).
  `npx astro add` is a manual pre-release check (spec 7), recorded in TODO.md (Task 13).
- Builder's calls made here (spec 9): flag names (`--accept-new-and-gone`, `--dry-run`, `--restore`,
  `--include-untracked`, `--collection` on `track`, `--locales`/`--source-locale` on `init`); the preset's split of
  mixed Starlight objects is plan 6a's (separate top-level fields mapped to one YAML object); the static read is acorn;
  the template sits outside the workspace; the CI layout is one workflow with two jobs.
- Rulings recorded for the reviewer: the preset is the authoritative field list and a test pins it equal to plan 6a's
  fixture instead of moving the fixture (moving it would make `@mogging/markdown`'s tests import a package that depends
  on `@mogging/markdown`); a real `export` prints no `keep` lines but a count (a dry run prints them all); a stopped
  import is exit 4 when any other file was `created`, `updated` or `unchanged`.
- Line citations were read on main `361f6c3`; every task that modifies a cited region starts with the Step 0 check.
- Not decided here and why: the GitHub Actions majors are looked up at execution (they move); the template's page
  wording is the builder's (spec 9).
