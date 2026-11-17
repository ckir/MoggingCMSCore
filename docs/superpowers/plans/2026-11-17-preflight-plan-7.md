# Plan 7: the engine changes before migration 0001 is frozen

**Goal.** Settle three engine contracts before ship step 3 freezes `packages/core/migrations/0001_engine.sql`
(`docs/superpowers/specs/2026-11-13-v01-ship-sequencing-design.md`, step 3) and before the SDK is published:

1. a collection's slug field is always the top-level field named `slug`, and `document_shared` gets an index for slug
   lookups;
2. a `richText` value is always a rich-text tree, never a string;
3. a field declared `required` is enforced when a head is published.

**Spec.** There is no spec document. The authority is the owner's rulings below (made 2026-11-17 after two AGY-FIRST
consults, seams `.clavity/seams/plan7-preflight-first.md` and `.clavity/seams/plan7-required-first.md`) and the code on
`main` at `c5c9ad8`. Every `file:line` below was read at `c5c9ad8`.

## Design decisions (owner rulings)

- **F1 (slug).** `defineConfig` refuses a `slug()` field that is not the top-level field named `slug`, and refuses a
  field named `slug` that is not a `slug()` field. With unique object keys that also means at most one slug field per
  collection. The readers already read `data->>'slug'` (`packages/core/src/read/resolve.ts:190`, `:296`;
  `packages/core/src/read/review.ts:85`, `:93`, `:133`), and so do the markdown and CLI packages (for example
  `packages/markdown/src/import.ts:361`, `packages/cli/src/target.ts:31`); this ruling makes them correct by
  construction. Migration 0001 gains a partial expression index on `document_shared ((data->>'slug'))` for head rows,
  and `assertSlugFree` compares the literal key `'slug'` so the planner can use it (today it binds the field name as a
  parameter, `packages/core/src/documents/slugGuard.ts:51`, which no expression index can match).
- **F2 (rich text).** `normalizeValue` refuses a `richText` value unless it is a plain object with exactly the keys
  `type`, `version`, `mode`, `children`, where `type === "root"`, `version === 1`, `mode` is `"md"` or `"mdx"` and
  `children` is an array. A string is refused with a message that names `markdownToTree` from `@mogging/markdown`.
  Core does not validate below the root (it cannot import the markdown package, AGENTS.md "Package layering"); the
  deep check stays `validateTree` in `@mogging/markdown`. The check runs wherever a richText field is normalized,
  including inside `list` and `object` values (`normalizeAt` recurses, `packages/core/src/values/normalize.ts:74-90`).
- **F3 (`required`).** Enforced at **publish**, not at save: drafts may be incomplete. `publishWithinTx`
  (`packages/core/src/documents/publishCore.ts:47`), which both `publish` and `publishRelease` use, refuses with
  `ValidationError` when the row it would publish (a draft head or a republished historical row) lacks a top-level
  `required` field of its scope: the non-localized fields for `"shared"`, the localized fields for a locale. "Lacks"
  means the key is absent from the stored data (top-level nulls are stripped at write, so absent and null are the
  same); an empty value (`""`, `[]`, `{}`, an empty tree) is present, as the storage contract says. A document whose
  collection is no longer in the config is not checked (as `assertSlugFree` does, `slugGuard.ts:41-42`).
  `defineConfig` refuses `required: true` below the top level (inside a `list` item or an `object`'s fields), so a
  declared flag is never silently ignored.
- **Unchanged on purpose.**
  - The markdown package's tolerance of a string richText on export (`packages/markdown/src/export.ts:83`,
    `packages/markdown/src/contentFile.ts:150`, `:188`) stays: it is now unreachable for data written through core,
    and removing it changes nothing an adopter can observe.
  - The Starlight layout's own D10 check (`packages/markdown/src/starlight/layout.ts:127`) stays as a second line
    for a config object built without `defineConfig`.
  - The Starlight import still saves an incomplete translation as an unpublished draft
    (`packages/markdown/src/starlight/importStarlight.ts:584-594`); publish-time enforcement agrees with its existing
    refusal to publish one.

## Measured before writing

A throwaway worktree at `c5c9ad8` applied the F2 check and the F3 publish check and ran `pnpm test` (1772 tests):
261 failed. 259 failed only because a test passes a string richText value; 2 failed on the publish check. By file:

