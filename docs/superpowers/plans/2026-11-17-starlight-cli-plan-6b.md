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
  `node_modules`. (`@mogging/starlight` is a devDependency of the CLI, for tests only: Task 2.)
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
  `0.35.4`, Node `>=22.23.4` in their `engines` (Astro 7.4.4's floor); `@mogging/starlight` peer ranges `@astrojs/starlight: ">=0.43.0 <0.44.0"`, `astro: "^7.2.10"` (Starlight
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

// packages/cli/src/types.ts (Project gains two members; CommandSpec gains checkLoaded, Task 2)
export type Project = { sql; ctx; ai; starlight: StarlightLayout | undefined; root: string; configPath; close() };
export type LoadedConfig = { config: MoggingConfig; starlight: StarlightLayout | undefined; configPath: string; root: string; cwd: string };
// CommandSpec.checkLoaded?(flags: Flags, positionals: string[], loaded: LoadedConfig): void

// packages/cli/src/starlight/astroConfig.ts
export type AstroLocale = { key: string; lang: string; label: string | null }; // key "root" = no folder; lang defaults to key; label = a string-literal label, else null
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
  vitest files (`packages/markdown/tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`), except that
  `packages/starlight/tsconfig.json` sets NO `rootDir` (its test imports plan 6a's fixture from `../../markdown/test/`,
  which a `rootDir` of `.` refuses with TS6059; `tsconfig.base.json` sets none), with:
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
  - "the root entry imports nothing at run time": parse `src/index.ts` with `ts.createSourceFile` (`typescript` is a
    devDependency); every `ImportDeclaration` is type-only (`importClause.isTypeOnly`), no `ExportDeclaration` has a
    `moduleSpecifier` (a re-export, single- or multi-line, also loads a module), and no `CallExpression` calls
    `require` or `import`.
  - "loading and calling the root entry prints nothing": spy `console.log/info/warn/error/debug` and
    `process.stdout.write`/`process.stderr.write`; `await import("../src/index.js")` with `vi.resetModules()` first,
    call the default; every spy has 0 calls.
  `test/preset.test.ts`:
  - "the preset's collection equals plan 6a's fixture collection": `starlightPreset().collection` `toEqual` `docs`
    imported from `../../markdown/test/starlight/fixtures.js` (the field list of `packages/markdown/test/starlight/
    fixtures.ts:14-35`; the preset is that draft made public, 6a plan line 191-192).
  - "the preset's layout equals plan 6a's fixture layout": `starlightPreset().layout` `toEqual({ ...layoutInput,
    otherLocaleDirs: [] })` with `layoutInput` from the same fixture (`fixtures.ts:41-52`), so the `paths` (sidebar,
    badge, prev/next unions), `fileRefs` and `requiredWhenSource` are pinned, not only the fields.
  - "every Starlight front-matter key is mapped" (spec 3, Starlight `src/schema.ts:16-112`): for each of `title`,
    `description`, `editUrl`, `head`, `tableOfContents`, `template`, `hero`, `lastUpdated`, `prev`, `next`, `sidebar`,
    `banner`, `pagefind`, `draft`, the validated layout has an entry whose `path[0]` is that key.
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
- Modify: `packages/cli/src/types.ts:37-43` (`Project`), `:58-69` (`CommandSpec` gains `checkLoaded`),
  `packages/cli/src/project.ts:79-98` (`loadProject`), `packages/cli/src/run.ts:135` (pass the hook),
  `packages/cli/package.json` (devDependency `"@mogging/starlight": "workspace:*"`; run `pnpm install`, which updates
  `pnpm-lock.yaml`)
- Create: `packages/cli/test/starlightFixtures.ts`
- Test: `packages/cli/test/project.test.ts`

**Interfaces:** Produces `Project.starlight` and `Project.root` (block above), the test helpers below, and the hook
`CommandSpec.checkLoaded?(flags: Flags, positionals: string[], loaded: LoadedConfig): void` with `type LoadedConfig =
{ config: MoggingConfig; starlight: StarlightLayout | undefined; configPath: string; root: string; cwd: string }`
(`cwd` = `deps.cwd`, for checks that resolve a user path such as `--restore`; exported from
`types.ts`). `loadProject(deps, flags, check?: (loaded: LoadedConfig) => void)` calls `check` after validating the
layout and BEFORE `deps.connect`; `run.ts:135` passes the closure `(loaded) => spec.checkLoaded?.(flags, positionals,
loaded)` (`loadProject` itself never sees the positionals). So every usage error that depends on the loaded config (a
Starlight-only flag in a generic project, a directory argument in a Starlight project, an undeclared `--collection` or
`--locale`) is exit 2 without touching the database (`project.ts:75-78`). Tasks 4, 5, 6 and 7 put their
config-dependent usage checks there (Task 5's collection and locale checks of `export.ts:23-33` move there too). Consumes
`defineStarlightLayout` (`packages/markdown/src/starlight/layout.ts:120`), `starlightPreset` (Task 1).

`starlightFixtures.ts` exports: `starlightDocs = starlightPreset()`; `starlightConfig = defineConfig({ collections:
[starlightDocs.collection], locales: { source: "en", chains: { de: ["en"], "zh-CN": ["en"] } } })`;
`starlightProject(files: Record<string, string>): string` (a fresh `mkdtemp` project root holding `mogging.config.ts`
(empty) and each file at its project-relative path, removed after the test file); `starlightDeps(sql, root, overrides?)`
= `testDeps(sql, { cwd: root, loadModule: async () => ({ config: starlightConfig, starlight: starlightDocs.layout }),
...overrides })`; `page(title: string, extra = "", body = "Hello")` = `` `---\ntitle: ${title}\n${extra}---\n${body}\n` ``
(the shape of `packages/markdown/test/starlight/importLocale.test.ts:24`); `ASTRO_ROOT_DE_ZH` = exactly this text:

```js
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Docs",
      locales: {
        root: { label: "English", lang: "en" },
        de: { label: "Deutsch", lang: "de" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
      },
    }),
  ],
});
```

Every other `astro.config` a test needs is this text with the one change the test names.

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
  - "checkLoaded runs before connecting": a test command whose `checkLoaded` throws `UsageError("x")` (passed through
    `deps.commands`) exits 2 and the `connect` spy was never called; one whose hook passes runs normally.
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

The read, in order (spec 5.2 "best effort: a config they cannot read statically is reported once, not guessed"); the
first failing step gives the reason, so a test with two problems expects the earlier step's reason. Reasons, by step:
1 `no astro.config file`; 2 `could not be parsed`; 3 `export default is not defineConfig({...}) or an object literal`,
then `config holds a spread, computed or duplicate key`; 4 `srcDir is not a string literal`; 5 `no import of
@astrojs/starlight`, `no starlight() call in integrations`, then `starlight options holds a spread, computed or
duplicate key`; 6 `locales is not a literal object`, `locale <key> holds a spread, computed or duplicate key`, `the root
locale has no lang`, `defaultLocale is not a string literal`; 7 `could not be read: <message>`. A locale's `label` is
read when it is a string literal and is `null` otherwise (it is never a reason).
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
   `user-config.ts:201-208`), in source order; a `root` key without `lang` is reason `"the root locale has no lang"`
   (Starlight requires it, `user-config.ts:202`). `defaultLocale` absent = `null`, else a string literal. A spread, a
   computed key, an identifier, a call or a template literal with an expression anywhere in `locales` or
   `defaultLocale` = reason `"locales is not a literal object"` / `"defaultLocale is not a string literal"`.
   "Absent" is decided only on objects that are fully literal: a spread, a computed key or a duplicate key in the
   config object, in the `starlight({...})` options object or in a locale value means a key might be hidden there,
   so it is reason `"<config|starlight options|locale <key>> holds a spread, computed or duplicate key"`, never
   "absent" (otherwise a `...shared` spread carrying `locales` reads as a single-language site and export skips every
   locale).
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
    = "Docs";` and the `ASTRO_ROOT_DE_ZH` locales gives ok; because Node prints an experimental warning only once per
    process, the no-output half runs in a fresh child process: `execFileSync(process.execPath, ["--import", "tsx",
    "-e", <import readAstroConfig from the source file and call it on the folder>])` (`tsx` is a CLI devDependency)
    and its stderr is empty; in-process, `process.emitWarning` is the original function after the call.
  - "Astro's file order: .mjs wins over .ts": both present with different locales; the `.mjs` ones are returned.
  - "a single-language site has locales null": `starlight({ title: "Docs" })`.
  - one test per not-readable input, each asserting `ok: false` and the exact reason: no file (`file: null`); a
    syntax error; `locales: LOCALES` (imported constant); `locales: { ...more }`; `locales: { [k]: {} }`;
    `defaultLocale: DEFAULT`; `lang: \`${x}\``; no `starlight(` call; `export default someFunction()`; `srcDir: dir`;
    `starlight({ ...shared, title: "x" })` (starlight options); `defineConfig({ ...base, integrations: [starlight({})]
    })` (config); `starlight({ locales: { de: { ...l } } })` (locale de); `starlight({ locales: {}, locales: {} })`
    (starlight options: the duplicate is found before `locales` is read); `root: { label: "English" }` (the root
    locale has no lang).
  - "labels are read when literal": `ASTRO_ROOT_DE_ZH` gives `label` `"English"`, `"Deutsch"`, `"简体中文"`; a label
    that is an identifier gives `label: null` and the read stays ok.
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
- The two mode checks below are `importSpec.checkLoaded` (Task 2), so they are exit 2 before connecting.
- Generic project (`project.starlight === undefined`): the directory is required (`UsageError("import: missing
  argument\nusage: ...")`); any of the four new flags is `UsageError(\`import: --<flag> needs a Starlight project (an
  \`export const starlight\` in ${configPath})\`)`. Otherwise behaviour and output are exactly today's.
- Starlight project: a directory argument is `UsageError(\`import: a Starlight project imports from its docs folder
  (${layout.docsDir}); drop the directory argument\`)`. `dir` = `project.root`. Each `--restore` value `p`:
  `rel = path.relative(root, path.resolve(cwd, p))`; `rel` empty, starting with `..` or absolute is
  `UsageError(\`--restore ${p} is outside the project ${root}\`)`, raised in `checkLoaded` with `loaded.cwd`; else
  passed as `rel.split(path.sep).join("/")`.
- The `astroConfigWarnings` warnings are put at the FRONT of the report's `warnings` array before output, so `--json`
  carries them in `data.warnings` (only `lines` reach a non-JSON run, `run.ts:146-149`).
- Output lines, in order: `dry run: nothing was written` (dry run only); `<outcome> <file>` per file; `pruned <slug>` per pruned slug; for a stop: `stopped:
  <g> page(s) gone and <a> new file(s); nothing was created or pruned`, then `  gone <slug> "<title or (no title)>"`
  and `  new <file> "<title or (no title)>"` lines, then `run: <command>` when `command` is set, else `pair them with
  mogging rename <old> <new>, or pass --accept-new-and-gone`; `behind <file>` per `starlight.behind` entry (spec 5.4:
  a locale file that equals an earlier published version is reported); then the report's warnings as `warning:
  <file>: <message>` (the astro warnings first, since they were put at the front, then the SDK's, which already hold
  the one unsupported-extensions warning, `importStarlight.ts:169`; each printed once) and errors as today.
- Exit (spec 5.4, `:255-256`: exit 4 for "an import safety stop when other files were imported", exit 1 "when nothing
  else was imported"): with a stop, exit 4 when any file outcome is `created` or `updated` (an `unchanged` file was not
  imported), else exit 1 with
  `error: { code: "ImportStopped", message: "rename safety stop: nothing was imported" }`. Without a stop, today's rule
  (`import.ts:25-37`). A run with no source file throws `ValidationError` in the SDK (`importStarlight.ts:160-161`): exit 1
  through `exitCodeFor`.

- [ ] **Step 1: Write the failing tests** (database; projects from `starlightProject`; `D = "src/content/docs"`):
  - "a plain import imports the docs folder and publishes English": files `D/a.md`, `D/de/a.md` and
    `astro.config.mjs` = `ASTRO_ROOT_DE_ZH`; exit 0; stdout lines include `created src/content/docs/a.md` and no
    `warning:` line.
  - "a directory argument in a Starlight project is exit 2": stderr contains `imports from its docs folder`.
  - "Starlight flags in a generic project are exit 2 naming the export": `--prune`, `--dry-run`,
    `--accept-new-and-gone`, `--restore x` each exit 2 with stderr containing `needs a Starlight project` (every
    exit-2 test in this plan asserts its message, so it cannot pass on an unrelated usage error).
  - "a plain --prune deletes a gone page": import `a.md` and `b.md`, delete `b.md`, `import --prune`; exit 0; stdout
    has `pruned b`; `getDocument(ctx, { collection: "docs", slug: "b" })` is null.
  - "an ambiguous stop lists both sides without a command": import `a.md`, `c.md`; delete both, add `b.md`; exit 1;
    stdout has `pair them with mogging rename <old> <new>, or pass --accept-new-and-gone` and no `run:` line.
  - "a dry run predicts the stop's exit": the first stop case with `--dry-run` exits 4 and changes nothing.
  - "--dry-run writes nothing and says so": exit 0, first stdout line `dry run: nothing was written`, `select count(*)
    from documents` is 0.
  - "the safety stop with other files imported exits 4 and prints the command": import `a.md` and `c.md`, rename
    `a.md` to `b.md` and edit `c.md`; exit 4; stdout contains `run: mogging rename a b`; with `--json`, `ok: true`,
    `partial: true`, `data.starlight.stop.command === "mogging rename a b"`.
  - "a safety stop with nothing else exits 1 with ImportStopped": only `a.md`, renamed to `b.md`; exit 1; `--json`
    error code `ImportStopped`.
  - "a safety stop where every other file is unchanged exits 1": import `a.md` and `c.md`, rename `a.md` to `b.md`
    only; `c.md` is `unchanged`; exit 1.
  - "a behind locale file is reported": publish a second German version through the SDK, put the first version's
    text back in `D/de/a.md`; stdout has `behind src/content/docs/de/a.md`.
  - "an unsupported extension is reported once": `D/b.markdown` gives exactly one stdout line containing `does not
    import` (the SDK's warning, `importStarlight.ts:169`).
  - "astro warnings reach --json": with the drift case below and `--json`, `data.warnings[0].file` is
    `astro.config.mjs`.
  - "--accept-new-and-gone creates the new page, and --prune also deletes the gone one".
  - "--restore takes a path relative to the working directory": `cwd` = `<root>/src/content/docs` with `--config
    <root>/mogging.config.ts` (config discovery looks only in `cwd`), `--restore
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
  --collection`), raised in `exportSpec.checkLoaded` as are the generic-mode ones. `dir` = `project.root` (never the
  docs folder: the SDK joins `layout.docsDir` itself, `exportStarlight.ts:567-573`). `{ localeDirs, warnings } =
  astroConfigWarnings(root, layout)`; pass `starlightLocaleDirs: localeDirs`; put `warnings` at the front of the
  report's `warnings` (as Task 4), so `--json` carries them.
- Output lines: dry-run header as in Task 4; one line per action `<action> <path>[ -> <to>]
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
  - "a directory argument and --collection are exit 2 in a Starlight project", each asserting its message.
  - "--dry-run in a generic project is exit 2" with `needs a Starlight project` (Review Focus 4).
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
project (an \`export const starlight\` in ${configPath})\`)`, raised in `renameSpec.checkLoaded`; else `renamePage` with `dir: project.root`. Lines: the
dry-run header; `move <path> -> <to>` per action; `reference <file>:<line>: <text>` per reference; the warnings as
`warning: <file>: <message>`; the reminder last. Exit 0; the SDK's `ValidationError` and `ConflictError` give exit 1.

- [ ] **Step 1: Write the failing tests:**
  - "rename moves the English and German files and the slug": after a day-one import of `D/guides/a.md`,
    `D/de/guides/a.md`, `rename guides/a guides/b` exits 0; both files exist under `guides/b.md`; stdout has `move
    src/content/docs/guides/a.md -> src/content/docs/guides/b.md`; `getDocument(ctx, { collection: "docs", slug:
    "guides/b" })` is not null.
  - "references in astro.config and in Markdown under the docs folder are listed" (spec 5.6): `astro.config.mjs`
    holding `slug: 'guides/a'` and `D/other.md` linking `/guides/a/`; stdout has `reference astro.config.mjs:` and
    `reference src/content/docs/other.md:` and the reminder line.
  - "--dry-run moves nothing and saves nothing".
  - "a differing target is exit 1 naming both files": an existing different `D/guides/b.md`; exit 1; stderr names both
    paths.
  - "a generic project is exit 2" with stderr `rename needs a Starlight project` (an unregistered `rename` is also
    exit 2, with `unknown command`, so the message is what the test pins); "help lists rename" (`run(["help"])`
    stdout contains `rename`).
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
  `validate` (no project needed): exactly one of the positional and `--collection` (`track: give <collection>/<slug> or --collection <c>`
  when neither, `track: give <collection>/<slug> or --collection <c>, not both` when both); `--fields` and `--dry-run`
  only in their own form (`track: --fields needs <collection>/<slug>`, `track: --dry-run needs --collection`). Run of
  the collection form: an undeclared collection is a `UsageError` naming the declared ones (as `export.ts:23-29`),
  raised in `trackSpec.checkLoaded` from `loaded.config`;
  one `getSyncState` call; the `untracked` rows grouped by document; slugs from `getDocuments` in chunks of 1000;
  documents in slug order; `trackFields` once per document unless `--dry-run`. Lines `tracked <collection>/<slug>
  <locale> <field>` (`would track ...` in a dry run, after the header `dry run: nothing was written`); none at all:
  `nothing untracked in <collection> (<locale>)`. `data`: `{ tracked: Array<{ docId, slug, locale, fields }> }`.

- [ ] **Step 1: Write the failing tests:**
  - compile: "untracked fields are queued only with --include-untracked": `publishedDoc(sql)` (English title and
    body, `packages/cli/test/fixtures.ts:69-77`) plus a `de` head saved with `untracked: true` holding BOTH `title`
    and `body`, then published, so no field is `missing` (a missing field is queued without the flag,
    `packages/ai/src/jobs.ts:154`); `compile --locales de --budget 1` queues 0
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
- read ok, `locales` holding at least one language besides the default (multilingual): `--locales` or
  `--source-locale` given is `init --starlight: astro.config declares
  Starlight's locales; drop --locales and --source-locale (or edit astro.config)`. Root mode when `defaultLocale` is
  `null` or `"root"`: needs a `root` key (else `init --starlight: astro.config has locales but neither a root locale
  nor defaultLocale`); `source = normalizeLocale(root.lang)`, `sourceDir = null`. Own-folder mode when
  `defaultLocale` is another key: that key must exist and there must be no `root` key; `sourceDir` = that key;
  `source` from its `lang`. Targets: every other key, in order, `{ tag: normalizeLocale(lang), dir: key }`.
  `pasteBlock = null`.
- read ok, single-language: `--locales` required (`init --starlight: this site has one language; pass --locales
  de,fr (the languages to add)`); targets from the comma list, each `{ tag: normalizeLocale(t), dir:
  tag.toLowerCase() }` (a `ValidationError` of `normalizeLocale` on any flag value becomes `UsageError(\`init
  --starlight: --locales: ${message}\`)`, likewise for `--source-locale`). Two shapes:
  - `locales` null: `source = normalizeLocale(flags.sourceLocale ?? "en")`; root mode; `pasteBlock` holds the whole
    block to ADD to the `starlight()` options, `root` first: `      root: { label: "<label>", lang: "<source>" },`
    then `      "<dir>": { label: "<label>", lang: "<tag>" },`, framed by `    locales: {` and `    },`; the header line
    is `add this to the starlight() options in astro.config:`.
  - `locales` holding only the default language (only `root`, or only the `defaultLocale` key): `--source-locale` is
    refused as in the multilingual case; `source` = that entry's `lang`; `sourceDir` = `null` for `root`, else the
    `defaultLocale` key; `pasteBlock` is the whole block to REPLACE the existing one (the existing entry first, under
    its own key, then the new ones), header `replace the locales block of the starlight() options in astro.config
    with:`.
  `<label>` is `new Intl.DisplayNames([tag], { type: "language" }).of(tag)`; the header is stored with the block
  (`pasteBlock` is the header line plus the block lines, joined by `\n`).
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

`STARLIGHT_RANGE = { min: "0.43.0", below: "0.44.0" }`. `starlightVersionWarning(root)`: looks for
`node_modules/@astrojs/starlight/package.json` in `root` and then in each parent folder up to the file-system root (a
hoisted monorepo install; Starlight's `exports` has no `./package.json`, so `createRequire(...).resolve` cannot be
used); missing: `@astrojs/starlight is not installed in <root>; install
it before building the site`; a version that does not parse as `x.y.z` numbers, is below `min` or not below `below`:
`@astrojs/starlight <version> is outside the range @mogging/starlight supports (>=0.43.0 <0.44.0)`; else `null`.

`init`: options gain `starlight` (boolean), `locales` (string), `"source-locale"` (string); usage `mogging init
[--starlight [--locales de,fr] [--source-locale en]] [--json] [--config <path>] [--database-url <url>]`; `validate`:
`--locales`/`--source-locale` without `--starlight` is `init: --locales needs --starlight`. With `--starlight`: the
database URL check first (as `init.ts:70`); an existing config is left byte-identical with the line `<path> already
exists: left unchanged; --starlight wrote nothing` and the run still migrates; otherwise read `astro.config` in the
folder of the config file to be written (`dirname` of the `--config` path, else `cwd`),
compute the answers (usage errors before any write and before connecting), write `starlightConfigText` with the same
`wx` rule as `writeTemplate` (`init.ts:42-59`), then load it once with `deps.loadModule(path)` and validate its
`starlight` export with `defineStarlightLayout(mod.starlight, mod.config)`: if either throws (most
often `@mogging/starlight` or `@mogging/core` is not installed where the config can import it), delete the file this
run just created (the delete is wrapped in its own try/catch, so a failed delete never replaces the usage error) and
throw `UsageError(\`init --starlight: the written config does not load (${message}); install
@mogging/starlight and @mogging/core next to it (npm install -D @mogging/starlight @mogging/core) and run init
--starlight again\`)`. (Loading the real file covers every import the config makes and every package exports shape;
a `createRequire().resolve` pre-check would refuse the published `import`-only exports map: measured on Node 24.21.0,
`ERR_PACKAGE_PATH_NOT_EXPORTED`.) After a successful load, write the answer warnings, the version warning and the
paste block to stderr at once (so a later migration failure does not lose them), then load the project and migrate as
today. Stderr: `warning: <w>` per answer warning and the version warning, then the `pasteBlock` lines. Stdout lines:
`created <path>`, then the migration lines. With `--starlight`, `data` gains `starlight: { source, targets, sourceDir,
docsDir, pasteBlock }`, or `starlight: null` when the config already existed.

- [ ] **Step 1: Write the failing tests** (every `init --starlight` test runs with the real jiti loader in a folder
  under `packages/cli`, as `packages/cli/test/init.test.ts:11-31` does, so `@mogging/core` and `@mogging/starlight`
  resolve; only the not-loadable test uses `os.tmpdir()`):
  - "a root-locale site gets a config that loads and validates": `astro.config.mjs` = `ASTRO_ROOT_DE_ZH`; `init
    --starlight` exit 0; the written file loaded with jiti has `config.locales` `{ source: "en", chains: { de: ["en"],
    "zh-CN": ["en"] } }` and `defineStarlightLayout(mod.starlight, mod.config).localeDirs` `{ de: "de", "zh-CN":
    "zh-cn" }`.
  - "an own-folder site (defaultLocale en) gets sourceDir en".
  - "the folder map is read, not derived" (spec 5.2): `"zh-cn": { label: "简体中文", lang: "zh-Hans-CN" }` gives
    `localeDirs` `{ "zh-Hans-CN": "zh-cn" }` and `chains` with `"zh-Hans-CN"`; `srcDir: "./site"` gives the written
    `docsDir: "site/content/docs"`.
  - "a bad --locales tag is exit 2": `--locales de,not_a_tag` on a single-language site exits 2 with `--locales:`.
  - "a single-language site needs --locales and gets the block to add": without it exit 2 and no file; with
    `--locales de` exit 0 and stderr contains `add this to the starlight() options` and `"de": { label: "Deutsch",
    lang: "de" },`; `data.starlight.pasteBlock` equals the stderr block.
  - "a locales block with only the default language keeps its source": `root: { label: "Français", lang: "fr" }` with
    `--locales de` gives `source` `fr`, stderr says `replace the locales block`, and the block's first entry is
    `root: { label: "Français", lang: "fr" }` (the existing entry keeps its own `label`, read by Task 3; a new entry's
    label comes from `Intl.DisplayNames`); `{ en: { lang: "en" } }` with `defaultLocale: "en"` gives `sourceDir`
    `en`; `--source-locale` next to either is exit 2.
  - "a config that does not load is removed again": from an `os.tmpdir()` folder (where `@mogging/starlight` does not
    resolve), exit 2, stderr contains `the written config does not load`, and no `mogging.config.ts` exists.
  - "the warnings survive a failed migration": with a `connect` whose queries reject, the run fails, and stderr
    still holds the paste block and the version warning.
  - "an unreadable astro.config needs --locales": exit 2 without; exit 0 with `--locales de`, plus the warning line.
  - "--locales next to readable locales is exit 2"; "--locales without --starlight is exit 2".
  - "an existing config is left unchanged and says --starlight wrote nothing"; `--json` `data.starlight` is `null`.
  - "the version check": `node_modules/@astrojs/starlight/package.json` with `0.44.1` gives the outside-range line;
    without the file, the not-installed line; `0.43.2` gives none; `0.43.2` in the PARENT folder's `node_modules`
    gives none (hoisted).
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
`"mogging": "node --env-file=.env node_modules/@mogging/cli/dist/bin.js"`; `"engines": { "node": ">=22.23.4" }`
(Astro 7.4.4's own floor, `astro/packages/astro/package.json:220`); dependencies `astro 7.4.4`, `@astrojs/starlight
0.43.0`, `sharp 0.35.4` (Astro 7.4.4 asks `^0.35.4`, `astro/package.json:182`), `@mogging/starlight 0.0.0` (the
site's CI must install it, spec 6);
devDependencies `@mogging/cli`, `@mogging/core`, `@mogging/ai` at `0.0.0` (the versions are set at publish, ship step
4). `compose.yaml`: one `postgres:17` service, user/password/database `mogging`, port `5432:5432`, a named volume.
`.env.example`: `DATABASE_URL=postgres://mogging:mogging@localhost:5432/mogging` and commented
`OPENROUTER_API_KEY=` and `MOGGING_LICENSE_KEY=` lines. `.gitignore`: `node_modules/`, `dist/`, `.astro/`, `.env`.
`README.md` (spec 6 and 7): the first section after the title is the licence (the terms in one paragraph and the
zero-price noncommercial key, linking `LICENSE.md` of the package), then: `cp .env.example .env`, `docker compose up
-d`, `npm install` (Node 22.23.4 or later), "replace the sample pages with yours", then the session `npm run mogging -- migrate`, `... import`,
add the `ai` export (uncomment the block, set `OPENROUTER_API_KEY` and a monthly cap), `... compile --locales
de,zh-CN --budget <usd>`, `... review` (interactive) or `... review --approve-clean`, then publish the approved
drafts in one release (`... release create first`, `... release add first --all-approved`, `... release publish
first`, `packages/cli/src/commands/release.ts:144-151`; a new release name for every batch, since a name can be
used once, `releases.ts:47`; a bare `publish` is a usage error, `publish.ts:115`), `...
export`, `npm run build`, commit; the 30-day evaluation and
what stops after it; the supported team setup (spec 5.7) and the known limits (spec 7.1), each in a short section.

- [ ] **Step 1: Write the failing tests** in `template.test.ts`:
  - "the template's astro.config reads statically and matches its Mogging config": `readAstroConfig("<repo>/templates/
    starlight")` is ok with locales `root/en`, `de/de`, `zh-cn/zh-CN`; the template's `mogging.config.ts` loaded with
    `createJiti(import.meta.url, { alias: { "@mogging/core": <core src/index.ts>, "@mogging/starlight/preset":
    <starlight src/preset.ts> } })` validates with `defineStarlightLayout`, and `localeDrift(read, layout)` is `[]`.
  - "mogging.config.ts is what init --starlight writes": equals `starlightConfigText` of the answers above.
  - "package.json pins": the exact versions above, `engines.node` `>=22.23.4` and the `mogging` script string.
  - "the database URL agrees across .env.example and compose.yaml": user, password, database and port.
  - "README puts the licence first and the session in order": the first `## ` heading contains `Licence`; among the
    README's command lines (lines inside fenced code blocks that start with `npm run`), the first line containing
    each of `-- migrate`, `-- import`, `-- compile --locales`, `-- review`, `-- release publish`, `-- export`, `npm
    run build` appears in that order; no command line holds `-- publish` without a target or `--release`; a release
    name is written as a placeholder the README explains (`release create <name>`, a new name per batch, since a
    second `release create` with the same name is a `ConflictError`, `packages/core/src/releases/releases.ts:47`).
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
`starlight` into `dest`, returns `{ [name]: absoluteTarballPath }`), `requireFrom(root, pkg, name)` (loads a
dependency of a workspace package, such as `postgres` or `yaml`, through `createRequire` of
`packages/<pkg>/package.json`, as `pack-smoke.mjs:44-45` does: the repository root resolves neither),
`throwawaySchema(baseUrl)` (creates an `accept_<hex>` schema and returns `{ url, tables(schema?), drop() }`,
`tables` counting the tables of the given schema, default the throwaway one, the URL carrying `search_path`, as
`pack-smoke.mjs:73-78`), `siteEnv(extra)` (an allowlisted child environment: `PATH`, `HOME`, `MOGGING_ACTOR=accept`,
the proxy and CA variables when set (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` in either case, `NODE_EXTRA_CA_CERTS`,
`npm_config_cafile`), plus `extra`, and never the inherited `DATABASE_URL`, because `node --env-file` does not
override a variable that is already set: measured, `X=inherited node --env-file=.env` prints `X=inherited`) and
`installSite(siteDir, tarballs, extraDev)` (removes every `@mogging/*` entry from the site's `dependencies` and
`devDependencies`, then adds all five tarballs as `file:<tarball>`: `@mogging/starlight` under `dependencies`, the
other four under `devDependencies`, because the packed CLI names `@mogging/markdown` at version `0.0.0`, which npm
would otherwise look for in the registry; adds `extraDev`; runs `npm install --no-audit --no-fund`). The cleanup of
both scripts removes the copied `LICENSE.md` of all five packages. `pack-smoke.mjs` is left unchanged.

The run (spec 7: "import, a mocked compile, approve, export, astro build" against the packages at HEAD), each step
printing `OK <step>` and failing the script with a message on a wrong exit or output:
1. `DATABASE_URL` required (exit 2 otherwise, as pack-smoke). Build and pack; copy `templates/starlight` to
   `<tmp>/site` (no `node_modules`); `installSite(site, tarballs, { ai: "7.0.154" })`.
2. Throwaway schema; write `<site>/.env` with its URL, so every command below runs through the template's own
   script as `npm run --silent mogging -- <args>` (one helper; `--silent` because npm prints its `> name script`
   banner to stdout, which would break every `--json` parse: measured with npm 11.19.0) with `siteEnv({})` (no
   `DATABASE_URL` inherited), proving the `.env` loading.
3. `migrate`; then `tables()` of the throwaway schema is above 0 and `tables("public")` is unchanged
   (the `.env` URL was used); `import` exits 0 and reports `created` for the three English files.
4. Write `<site>/mogging.accept.config.ts`: re-exports `config` and `starlight` from `./mogging.config.ts` and adds an
   `ai` export: `defineAiConfig({ provider: { kind: "custom", models: { "mock/translate": model } }, models: {
   translate: "mock/translate" }, prices: { "mock/translate": { inputUsdPerMtok: 1, outputUsdPerMtok: 2,
   contextTokens: 128000 } }, budgets: { monthlyCapUsd: 5 } })`, where `model` is a `MockLanguageModelV3` (`ai/test`)
   whose `doGenerate` reads the user message's `<<<DATA\n...\nDATA>>>` block (`packages/cli/test/mockModel.ts:66-85`)
   and answers `{ fields, glossaryTermsUsed: [] }`, `fields` being the request's `translate` object in which every
   string leaf WITHOUT a line break is prefixed `Übersetzt: ` and every multi-line leaf (a body) is returned
   unchanged (a prefix in front of a body could turn its first heading into a paragraph and fail validation), with
   the usage block of `mockModel.ts:15-22`. The titles carry the mark into the built pages.
5. `compile --locales de,zh-CN --budget 1 --config mogging.accept.config.ts` exits 0.
6. `review list --json` before approving lists 6 `DRAFT_AI` items (three pages, two locales); `review --approve-clean
   --json` reports `data.approved === 6`; then the README's release flow: `release create accept`, `release add
   accept --all-approved`, `release publish accept`, all exit 0; `review list --state APPROVED --json` is then
   empty.
7. `export` exits 0; `src/content/docs/de/guides/getting-started.md` and `.../zh-cn/guides/getting-started.md` exist
   and contain `Übersetzt: `; `.mogging/manifest.json` exists. A second `export --json` exits 0 with every action
   `keep` (nothing rewritten); `status --json` `data.rows` holds at least one `current` row for each of `de` and `zh-CN` and no row of those
   locales whose `state` is `stale` or `missing` (`packages/cli/src/commands/status.ts:80`).
8. `npx astro build` exits 0; `dist/de/guides/getting-started/index.html` and
   `dist/zh-cn/guides/getting-started/index.html` each contain `Übersetzt: `; `dist/index.html` exists and does not contain `Übersetzt: `.
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
- `guides/setup.md`: `title: Setup`, `sidebar: { order: 2, label: Setup, badge: New }`; German `title: Einrichtung`,
  `sidebar: { order: 2, label: Einrichtung, badge: Neu }`.
- `guides/images.md`: `![Diagram](./diagram.svg)` with `guides/diagram.svg` beside it; German
  `![Diagramm](../../guides/diagram.svg)`.
- `guides/components.mdx`: `import Note from '../../../components/Note.astro';` and `import { Card } from
  '@astrojs/starlight/components';` (German: `'../../../../components/Note.astro'` and the same package import).
- `reference/levels.md`: `difficulty: beginner` (the extended key; stored in the preset's passthrough).
- `guides/wip.md` (English, not a draft) and German `de/guides/wip.md` with `draft: true`.

The run (spec 7: "init --starlight, the day-one import, a rename and an export, then astro build"):
1. Build, pack, copy the fixture to `<tmp>/site`, convert `src/content/docs/de/guides/setup.md` to CRLF line endings,
   `installSite(site, tarballs, {})` (all five tarballs, Task 10). Throwaway schema; commands run as
   `node_modules/.bin/mogging` with `siteEnv({ DATABASE_URL: <the schema URL> })`; after step 2's migration,
   `tables()` is above 0 and `tables("public")` is unchanged.
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
8. `npx astro build` exits 0; `dist/de/guides/installation/index.html` has `Einrichtung` inside its `<h1`
   element (the page title; the sidebar label comes from `astro.config`'s explicit entry, Starlight
   `navigation.ts:165-169`);
   `dist/de/guides/images/index.html` contains `<img`; `dist/de/guides/wip/index.html` is Starlight's fallback to the
   English page, not the German draft: it contains a sentence of English `guides/wip.md` and no sentence of the German
   draft (Starlight drops drafts in production, `starlight/packages/starlight/src/utils/routing/index.ts:38-39`, then
   adds a fallback route for the missing locale page, `:50-78`).
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
- `starlight` (`needs: check`): the same setup, an `actions/cache` step for `~/.npm` keyed on the hash of
  `templates/starlight/package.json` and `scripts/fixtures/starlight-adopter/package.json` (both scripts install Astro,
  Starlight and sharp from the registry), then `pnpm accept:starlight` and `pnpm accept:adopter`.
Node `22` resolves to the newest 22.x, which satisfies Astro's `>=22.23.4`; a first step prints `node -v`.
Pin each action to its current major (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`,
`actions/cache`): look the majors
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
- Modify: `packages/cli/README.md` (the command list: Starlight `import`/`export` flags, `rename`, `init --starlight`,
  `track --collection`, `compile --include-untracked`; `:20` "packs the four packages" stays true for `smoke:pack`,
  and the two acceptance scripts are added beside it),
  `AGENTS.md:37-48` ("Package layering": the new package), `AGENTS.md:11-35` ("Commands": `accept:starlight`,
  `accept:adopter`),
  `AGENTS.md:105` (the Starlight status line: implemented), `README.md` (project structure and scripts sections),
  `TODO.md` (Plan 6a follow-ups: drop "export's input.locales not normalized"; add the items below)
- Test: `packages/starlight/test/readme.test.ts` (new)

`packages/starlight/README.md` (spec 6): the licence terms and the zero-price noncommercial key before the install
command; then the first session in order (install `@mogging/cli`, `@mogging/core`, `@mogging/ai` and
`@mogging/starlight` as dev dependencies (the written config imports `@mogging/core`, and its AI block
`@mogging/ai`), with
`@mogging/starlight` in the site's dependencies when `npx astro add` is used; Postgres from the template's
`compose.yaml` or a hosted `DATABASE_URL`; `mogging init --starlight` (a single-language site adds `--locales
de,fr` and pastes the printed block into `astro.config`); `mogging migrate`; the `ai` export with a
provider key and a monthly cap; `mogging import`; `mogging compile --locales <tags> --budget <usd>`; `mogging
review`; the release flow of Task 9 (`release create`, `release add --all-approved`, `release publish`); `mogging
export`; commit); the evaluation and what stops after it (design 12.3: guarded writers refuse, export and the built
site keep working); supported versions (`@astrojs/starlight >=0.43.0 <0.44.0`, Astro `^7.2.10`; `init --starlight`
warns outside them); day one (`untracked`, `mogging track --collection docs --locale <l>`, `compile
--include-untracked`); renames (`mogging rename`, the safety stop, `--accept-new-and-gone`); deletions (`--prune` is
final); adding a language later (spec 5.2: add it to `mogging.config.ts`'s `chains` and `localeDirs` and to
Starlight's `locales`); your own front-matter keys (spec 6: shared ones land in the `extra` passthrough with no
change; a localized one goes in `starlightPreset({ extraFields })`); where the licence key goes (`MOGGING_LICENSE_KEY`,
the link the CLI prints); the supported team setup (spec 5.7); the known limits (spec 7.1). AGENTS.md layering line: `starlight` depends
on `core` and `markdown` (types); the CLI does not depend on it at run time.
TODO.md additions: the template's `@mogging/*` versions are `0.0.0` until publish (ship step 4); `npx astro add
@mogging/starlight` is checked by hand before release (spec 7); per-page `publish` after `review --approve-clean` (a
bulk publish of approved drafts would help large sites).

- [ ] **Step 1: Write the failing test** `readme.test.ts`: the first `## ` heading of `packages/starlight/README.md`
  contains `Licence`; among command lines (lines in fenced code blocks), the first holding each of `init --starlight`,
  `migrate`, `import`, `compile --locales`, `review`, `release publish`, `export` appear in that order; the text
  contains `>=0.43.0 <0.44.0`, `extraFields`, `MOGGING_LICENSE_KEY` and a section heading containing `language`.
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
  import is exit 4 when any other file was `created` or `updated` (round 1).
- Line citations were read on main `361f6c3`; every task that modifies a cited region starts with the Step 0 check.
- Not decided here and why: the GitHub Actions majors are looked up at execution (they move); the template's page
  wording is the builder's (spec 9).

## Review ledger

- Panel round 1 (2026-11-17; persona relentless-adversarial-auditor; Sonnet solo seats Axiom Breaker, Cascade
  Analyst, Literal Implementer (13 findings) and Protocol Pedant, Dependency Cynic, Boundary Smuggler, Activation
  Auditor (12 findings); agy seats Mechanism Gamer, State Corruptor, Blindspot Auditor, Resource Vampire (4 findings);
  brief `.clavity/seams/plan6b-panel-r1.md`, replies `.clavity/scratch/plan6b-panel/`). Every finding was checked
  against the code, the Astro/Starlight sources or a measurement before folding; all FOLDED:
  - The wip draft's German page is replaced by Starlight's English fallback, not absent (`routing/index.ts:50-78`):
    Task 11 step 8 asserts the fallback.
  - A spread, computed or duplicate key could hide `locales` and read as a single-language site: unreadable (Task 3).
  - A `root` locale without `lang` is invalid Starlight config (`user-config.ts:202`): unreadable (Task 3).
  - A `locales` block holding only the default language is the single-language case (Task 8).
  - The preset test pinned the fields only: it now pins the whole layout input and every spec 3 front-matter key.
  - `rootDir: "."` refuses the cross-package fixture import (TS6059, measured by a seat): no `rootDir` (Task 1).
  - A safety stop counted `unchanged` files as imported (spec 5.4 `:255-256`): only `created`/`updated` (Task 4).
  - `node --env-file` does not override an inherited variable (measured `X=inherited`): `siteEnv` allowlist and a
    schema check (Tasks 10, 11).
  - `init --starlight` could write a config that cannot load, and lose its paste block on a later failure: preset
    resolution check before the write, warnings and the block to stderr at once, `pasteBlock` in `data` (Task 8).
  - The Starlight version check missed hoisted installs (no `./package.json` export): walk up (Task 8).
  - `installSite` missed `@mogging/markdown` (the packed CLI names it at `0.0.0`): all five tarballs (Task 10).
  - The CLI devDependency had no `pnpm install` step (Task 2); the scripts need `postgres`/`yaml` through
    `createRequire` (Task 10); the mock run's counts and JSON fields are pinned (Task 10).
  - Astro 7.4.4 needs Node `>=22.23.4` and `sharp ^0.35.4` (`astro/package.json:220`, `:182`): template `engines`,
    `sharp 0.35.4` (Tasks 9, 12).
  - Config-dependent usage errors ran after connecting: `CommandSpec.checkLoaded` before `deps.connect` (Tasks 2, 4-7).
  - The `--restore` cwd test needs `--config`; `behind` files are now printed; the unsupported-extensions line was a
    duplicate of the SDK's warning (Task 4).
  - Export's `dir` is the project root (Task 5); the template run asserts the `zh-cn` build too (Task 10); the rename
    test covers a Markdown reference (Task 6); the README installs `@mogging/core` and `@mogging/ai` (Task 13); CI
    caches `~/.npm` (Task 12); the root entry may not re-export (Task 1).
  - Anomalies reported by the seats, checked: the `importStarlight.ts:161` citation is `:160-161` (folded); the
    `files` list naming `README.md` before Task 13 writes it is harmless (`npm pack` skips a missing listed file);
    shortened tool output is the session's output condenser, not a defect. Nothing was captured.

- Panel round 2 (2026-11-17; Sonnet solo seats Axiom Breaker, Cascade Analyst, Fold Verifier (bespoke): 13
  findings; agy seats Adopter Walkthrough (bespoke), Protocol Pedant second pass: 3 findings; brief
  `.clavity/seams/plan6b-panel-r2.md`). agy's reply was flagged ECHO MISSING; its echo was the plan's last line with
  the backticks dropped (checked against the file), so it read to the end and its findings were verified and folded
  like the others. All FOLDED:
  - The READMEs documented a bare `publish` and `compile` (usage errors, `publish.ts:115`, `compile.ts:25-26`): the
    release flow (`release create`, `release add --all-approved`, `release publish`) and `compile --locales --budget`
    in both READMEs and in Task 10's run (Tasks 9, 10, 13).
  - `checkLoaded` could not see the positionals or the config: `run.ts` passes a closure, and `LoadedConfig` carries
    `config`, so Task 5's and Task 7's collection and locale checks run before connecting too (Task 2).
  - The preset-resolution pre-check would refuse the published `import`-only exports map (measured
    `ERR_PACKAGE_PATH_NOT_EXPORTED` on Node 24.21.0) and never checked `@mogging/core`: init loads the written config
    once and deletes it when it does not load (agy's simpler option, Q2) (Task 8).
  - The default-only `locales` fold contradicted the multilingual bullet and lost the existing source: that case keeps
    the entry's `lang` and folder, refuses `--source-locale`, and prints a REPLACE block (Task 8).
  - Init's stderr block had no test of surviving a failed migration, and `data.starlight` was undefined for an
    existing config (`null` now) (Task 8).
  - The astro warnings reached only `lines`, never `--json`: they go to the front of the report's `warnings`
    (Tasks 4, 5); an unsupported extension is asserted to appear once (Task 4).
  - `npm run` prints its banner to stdout (measured, npm 11.19.0): `npm run --silent` in one helper (Task 10).
  - Task 11 had no schema check; `tables(schema?)`; `siteEnv` passes proxy and CA variables (Tasks 10, 11).
  - The mock's prefix on a multi-line body could break its structure: only single-line leaves are prefixed (Task 10).
  - Task 10 adds a second `export` that rewrites nothing and a `status` with no stale or missing row (Q3).
  - The root-entry test parses `index.ts` with the TypeScript API (multi-line re-exports) (Task 1); the template test
    pins `engines` (Task 9); `packages/cli/README.md` is updated (Task 13); the self-audit ruling on the stop exit now
    says `created`/`updated`.
  - Anomaly reported by a seat, checked: `packages/cli/README.md` lists the pre-6b commands (folded into Task 13).

- Panel round 3 (2026-11-17; Sonnet solo seats Axiom Breaker, Spec Line Tracer (bespoke), Test-First Auditor
  (bespoke): 16 findings; agy seats Cascade Analyst, Re-run Auditor (bespoke): 2 findings and a below-floor note;
  brief `.clavity/seams/plan6b-panel-r3.md`). All FOLDED:
  - The REPLACE block needs the existing locale's label, which the reader dropped (`Intl.DisplayNames` gives
    `français`, measured by a seat): `AstroLocale.label` (Tasks 3, 8).
  - The astro warnings were printed twice or out of order: printed once, first among the report's warnings
    (Tasks 4, 5).
  - The `--restore` outside-project check needs the working directory: `LoadedConfig.cwd` (Tasks 2, 4).
  - `normalizeLocale` throws `ValidationError` (exit 1) for a bad flag tag: wrapped as a usage error; the load probe
    also validates the layout, so an invalid config is deleted too; the delete is wrapped (agy CA-2) (Task 8).
  - A release name can be used once (`releases.ts:47`, agy CA-1): the READMEs say a new name per batch (Tasks 9, 13).
  - `AGENTS.md` "Commands" is at `:11-35`; the CLI devDependency is added in Task 2 (F1 text).
  - Untested spec lines: the explicit folder map and `srcDir` in init (Task 8); adding a language later, extra keys and
    the licence key in the README (Task 13); plain `--prune`, the ambiguous stop and a dry-run stop's exit (Task 4); a
    generic `--dry-run` export (Task 5).
  - Tests an implementer would have to invent or that pass vacuously: the compile fixture is pinned (a missing field is
    queued without the flag, `jobs.ts:154`); the read's step order and reasons are a table; `ASTRO_ROOT_DE_ZH` and
    `page()` are verbatim; the German setup page's title is pinned and asserted in its `<h1>` (the sidebar label
    comes from `astro.config`); README order tests use command lines; every exit-2 test asserts its message; the TS
    warning test runs in a child process (Node warns once per process); `status` must show `current` rows (agy).
  - Ruling: Task 8 is not split (a seat's Q2 suggestion). Its pure functions and the `init` wiring share one test
    file and one reviewer gate, and renumbering every later task costs more than the split saves.

## Stand-downs

- DISCARDED-BELOW-FLOOR: a `trackFields` failure on document k of n in `track --collection` leaves k-1 documents tracked
  and no report; unreachable as a lasting inconsistency because `trackFields` writes the current source hashes in place
  and is idempotent (`packages/core/src/sync/state.ts:103-107`), so a re-run completes it.
