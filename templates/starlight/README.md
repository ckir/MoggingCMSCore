# Mogging Docs starter

A small [Starlight](https://starlight.astro.build) site with three English pages, set up for MoggingCMS to translate
into German (`de`) and Simplified Chinese (`zh-CN`). It shows the whole first session: import the English pages,
draft the other languages with AI, review and approve the drafts, publish them in a release, export them as Markdown
files and build the site.

## Licence

MoggingCMS is source-available, not open source. It is licensed under the PolyForm Noncommercial License 1.0.0 plus
additional terms: any noncommercial purpose is permitted; a company may use it for internal testing and evaluation for
30 days from first use, royalty-free; production or other commercial use after that needs a paid licence key; and you
may not circumvent the licence-key functionality. Individuals and noncommercial organisations install a zero-price
`noncommercial` key, issued on a self-declaration that the use is noncommercial, and never meet the end of the
evaluation. The full terms are in `LICENSE.md` of the `@mogging/starlight` package
(`node_modules/@mogging/starlight/LICENSE.md` once installed; [`../../LICENSE.md`](../../LICENSE.md) in this
repository).

Set the key as `MOGGING_LICENSE_KEY` in `.env`. Without a key, the 30-day evaluation applies and needs nothing.

## The first session

You need Node 22.23.4 or later, Docker (for a local Postgres) and, for the AI step, an
[OpenRouter](https://openrouter.ai) API key.

1. Copy the environment file. The `mogging` npm script loads `.env`; nothing else does.

   ```sh
   cp .env.example .env
   ```

2. Start Postgres. The credentials in `compose.yaml` match `DATABASE_URL` in `.env.example`. To use a hosted database
   instead, put its URL in `DATABASE_URL` and skip this step.

   ```sh
   docker compose up -d
   ```

3. Install the dependencies (Node 22.23.4 or later).

   ```sh
   npm install
   ```

4. Replace the sample pages in `src/content/docs` with yours. Each of the three sample pages says so. Keep the
   languages in `astro.config.mjs` and `mogging.config.ts` in step (see the limits below).

5. Create the database tables.

   ```sh
   npm run mogging -- migrate
   ```

6. Import your English pages. The pages become documents, and the English is published.

   ```sh
   npm run mogging -- import
   ```

7. Turn on AI translation. In `mogging.config.ts`, uncomment the block at the end, set the model ids and prices from
   your provider, and set a monthly cap (`budgets.monthlyCapUsd`). Put `OPENROUTER_API_KEY` in `.env`. Secrets are
   never read from `mogging.config.ts`.

8. Compile the drafts for both languages. `--budget` is a ceiling in US dollars for this run.

   ```sh
   npm run mogging -- compile --locales de,zh-CN --budget 1
   ```

9. Review the drafts. No AI text reaches the site without a recorded human approval. The interactive review shows each
   draft and asks you to approve or reject it. `review --approve-clean` approves the drafts that passed every check
   without opening them, so read the list it prints.

   ```sh
   npm run mogging -- review
   npm run mogging -- review --approve-clean
   ```

10. Publish the approved drafts in one release. Replace `<name>` with a name of your choosing, such as `first`.
    A release name can be used once: a second `release create <name>` with the same name fails with a
    `ConflictError`, so use a new name for every batch (`2026-12-02`, `docs-fixes`). A bare `publish` with no target
    is a usage error, so publish by release name.

    ```sh
    npm run mogging -- release create <name>
    npm run mogging -- release add <name> --all-approved
    npm run mogging -- release publish <name>
    ```

11. Export the published pages. This writes the translated Markdown files under `src/content/docs/de/` and
    `src/content/docs/zh-cn/`.

    ```sh
    npm run mogging -- export
    ```

12. Build the site, then commit the exported files together with your English changes.

    ```sh
    npm run build
    ```

    A static host builds the committed files like any Starlight site. Install `@mogging/starlight` (it is a
    dependency of this template) wherever your site's CI installs dependencies, because `astro.config.mjs` imports it.

Later English edits show up as stale translations in `npm run mogging -- status`. Run `import`, `compile`, `review`, a
new release and `export` again to bring the other languages up to date.

## After the 30-day evaluation

Without a licence key, the guarded writes stop 30 days after the first `migrate`: saving drafts (so `import` too),
`compile`, approving and publishing refuse with a message that says a key is needed. Reading keeps working: `export`
and the built site are unaffected, so translations you already exported keep being served. Set `MOGGING_LICENSE_KEY`
in `.env` to carry on.

## Supported team setup

The translation state lives only in Postgres. Mogging supports one shared database per site and one operator, the tech
lead or docs maintainer, running Mogging on a checkout of the default branch, after merges. Do not run `import` from a
feature branch against the shared database: it would publish English that is not merged yet. A database on a laptop
is for evaluation and solo use. The rest of the team works only through git.

## Known limits

- Root-relative links in a translated page (`/guides/getting-started/`) point where the English points, because
  Starlight does not localize links itself. Relative page links stay inside the language. Hero action and previous/next
  links are per language, but an AI draft takes them from the English until a reviewer edits them.
- A built page does not show whether its text was AI-drafted, human-written or untracked, and a stale translation is
  served without a notice until a new one is exported. `npm run mogging -- status` shows both.
- Pruning (`import --prune`) is final for a page's translations: there is no undelete.
- `head` tag text is not translated.
- Reverting a translated file in git to an older translation is undone by the next `export`, unless you import it
  with `import --restore`.
- Adding a language means changing both `astro.config.mjs` (`locales`) and `mogging.config.ts` (`localeDirs` and the
  fallback chains). `import` skips, with a warning, a language folder that `mogging.config.ts` does not declare.