| file | failing tests | cause |
| --- | --- | --- |
| `packages/core/test/approve.test.ts` | 49 | string richText |
| `packages/core/test/releases.test.ts` | 32 | string richText |
| `packages/core/test/rejectDraft.test.ts` | 15 | string richText |
| `packages/core/test/sync.test.ts` | 11 | string richText |
| `packages/core/test/saveDraft.test.ts` | 10 | string richText |
| `packages/core/test/resolve.test.ts` | 8 | string richText |
| `packages/core/test/lifecycle.test.ts` | 6 | string richText |
| `packages/core/test/review.test.ts` | 6 | string richText |
| `packages/core/test/licence.test.ts` | 4 | string richText |
| `packages/core/test/values.test.ts` | 4 | tests of string richText normalization itself |
| `packages/core/test/readme.test.ts` | 1 | the README example saves `body: "Welcome"` |
| `packages/cli/test/reviewInteractive.test.ts` | 28 | string richText |
| `packages/cli/test/release.test.ts` | 25 | string richText |
| `packages/cli/test/review.test.ts` | 23 | string richText |
| `packages/cli/test/publish.test.ts` | 16 | string richText |
| `packages/cli/test/query.test.ts` | 8 | string richText |
| `packages/cli/test/unpublish.test.ts` | 7 | string richText |
| `packages/cli/test/track.test.ts` | 4 | string richText |
| `packages/cli/test/compile.test.ts` | 1 | string richText |
| `packages/markdown/test/starlight/export.test.ts` | 1 + 2 | 1 string richText; 2 publish a head without `title` |

`packages/ai` had none. The F1 config rules were not in the prototype; one test is known to build a config they refuse
(`packages/markdown/test/starlight/layout.test.ts:153`).

## Global constraints (every task)

- Run tests with `DATABASE_URL=postgres://mogging:mogging@127.0.0.1:54329/mogging_test` exported. Never put `--` after
  `pnpm --filter <pkg> test`. Commands: `pnpm --filter @mogging/core test`, `pnpm --filter @mogging/markdown test`,
  `pnpm --filter @mogging/cli test`, `pnpm test` (all), `pnpm typecheck`. A passing run prints `Test Files  N passed`
  with no `failed`; `pnpm typecheck` prints no `error TS`.
- No new public export: `packages/*/test/api.test.ts` stay unchanged.
- JSDoc on every exported function you change: keep its `@throws` list complete.
- No caller string in SQL text; bind everything (AGENTS.md "Data-safety invariants"). The literal `'slug'` key is
  engine text, not a caller string.
- Commit subjects: `feat(core): ...`, `test(cli): ...`, `docs: ...`; end each message with the attribution line the
  driver gives you.
- Test fixture rule (Tasks 3 and 4): where a test passes a string as a richText value, replace the string with the
  package's `md(...)` helper (a test that passes some other non-root object gets the specific instruction its task
  gives), and change an expectation ONLY where it echoes that same value (for example
  `body: "Hello"` in an expected `data` object becomes `body: md("Hello")`). Change nothing else in a test. If an
  expectation that does not echo a richText value fails, STOP and report it.

## Task 1: `defineConfig` rules for `slug` and `required`

Files: `packages/core/src/schema/config.ts`, `packages/core/test/schema.test.ts`,
`packages/markdown/test/starlight/layout.test.ts`.

1. In `config.ts`, after `badTranslateFalse` (ends at `:37`), add:

```ts
/** True when a `slug` field sits anywhere below `f` (inside its list item or object fields). */
function containsSlug(f: Field): boolean {
  if (f.kind === "list") return f.item.kind === "slug" || containsSlug(f.item);
  if (f.kind === "object") return Object.values(f.fields).some((s) => s.kind === "slug" || containsSlug(s));
  return false;
}

/** The path (relative to `f`) of the first field below `f` that sets `required: true`, or null. */
function nestedRequired(f: Field): string | null {
  const below = (path: string, sub: Field): string | null => {
    if (sub.required) return path;
    const inner = nestedRequired(sub);
    return inner === null ? null : `${path}${inner}`;
  };
  if (f.kind === "list") return below("[]", f.item);
  if (f.kind === "object") {
    for (const [k, sub] of Object.entries(f.fields)) {
      const p = below(`.${k}`, sub);
      if (p !== null) return p;
    }
  }
  return null;
}
```

