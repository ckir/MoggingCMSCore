# @mogging/starlight

MoggingCMS for [Starlight](https://starlight.astro.build) sites. Your English pages stay Markdown files in git.
MoggingCMS keeps their translations in Postgres, drafts them with AI under a monthly cap, shows you every draft for
approval, and writes the approved translations back as Markdown files next to the English ones. The site you build is
an ordinary Starlight site.

This package holds the two pieces a site needs: the preset that `mogging.config.ts` uses to describe a Starlight docs
folder (`@mogging/starlight/preset`) and an Astro integration that does nothing (the default export). The work itself
is done by the `mogging` command line (`@mogging/cli`). The step by step session below starts from an existing
Starlight site; [`templates/starlight`](../../templates/starlight/README.md) in this repository is the same session on a
ready-made starter.

> **Status:** v0.1 pre-release. The packages are version `0.0.0`, private, and not published to npm yet; the install
> commands below work once they are. Registry names, the key page and the release notes arrive with the v0.1 release.

## Licence

MoggingCMS is source-available, not open source. It is licensed under the PolyForm Noncommercial License 1.0.0 plus
additional terms:

- any noncommercial purpose is permitted;
- a company may use it for internal testing and evaluation for 30 days from first use, royalty-free;
- production or other commercial use after that needs a paid licence key;
- you may not move, change, disable or circumvent the licence-key functionality.

Individuals and noncommercial organisations install a zero-price `noncommercial` key, issued on a self-declaration that
the use is noncommercial, and never meet the end of the evaluation. The full terms are in `LICENSE.md`
(`node_modules/@mogging/starlight/LICENSE.md` once installed; [`../../LICENSE.md`](../../LICENSE.md) in this
repository).

The key goes in the `MOGGING_LICENSE_KEY` environment variable of the process that runs `mogging`, or in the `license`
field of `defineConfig` (the variable wins). Keys are checked offline; nothing contacts a licence server. The `mogging`
command does not read `.env` files, so export the variable in your shell, or load your `.env` the way the template's
`mogging` npm script does. A commercial key is bought at <https://mogging.dev/buy>. A refused guarded command prints the same address in its
message, or the `purchaseUrl` that your project sets in `defineConfig`. The registration page for the zero-price
`noncommercial` key is not published yet; its link will be added here with the v0.1 release. The 30-day evaluation needs
no key and starts at your first `migrate`.

## Install

Install the command line, the engine, the AI pipeline and this package as development dependencies. The config that
`mogging init --starlight` writes imports `@mogging/core` and this package's preset, and its AI block imports
`@mogging/ai`.

```sh
npm install -D @mogging/cli @mogging/core @mogging/ai @mogging/starlight
```

If you use the integration, `astro.config` imports `@mogging/starlight`, so the package must be in the site's
`dependencies` (not only `devDependencies`) and installed wherever your site's CI or host installs dependencies.
`npx astro add @mogging/starlight` does this for you and adds the line to `astro.config`:

```sh
npx astro add @mogging/starlight
```

The integration is optional and does nothing: it registers no hooks, reads no database, network or licence key, and
prints nothing during a build. Its root entry imports nothing from `@mogging/core`, so loading it inside `astro.config`
never pulls the engine or the database driver into your site build. The preset lives in a separate entry,
`@mogging/starlight/preset`, which only `mogging.config.ts` imports.

### Supported versions

`@mogging/starlight` is tested with `@astrojs/starlight >=0.43.0 <0.44.0` and Astro `^7.2.10`. Both are optional peer
dependencies of this package. Starlight is pre-1.0, so each new minor version is a deliberate range bump after the test
fixtures pass. `mogging init --starlight` warns when the Starlight installed next to your site is outside that range.

## The first session

You need Node 22 or newer (Astro 7.4 needs 22.23.4), a Postgres database 16 or newer, and, for the AI step, an
[OpenRouter](https://openrouter.ai) API key. Run every command from the site's root folder, the one with
`astro.config`. The `mogging` command takes the database URL from `--database-url`, then `MOGGING_DATABASE_URL`, then
`DATABASE_URL`.

1. Start a Postgres database. The template's `compose.yaml` runs one locally (its credentials match the template's
   `.env.example`); a hosted database works as well. Either way you end up with a `DATABASE_URL` such as
   `postgres://mogging:mogging@localhost:5432/mogging`, which you set in your shell.

   ```sh
   docker compose up -d
   ```

2. Write `mogging.config.ts`. `init --starlight` reads the `locales` of your `astro.config` statically (it never runs
   it) and writes a config with the preset, the fallback chains and the folder of every language, then applies the
   migrations. It never overwrites an existing config, and it never prompts.

   ```sh
   npx mogging init --starlight
   ```

   A single-language site has no `locales` to read. Name the target languages instead, and `--source-locale` if the
   site is not English. `init` then prints the `locales` block to paste into the `starlight()` options of
   `astro.config`, so the two lists agree. If `astro.config` builds its `locales` from a constant, a spread or a
   function call, it cannot be read statically either, and `--locales` is needed in the same way.

   ```sh
   npx mogging init --starlight --locales de,fr
   ```

3. Apply the migrations. `init` has already done this once; `migrate` is the command to run again after you upgrade the
   packages, and it is harmless when nothing is pending. The 30-day evaluation starts at the first migration.

   ```sh
   npx mogging migrate
   ```

4. Turn on AI translation. The config that `init` wrote ends with a commented `ai` block. Uncomment it, set the model
   id and its prices from your provider's current list (the ones below are placeholders), and set a monthly cap in US
   dollars. Put the provider key in the environment as `OPENROUTER_API_KEY`: secrets are never read from the config
   file.

   ```ts
   import { defineAiConfig } from "@mogging/ai";

   export const ai = defineAiConfig({
     provider: { kind: "openrouter" },
     models: { translate: "<vendor>/<model-id>" },
     prices: { "<vendor>/<model-id>": { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 128000 } },
     budgets: { monthlyCapUsd: 10 },
   });
   ```

5. Import your pages. Every page under the docs folder becomes a document, and the English text is published at once:
   the file in git is already the live page. Pages that are not translated yet come in as the source only. A new page
   whose front matter says `draft: true` is skipped until you remove the flag. Pages you already translated by hand are
   covered in [Day one](#day-one-pages-you-already-translated).

   ```sh
   npx mogging import
   ```

6. Compile the drafts. `--locales` names the target languages and `--budget` is the ceiling in US dollars for this run;
   the monthly cap of step 4 applies on top of it. Each translation is stored as an AI draft, and nothing is published
   by it.

   ```sh
   npx mogging compile --locales de,fr --budget 2
   ```

7. Review the drafts. No AI text reaches the site without a recorded human approval. `review` shows each draft beside
   its source and asks you to approve, reject or edit it. `review --approve-clean` approves every draft with no
   warnings without opening it, so read the list it prints.

   ```sh
   npx mogging review
   npx mogging review --approve-clean
   ```

8. Publish the approved drafts in one release. A release name can be used once: a second `release create` with the
   same name fails, so use a new name for every batch (`2026-12-02`, `docs-fixes`). A bare `mogging publish` with no
   target is a usage error, so publish by release name.

   ```sh
   npx mogging release create first
   npx mogging release add first --all-approved
   npx mogging release publish first
   ```

9. Export the published translations. This writes the Markdown files into your docs folder (`src/content/docs/de/` and
   so on) and a manifest of what it wrote. `--dry-run` prints what it would write and changes nothing. The command
   exits `4` when something needs your attention, for example a locale file you edited by hand that the export did not
   overwrite or an incomplete translation; the report names each file.

   ```sh
   npx mogging export
   ```

10. Build the site, then commit the exported files together with your English changes. The site builds from the
    committed files like any Starlight site.

    ```sh
    npm run build
    git add src/content/docs mogging.config.ts
    ```

Later edits to an English page show up as stale translations in `mogging status`. Run `import`, `compile`, `review`, a
new release and `export` again to bring the other languages up to date.

## After the evaluation

Without a licence key, the guarded writers stop 30 days after the first `migrate`: saving drafts (so `import` too),
`compile`, approving and publishing refuse with exit code `3` and a message that says a key is needed. Reading keeps
working: `export`, `status` and the built site are unaffected, so the translations you already exported keep being
served. Set `MOGGING_LICENSE_KEY`, as described under [Licence](#licence), to carry on.

## Day one: pages you already translated

A site with translated pages already in git is imported the same way. The first `import` reads the locale files and
stores each as a published human translation, without a record of which English text it was written from. Every field
of those pages therefore shows as `untracked` in `mogging status`: nothing says it is current, and nothing says it is
stale. The run lists the locale files as `updated`.

- `compile` never re-translates an untracked field on its own, so your hand-written text is not replaced.
- Once you have checked that a language's pages match the English, mark them current. This asserts that every untracked
  field of that language is in sync with the source, so look first; `--dry-run` lists what it would mark.

  ```sh
  npx mogging track --collection docs --locale de --dry-run
  npx mogging track --collection docs --locale de
  ```

- Or ask for AI drafts for the untracked fields, which then go through `review` like any other draft:

  ```sh
  npx mogging compile --locales de --budget 2 --include-untracked
  ```

A locale file that is incomplete (it lacks a localized field the English page has, such as the body) is saved as an
unpublished draft with a warning, and export lists it as needing attention.

## Renaming a page

A rename keeps the document and every language's history. Do it with `mogging rename`, which moves the English file and
every locale file under the same path and updates the manifest:

```sh
npx mogging rename guides/getting-started guides/first-steps --dry-run
npx mogging rename guides/getting-started guides/first-steps
```

Slugs are the path of the file under the docs folder, without its extension and in lower case. `rename` then lists
every line of `astro.config` and of your docs that still names the old slug, because Starlight fails the build when a
sidebar entry points at a page that no longer exists. It does not edit them, and it reminds you that the old URL needs
a redirect. Re-running an interrupted rename finishes it.

If you rename the English file with `git mv` first, `import` notices it and stops. With one page gone and one new file
it prints the exact `mogging rename` command to run. This is the safety stop: when one `import` finds both pages whose
English file is gone and English files with no page, it creates and deletes nothing, with or without `--prune`, and
exits non-zero, because it cannot tell a rename from a deletion plus an addition and a wrong guess would move
translations onto the wrong page. When you really did delete one page and add another, run `import
--accept-new-and-gone`: it creates the new pages, and soft-deletes the gone ones only when you also pass `--prune`.

## Deleting a page

`import --prune` soft-deletes every page whose English file is gone, and the translation files of a deleted page are
removed by the next `export`, but only files the manifest lists and whose bytes you have not changed. **A prune is
final**: MoggingCMS has no undelete, so a pruned page's translations are lost to the database (git still has the
files). `--prune` refuses when the run found no English file at all, which is what a wrong folder or an empty checkout
looks like. `import --dry-run` shows what a prune would delete.

```sh
npx mogging import --prune --dry-run
```

## Adding a language later

Add the language in three places, then run the usual loop for it:

1. in `mogging.config.ts`: the fallback chain, `chains: { fr: ["en"], ... }` in `defineConfig`, and the folder in the
   preset's `localeDirs`, `localeDirs: { fr: "fr", ... }`. Add the folder explicitly whenever it is not the lower-case
   tag; Starlight names a Simplified Chinese folder `zh-cn`, for the locale `zh-CN`.
2. in `astro.config`: an entry for it in the `locales` of the `starlight()` options.
3. then translate it:

   ```sh
   npx mogging compile --locales it --budget 2
   ```

   and `review`, release and `export` as in the first session.

Until both configs agree, `import` skips, with a warning, a language folder that `mogging.config.ts` does not declare,
and `export` writes nothing for a language that `astro.config` does not list and exits `4`. `init --starlight` is not
the tool for this: it never overwrites an existing config.

## Your own front-matter keys

The preset knows every key of Starlight's docs schema (`title`, `description`, `sidebar`, `hero`, `banner`, `head` and
the rest). A key of your own that you added with `docsSchema({ extend })` needs no change as long as it is the same in
every language: it is kept as it is in the English page and copied to the locale files by `export`. A key whose value
differs by language and should be translated goes in `starlightPreset({ extraFields })`:

```ts
import { defineConfig, text } from "@mogging/core";
import { starlightPreset } from "@mogging/starlight/preset";

const docs = starlightPreset({
  extraFields: { summary: text({ localized: true }) },
});

export const config = defineConfig({
  collections: [docs.collection],
  locales: { source: "en", chains: { de: ["en"] } },
});

export const starlight = docs.layout;
```

An extra field may not reuse the name of a field the preset defines. The other options of `starlightPreset` are
`collection` (the collection name, default `docs`), `docsDir` (default `src/content/docs`), `sourceDir` (the folder of
the source language, or `null` when English sits at the root, which is the default), `localeDirs` and
`otherLocaleDirs` (top-level folders that are Starlight languages MoggingCMS does not manage).

## Supported team setup

The translation state lives only in Postgres. MoggingCMS supports one shared database per site and one operator, the
tech lead or docs maintainer, running `mogging` on a checkout of the default branch, after merges. Do not run `import`
from a feature branch against the shared database: it would publish English that is not merged yet. A database on a
laptop is for evaluation and solo use. The rest of the team works only through git.

## Known limits

- Root-relative links in a translated page's body (`/guides/getting-started/`) point where the English page points,
  because Starlight does not localize links itself. Relative page links stay inside the language. Hero action and
  previous/next links are per language, but an AI draft takes them from the English until a reviewer edits them.
- A built page does not show whether its text was AI-drafted, human-written or untracked, and a stale translation is
  served without a notice until a new one is exported. `mogging status` shows both.
- Pruning (`import --prune`) is final for a page's translations: there is no undelete.
- `head` tag text is not translated.
- Reverting a translated file in git to an older translation is undone by the next `export`, unless you bring the old
  file back with `import --restore <file>` (the path of the locale file, relative to your working directory or
  absolute, inside the project).
- A page whose front matter sets Starlight's `slug` override is reported as an error, because copying it into the
  locale files would collide with the English route.
- One operator and one shared database per site (see above); a database on a laptop is for evaluation and solo use.

Every command above is described in [`@mogging/cli`](../cli/README.md); `--json` gives machine-readable output.
