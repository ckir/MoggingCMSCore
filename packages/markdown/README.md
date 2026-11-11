# @mogging/markdown

Markdown import and export for MoggingCMSCore. It converts Markdown (and MDX) to and from the portable
rich-text tree (spec 6.5), and moves whole folders of content files in and out of the database through
the `@mogging/core` SDK.

```ts
import { importFolder, exportFolder } from "@mogging/markdown";

const report = await importFolder(ctx, { dir: "content", publish: false });
const out = await exportFolder(ctx, { dir: "export" });
```

## Import layout

```
<dir>/<locale>/<collection>/<slug>.md        (or .mdx)
```

- The file path, without the extension, is the shared `slug`. It may contain `/` (nested folders) and
  must be lower case. The same relative path in every locale folder is the same document.
- A document is identified by (collection, slug) from the source-locale file. Other locales match by the
  same relative path.
- Front matter is YAML. Each key maps to a field by name. A key that is not declared is a per-file error.
  The Markdown body goes to the collection's body field. A whitespace-only body means absent.
- Shared fields are read from the source-locale file only; shared keys in other locales are ignored with
  a warning.
- References are written as a slug or a UUID. Slugs are normalized like core slugs (NFC and lower case),
  so references are case-insensitive. A `null` entry where a reference is declared is a per-file error.
- A bare key (`banner:`) means absent. An explicit empty (`banner: ""`, `tags: []`) means suppressed.
- `.md` and `.mdx` are both accepted; the extension sets the parse mode.
- Import is two-pass: pass 1 creates documents so that references can be resolved, pass 2 writes the data.
  Each file runs in its own transaction. A file whose content already equals the stored draft is skipped
  and reported as `unchanged`.
- Re-importing writes a new `DRAFT_HUMAN` version. Over an unpublished human draft it replaces that draft
  with the warning `replaced unpublished DRAFT_HUMAN draft ...`; older versions stay in history. With
  `publish: true`, drafts that equal the file are published in the same run.

## Export

`exportFolder` writes the **published** heads to `<dir>/<locale>/<collection>/<slug>.<ext>`, where `ext`
is `mdx` when the published body tree has mode `mdx`, else `md`. The source-locale file carries the shared
fields. References are written as slugs. Empties are always written explicitly and a bare key is never
written, so export followed by import leaves every file `unchanged` (spec 9.4).

## Supported syntax

CommonMark plus GFM: headings, paragraphs, emphasis, strong, strikethrough, inline code, links, images,
block quotes, ordered and unordered lists (including task lists), tables, fenced code, thematic breaks and
hard breaks. Container directives are supported as `:::name[Title]` ... `:::`.

Opaque (kept byte-for-byte, never translated): MDX/JSX components and expressions, ESM, HTML, reference-style
links and definitions, footnotes, and other nodes the tree has no type for.

VitePress writes containers as `::: tip` followed by a title on the same line. That form is not parsed;
the importer warns. Write `:::tip[Title]` instead.

The byte-for-byte rule holds relative to the input after LF and NFC normalization: opaque spans and code
come back exactly as they went in once line endings are LF and the text is NFC.

## Known limits

- Reference-style links and definitions are opaque, so their link text is not translated.
- A suppressed (empty-tree) **body** exports as an empty body and re-imports as absent.
- Concurrent imports of the same new slug can create two documents (core has no unique slug index).
- Export never deletes stale files.
- Renaming a page between `.md` and `.mdx` changes its tree `mode`, so its hash changes and its
  translations show as stale.
- A few rare adjacent-formatting combinations are normalized on first import and are stable afterwards.
  Examples: two inline code spans side by side under the same emphasis, or a strikethrough starting with
  punctuation inside a word.
- If a source file fails pass 2, its pass-1 document remains, holding only its slug. The file is reported
  as `error`, and a later import fills it in.

## Licence

MoggingCMSCore is source-available, not open source; the terms are in [LICENSE.md](../../LICENSE.md).