2. In the per-field loop, directly after the existing `slug cannot be localized` check (`config.ts:63-65`), add:

```ts
      if (f.kind === "slug" && fname !== "slug") {
        throw new ValidationError(`${col.name}.${fname}: a slug field must be named "slug"`);
      }
      if (fname === "slug" && f.kind !== "slug") {
        throw new ValidationError(`${col.name}.slug: the name "slug" is reserved for a slug() field`);
      }
      if (containsSlug(f)) {
        throw new ValidationError(`${col.name}.${fname}: slug() is only valid as a top-level field`);
      }
      const req = nestedRequired(f);
      if (req !== null) {
        throw new ValidationError(`${col.name}.${fname}${req}: required is only valid on a top-level field`);
      }
```

   Update `defineConfig`'s JSDoc `@throws {ValidationError}` to list the four new refusals.

3. Tests to add to `packages/core/test/schema.test.ts` (each builds a one-collection config with a valid body field
   and asserts `toThrow` with the exact message):
   - `defineConfig refuses a slug field not named slug`: `{ path: slug(), body }` →
     `posts.path: a slug field must be named "slug"`.
   - `defineConfig refuses a non-slug field named slug`: `{ slug: text(), body }` →
     `posts.slug: the name "slug" is reserved for a slug() field`.
   - `defineConfig refuses a slug nested in an object or a list`: `{ slug: slug(), meta: object({ s: slug() }), body }`
     → `posts.meta: slug() is only valid as a top-level field`; and `{ slug: slug(), tags: list(slug()), body }` →
     `posts.tags: slug() is only valid as a top-level field`.
   - `defineConfig refuses required below the top level`: `{ meta: object({ a: text({ required: true }) }), body }` →
     `posts.meta.a: required is only valid on a top-level field`; `{ items: list(object({ n: number({ required: true }) })), body }`
     → `posts.items[].n: required is only valid on a top-level field`.
   - `defineConfig accepts required on a top-level field`: `{ title: text({ localized: true, required: true }), body }`
     does not throw.
4. `packages/markdown/test/starlight/layout.test.ts:153` (`a slug-kind field not named slug (D10)`) builds its config
   with `defineConfig`, which now refuses it. Keep the test's purpose (the layout's own check): build `cfg` as a plain
   object literal of type `MoggingConfig` (import the type from `@mogging/core`) with the same collection and locales,
   bypassing `defineConfig`; the `refuses(...)` assertion stays unchanged.
5. Run `pnpm --filter @mogging/core test`, `pnpm --filter @mogging/markdown test`, `pnpm --filter @mogging/ai test`,
   `pnpm --filter @mogging/cli test`, `pnpm typecheck`. Any other test that now fails on these refusals: STOP and
   report it.

## Task 2: the slug index and the guard's literal key

Files: `packages/core/migrations/0001_engine.sql`, `packages/core/src/documents/slugGuard.ts`,
`packages/core/test/slugGuard.test.ts`.

1. In `0001_engine.sql`, directly after `uq_doc_shared_head_draft` (`:34`), add:

```sql
-- Slug lookups (getDocument by slug, assertSlugFree) read the shared heads' `slug` key. `defineConfig` fixes the slug
-- field's name to `slug`, so one expression index serves every collection. Not unique: uniqueness per collection is
-- assertSlugFree's job, under the collection's advisory lock.
create index idx_doc_shared_slug on document_shared ((data ->> 'slug')) where is_head_published or is_head_draft;
```

2. In `slugGuard.ts` `assertSlugFree` (`:35-58`): replace the field search and the bound key with the literal name.
   The function becomes:

```ts
  const collection = ctx.config.collections.find((c) => c.name === input.collection);
  if (!collection || !Object.hasOwn(collection.fields, "slug")) return;
  const value = Object.hasOwn(input.data, "slug") ? input.data["slug"] : undefined;
  if (typeof value !== "string") return;
  const [clash] = await tx`
    select 1 as x
    from document_shared s join documents d on d.id = s.doc_id
    where d.collection = ${input.collection} and d.deleted_at is null and d.id <> ${input.docId}
      and (s.is_head_published or s.is_head_draft)
      and s.data ->> 'slug' = ${value}
    limit 1`;
```

   (the `if (clash) throw ...` block is unchanged). Update the JSDoc sentence "A collection with no `slug` field" if
   needed so it still reads true.
3. Tests to add to `slugGuard.test.ts`. Oracle: the number of index entries the slug index returns in this
   transaction, `pg_stat_get_xact_tuples_returned('idx_doc_shared_slug'::regclass)` (an `int8`, which postgres.js
   returns as a string: wrap it in `Number(...)`). Why this and not a scan count: with `enable_seqscan = off` the
   planner scans this partial index just to satisfy its `where` predicate even when it cannot use the slug condition,
   so a scan count grows either way (measured by the driver). Entries returned tell the two apart: measured on a
   50-head table under `enable_seqscan = off` and `plan_cache_mode = force_generic_plan`, a lookup of a missing slug
   on the literal key returned 0 entries and the same lookup with the key bound as a parameter returned 50.
   `force_generic_plan` matters: a custom plan substitutes a bound key as a constant and matches the index anyway, so
   without it the bound-key form would pass too.
   - `the slug guard's lookup uses the slug index condition`: after `setup`, save and publish the shared heads of 20
     `posts` documents with slugs `s1` ... `s20`; then in `sql.begin(async (tx) => { ... })`: `set local
     enable_seqscan = off`, `set local plan_cache_mode = force_generic_plan`; read the counter as `before`; call
     `saveDraft({ ...ctx, sql: tx }, ...)` for a new `posts` document (created with `createDocument` on the same tx
     ctx) with slug `fresh`; read the counter again and expect `after - before` to be less than 5.
   - `getDocument by slug uses the slug index condition`: the same seed and frame, calling `getDocument({ ...ctx, sql:
     tx }, { collection: "posts", slug: "s7" })`; expect the document returned (its `id` is the one saved with `s7`)
     and `after - before` less than 5.
   - Prove the first test is non-vacuous before committing: temporarily change the guard's `s.data ->> 'slug'` to
     `s.data ->> ${"slug"}::text`, run the test, see it fail with a difference of at least 20; revert. Put the failing
     output in your report.
4. Run `pnpm --filter @mogging/core test` and `pnpm typecheck`.

## Task 3: core refuses a string richText (the check and core's own tests)

Files: `packages/core/src/values/normalize.ts`, `packages/core/test/fixtures.ts`, `packages/core/README.md`, and the
core test files in the measured table.

1. In `normalize.ts` replace the `richText` case (`:46-51`) with:

```ts
    case "richText":
      if (
        !isPlainObject(value) || Object.keys(value).length !== 4 || value["type"] !== "root" || value["version"] !== 1
        || (value["mode"] !== "md" && value["mode"] !== "mdx") || !Array.isArray(value["children"])
      ) {
        throw new ValidationError(
          `${path}: expected richText as a rich-text tree { type: "root", version: 1, mode: "md" | "mdx", children: [...] }`
          + (typeof value === "string" ? "; convert Markdown with markdownToTree from @mogging/markdown" : ""),
        );
      }
      return nfcDeep(value, path);
```

   Update `normalizeValue`'s JSDoc if it describes richText input forms.
2. In `packages/core/test/fixtures.ts` add and export:

```ts
/** A one-paragraph rich-text tree holding `text` (an empty string gives a tree with no children). */
export const md = (text: string) => ({
  type: "root" as const, version: 1 as const, mode: "md" as const,
  children: text === "" ? [] : [{ type: "paragraph", children: [{ type: "text", value: text, marks: [] }] }],
});
```

3. Apply the Global constraints' test fixture rule to `approve`, `releases`, `rejectDraft`, `sync`, `saveDraft`,
   `resolve`, `lifecycle`, `review`, `licence`.test.ts. A test that computes a hash of a richText value (for example
   `hashValue("B2")` at `saveDraft.test.ts:330`) hashes `md("B2")` instead. Two `saveDraft.test.ts` tests store
   arbitrary JSON objects as `body` on purpose; keep their intent by wrapping that JSON in a valid root, and follow
   the wrapping in the lines that read it back:
   - `target re-save compares canonical forms over awkward stored values` (`:302-330`): `body: raw()` (`:312`) becomes
     `body: { type: "root", version: 1, mode: "md", children: [raw()] }`, and `:316` reads
     `(stored!.data as { body: { children: object[] } }).body.children[0]!` instead of `.body`. The later saves that pass
     `raw()` (`:320`) or the edited copy `changed` (`:328`) as `body` wrap it the same way.
   - `jsonb round trip` (`:333-355`): the first save's `body` becomes `{ type: "root", version: 1, mode: "md",
     children: [<the existing object>] }`, the third save's `body: [null, 0, { k: null }]` becomes the root with
     `children: [null, 0, { k: null }]`, and `:354` reads
     `((first.body as { children: Array<{ text: string }> }).children[0]!).text`.
4. `values.test.ts`: the four tests of richText normalization (`richText NFC-normalizes strings recursively`,
   `richText rejects NaN and Infinity nested inside the document, naming the path`, `U+0000 is rejected in text, slug,
   reference and every richText string and key`, `a __proto__ key is refused in json and richText`) keep their
   assertions but pass their nested values inside a valid root (inside `children`), so the path in an expected message
   gains `.children[0]` where it names a nested location. Add:
   - `richText refuses a string and names markdownToTree`: `normalizeValue(richText(), "# Hi", "body")` throws a
     `ValidationError` whose message contains `markdownToTree`.
   - `richText refuses a value that is not a v1 root`: each of `[]`, `{}`, `{ type: "doc", version: 1, mode: "md",
     children: [] }`, `{ type: "root", version: 2, mode: "md", children: [] }`, `{ type: "root", version: 1, mode:
     "x", children: [] }`, `{ type: "root", version: 1, mode: "md" }`, `{ type: "root", version: 1, mode: "md",
     children: [], extra: 1 }` throws `expected richText as a rich-text tree`.
   - `a richText inside a list is checked`: `normalizeValue(list(richText()), ["x"], "notes")` throws, naming
     `notes[0]`.
5. README example (kept verbatim in `packages/core/test/readme.test.ts`, which checks the two match): in BOTH files
   replace `body: "Welcome"` in the `saveDraft` call with `body: welcome`, and add this line directly before
   `await migrate(sql);`:

```ts
  const welcome = { type: "root", version: 1, mode: "md", children: [{ type: "paragraph", children: [{ type: "text", value: "Welcome", marks: [] }] }] } as const;
```

   (unindented in `README.md`, two-space indented in the test). The comment line `// doc.data: { slug: "hello",
   title: "Hallo", body: "Welcome" }` becomes `// doc.data: { slug: "hello", title: "Hallo", body: welcome }`, and the
   test's `expect(doc!.data)` uses `body: welcome`. Below the README code block, add one sentence: "A rich-text value
   is a tree; to store Markdown, convert it with `markdownToTree` from `@mogging/markdown`."
6. Run `pnpm --filter @mogging/core test` (all green) and `pnpm typecheck`. `@mogging/cli` and `@mogging/markdown`
   tests are expected to fail until Task 4; do not touch them here.

## Task 4: CLI and markdown test fixtures pass trees

Files: `packages/cli/test/fixtures.ts`, the CLI test files in the measured table, and
`packages/markdown/test/starlight/export.test.ts` (only its one string-richText failure; the two `title` failures are
Task 5's).

1. Add the same `md` helper as Task 3 step 2 to `packages/cli/test/fixtures.ts` and export it. Change `publishedDoc`'s
   `body: "Hello"` (`packages/cli/test/fixtures.ts:74`) to `body: md("Hello")`, and its JSDoc.
2. Apply the test fixture rule to `reviewInteractive`, `release`, `review`, `publish`, `query`, `unpublish`, `track`,
   `compile`.test.ts. Where a CLI test asserts printed output that contains a richText value, the new printed form is
   whatever the CLI renders for a tree; update only those expected strings, and list every one you changed, with the
   before and after text, in your report.
3. In `export.test.ts`, the test `completeness: an empty body tree and an empty hero mapping count as missing, ...`
   passes an incomplete root `{ type: "root", children: [] }` (`:122`); make it `{ type: "root", version: 1, mode:
   "md", children: [] }`. Nothing else in that test changes.
4. Run `pnpm test` (all packages). The only failures allowed are none: Task 5 has not changed publish yet.

## Task 5: publish refuses a head that lacks a required field

Files: `packages/core/src/documents/publishCore.ts`, `packages/core/src/documents/publish.ts` (JSDoc),
`packages/core/src/releases/releases.ts` (JSDoc), `packages/core/test/publish.test.ts`,
`packages/core/test/releases.test.ts`, `packages/markdown/test/starlight/export.test.ts`.

1. In `publishWithinTx` (`publishCore.ts:47-114`):
   - add `data` to both target selects (`:59` and `:63`) and to the `target` type at `:57`
     (`data: Record<string, unknown>`);
   - directly after the `NotPublishableError` refusal (`:70-74`), read the document's collection once (this replaces
     the shared-only read at `:79`): `const [docRow] = await tx\`select collection from documents where id =
     ${input.docId}\`;` and `const collection = docRow ? ctx.config.collections.find((c) => c.name ===
     docRow.collection) : undefined;`, then add:

```ts
  // A head is published only with every top-level required field of its scope present (empty values count).
  if (collection) {
    const missing = Object.entries(collection.fields)
      .filter(([name, f]) => f.required && f.localized !== isShared && (target!.data[name] ?? null) === null)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new ValidationError(
        `Cannot publish version ${target.version} of ${label}: missing required field${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
      );
    }
  }
```

   - the shared slug block (`:78-86`) keeps its condition and calls, but uses the `docRow` read above instead of its
     own (`:79`) and `target.data` instead of the `snap` read (`:82`): `if (isShared && docRow) { await lockSlugs(tx,
     [docRow.collection as string]); await assertSlugFree(tx, ctx, { collection: docRow.collection as string, docId:
     input.docId, data: target.data }); }`. Behaviour must not change: the lock is still taken for a collection that
     is absent from the config, after the documents row lock.
   - JSDoc of `publishWithinTx`, `publish` (`publish.ts:12-32`) and `publishRelease` (`releases.ts:172-177`): add
     "a target that lacks a required field of its scope" to the `@throws {ValidationError}` line.
2. Tests in `packages/core/test/publish.test.ts` (a local config: collection `notes` with `slug: slug()`,
   `title: text({ localized: true, required: true })`, `code: text({ required: true })`, `subtitle: text({ localized:
   true })`, `body: richText({ localized: true, body: true })`; locales `en` and `de: ["en"]`):
   - `publish refuses a locale head without a required localized field, naming it`: save `en` `{ body: md("x") }`;
     `publish` en rejects with `Cannot publish version 1 of <docId>/en: missing required field title`, and no row
     changed state (`is_head_published` false everywhere for en).
   - `publish refuses a shared head without a required shared field`: shared `{ slug: "a" }` → rejects with
     `missing required field code`.
   - `an empty value counts as present`: en `{ title: "", body: md("") }` publishes.
   - `a republish of a row that lacks a newly required field is refused`: publish en `{ body: md("x") }` under a copy of
     the config whose `title` is not required, publish a second version, then republish version 1 with the required
     config: rejects with `missing required field title`.
   - `drafts may be incomplete`: `saveDraft` en `{ body: md("x") }` succeeds (no title).
3. Test in `packages/core/test/releases.test.ts`: `publishRelease refuses the whole release when one item lacks a
   required field`: two documents, one complete and one without `title`, both added to one release; `publishRelease`
   rejects with `missing required field title`, and neither item was published (the release stays unpublished).
4. `packages/markdown/test/starlight/export.test.ts`, tests `completeness: a head without title is skipped as
   incomplete, ...` (`:91`) and `an incomplete head whose file exists at the target path is listed in attention; ...`
   (`:133`): they need a published head without `title`, which publish now refuses. Seed those heads by publishing
   with a ctx whose config is a copy of the test's config with `title.required` set to `false`, then run the export
   with the original config (this is the real way such a head appears: the field became required after it was
   published). Their assertions do not change.
5. Run `pnpm test` and `pnpm typecheck`.

## Task 6: docs and tracked debt

Files: `docs/CONTENT_ARCHITECTURE.md`, `docs/API_INTEGRATION.md`, `packages/cli/src/render.ts` (JSDoc only),
`TODO.md`.

1. `CONTENT_ARCHITECTURE.md`:
   - `:65-66`, the slug rule, becomes: "A `slug()` field must be the top-level field named `slug`, and the name `slug`
     is reserved for it, so a collection has at most one slug. It cannot be localized and takes no options, so every
     slug is shared."
   - add after it: "`required: true` is only valid on a top-level field."
   - `:77` (richText row): "Rich-text tree" in the input column; the description becomes "A `RichTextRoot`
     (`{ type: "root", version: 1, mode, children }`); core checks the root and NFC-normalizes recursively, and
     `validateTree` in `@mogging/markdown` checks the rest. A string is refused: convert Markdown with
     `markdownToTree`. Exactly one `richText` field per collection must set `body: true`."
   - `:93` (`required` row): "Enforced at publish: `publish` and `publishRelease` refuse a head that lacks a required
     field of its scope (`ValidationError`). A key holding an empty value counts as present. Drafts may be
     incomplete. Top-level fields only."
   - `:106-108` (the "no unique index on slug" paragraph): replace with: "Slugs are unique per collection among live
     documents' shared heads: `saveDraft` and `publish` refuse a slug another live document holds (under a
     per-collection advisory lock). `document_shared` has a non-unique index on the heads' `slug` key for these
     lookups."
   - section 3.5 (`:394-396`): add a bullet "A target that lacks a required field of its scope is refused with
     `ValidationError`, for a draft head and for a republish alike."
   - section 9: delete `:713` (`required` ... never enforced) and change `:712` to "No referential integrity for
     `reference` fields."
2. `API_INTEGRATION.md:223-227`: replace the "Value handling" paragraph with: "Value handling: a stored rich-text
   value is always a `RichTextRoot`; core refuses anything else at write time (it checks the root, not the nodes).
   Validate it with `validateTree` before rendering if the data may have been written by an older version."
   In the same file, section 3.3's minimal renderer (the block at `:267-270`): delete the `if (typeof value === "string") { ... }`
   block (the comment `// Legacy/plain value: ...` and its `return <Markdown>{value}</Markdown>;`), so `RichText`
   goes straight to `validateTree(value)`.
3. `packages/cli/src/render.ts:12-13` (the `valueText` JSDoc): drop the parenthesis "(a string stored in a richText
   field is itself)". The code's string tolerance at `:20` stays, like the markdown export's (see Design decisions,
   "Unchanged on purpose").
4. `TODO.md`: delete the items fixed here, `:33` (slug index), `:35` (readers hard-code `slug`), `:36` (`required`
   enforced nowhere), `:67` (string richText body); in `:34` delete the first clause (a slug field not named `slug` is
   now refused by `defineConfig`) and keep the `unpublishing alone` clause.
5. Commit `docs: ...`.

## After the tasks

AGY-CAPSTONE on the branch's range, then AGY-TEST-AUDIT, then ask the owner about the merge. After the merge, ship
step 3 (freeze 0001) is the owner's.

## Review ledger

- Round 3 (agy, CLEAN, no citations): the driver's own grep found its Q2 answer ("no stale doc") wrong -> folded
  into Task 6: the string branch of `API_INTEGRATION.md`'s minimal renderer (`:267-270`) and the `valueText` JSDoc
  parenthesis (`packages/cli/src/render.ts:12-13`).
- Round 2 (agy, FINDINGS-2): a stored top-level `null` would pass `Object.hasOwn` -> folded: the check reads
  `(target.data[name] ?? null) === null` (no SDK writer stores one, `stripTopLevelNulls`, but a raw insert could).
  REJECTED: "postgres.js sends unnamed statements, so `force_generic_plan` has no effect and the bound key also
  returns 0": a driver probe through postgres.js with the test pool's options (`packages/core/test/db.ts:10`) on a
  50-head temp table returned 0 entries for the literal key and 50 for the bound key.
- Round 1 (agy, FINDINGS-4, all verified and folded): Task 2's index test used a scan count, which grows even when
  the slug condition is not used (driver measurement: under `enable_seqscan = off` the partial index is scanned for its
  predicate alone; agy's proposed fix, an unindexed key, has the same flaw) -> entries returned under
  `force_generic_plan`, with the measured 0 vs 50; the two `saveDraft.test.ts` tests that store arbitrary JSON as
  `body` (`:302-330`, `:333-355`) get explicit wrap-and-read-back instructions; `export.test.ts:122` is an incomplete
  root, not a string, and its fix is named.
