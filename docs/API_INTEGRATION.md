# API and frontend integration

MoggingCMS does **not** expose a REST or GraphQL API, an HTTP server, or a JavaScript browser SDK.
The integration surface is:

1. the **`@mogging/core` TypeScript SDK**, called from a trusted Node.js process;
2. the **`mogging` CLI**, whose `query --json` form is usable from any language or build step;
3. **Markdown export**, for consumers that want files rather than database reads.

All three read the same stored snapshots; the default public path is the published head. There is no
separate delivery tier, no API key, and no preview token. Applications render the returned values
themselves.

> **Never ship `DATABASE_URL` or a database credential to a browser or mobile client.** The SDK has
> no authentication and anyone with the connection string can write. Put the SDK behind your own
> server endpoint or run it at build time.

## 1. SDK setup

```ts
import postgres from "postgres";
import { resolve, getDocument, listDocuments, getSyncState } from "@mogging/core";
import { config } from "./mogging.config.js";

// One client per process; postgres.js pools internally.
const sql = postgres(process.env.DATABASE_URL!, { max: 10 });

const ctx = { sql, config, actor: "web-build" };

const docs = await resolve(ctx, { collection: "posts", locale: "de-CH" });
await sql.end(); // on process shutdown
```

`Ctx` is `{ sql, config, actor }`:

- `sql` is a `postgres` client (the driver is a dependency of `@mogging/core`).
- `config` is the value returned by `defineConfig`, with normalized locales.
- `actor` is required by the type and is recorded by writes. Reads ignore it. It is attribution, not
  authentication; any string except one containing U+0000 is accepted.

The config is a TypeScript module. In a TypeScript build or a framework that compiles config files
(Next.js, Astro, Vite, tsx), import it directly. For a plain Node process that must load
`mogging.config.ts` at runtime, use a TypeScript loader such as `tsx` or `jiti`; the CLI uses
`jiti`. A production build can compile the config to `.js` and import that instead.

Run migrations once per database, normally from deployment or the CLI, not on every request:

```ts
import { migrate } from "@mogging/core";
await migrate(sql);
```

## 2. Reading published content

### 2.1 `resolve` — the primary read

```ts
const docs = await resolve(ctx, {
  collection: "posts",
  locale: "de-CH",
  ids: ["<uuid>", "..."], // optional
  limit: 20,              // optional, positive integer, no SDK-side upper cap
  asOf: new Date("2026-11-01T00:00:00Z"), // optional: time travel
});
```

Return shape:

```ts
type ResolvedDocument = {
  id: string;
  data: Record<string, unknown>; // resolved field values only
  fellBack: Record<string, string>; // field -> locale that supplied it
  missing: string[]; // localized fields no locale supplied
};
```

Rules that matter to a renderer:

- Only **published** heads are read. A saved draft or an approved-but-unpublished head is invisible.
- A localized field resolves to the first locale in its chain whose published snapshot has a
  non-null value. `fellBack[field]` is set when that locale is not the requested one.
- A field that no chain locale supplies is absent from `data` and listed in `missing`.
- Shared (non-localized) fields come from the document's shared published snapshot.
- A collection with localized fields needs a published localized snapshot somewhere in the chain to
  appear at all. A collection with only shared fields appears on its shared head.
- Ordering is `created_at, id` (oldest first). This is fixed; there is no sort parameter.
- `ids` filters by document id. Non-UUID values are ignored, and an empty/all-invalid list returns
  `[]` without querying.
- `asOf` applies publication windows and soft deletion as of that instant; see section 7.

There is **no field filter, search, sort, offset, total count, or relation expansion**. To filter by
a field, fetch a page and filter in the application (or query a read replica with your own SQL). To
expand a `reference` field, use `resolveReference` or a second `resolve` with the target ids.

### 2.2 `listDocuments` — keyset pagination

```ts
const page = await listDocuments(ctx, {
  collection: "posts",
  limit: 50,              // default 50; positive integer, no SDK-side upper cap
  after: lastId,          // optional cursor: the last id of the previous page
  includeDeleted: false,  // default false
});
// { items: [{ id, slug, createdAt }], next: string | null }
```

This returns metadata only, not content. `next` is the id to pass as `after`; it is `null` when the
page is the last one. The query orders by `(created_at, id)` and uses a keyset predicate, so it stays
stable under inserts. Deleted documents are omitted from `items` unless `includeDeleted` is true. An
`after` cursor may still name a deleted document: the cursor lookup reads its `(created_at, id)`
from `documents` regardless of `deleted_at`, so paging continues if a row is deleted between pages.

Typical page loader:

```ts
async function publishedPage(collection: string, locale: string, after?: string) {
  const { items, next } = await listDocuments(ctx, { collection, limit: 50, after });
  const docs = await resolve(ctx, { collection, locale, ids: items.map((i) => i.id) });
  // resolve preserves created_at order and omits ids without published content.
  return { docs, next };
}
```

`resolve` may return fewer documents than `items` because it omits documents with no visible
published content. That is not an error and does not mean the cursor is exhausted; stop only when
`listDocuments` returns `next: null`.

The CLI applies a stricter page size (1–200, default 20) than the SDK. There is no maximum in the
SDK; use a sensible page size, because a large page is one SQL statement returning all rows.

### 2.3 `getDocument` — raw heads, including drafts

```ts
const doc = await getDocument(ctx, { collection: "posts", docId });        // exactly one of
const doc2 = await getDocument(ctx, { collection: "posts", slug: "hello" }); // docId or slug
```

Return shape:

```ts
type Snapshot = {
  version: number;
  state: string; // PUBLISHED | DRAFT_HUMAN | DRAFT_AI | APPROVED
  data: Record<string, unknown>;
  sourceHashes: Record<string, string>;
  createdAt: Date;
  createdBy: string;
  publishedAt: Date | null;
  publishedBy: string | null;
};

type DocumentRecord = {
  id: string;
  collection: string;
  createdAt: Date;
  deletedAt: Date | null;
  shared: { published: Snapshot | null; draft: Snapshot | null };
  locales: Record<string, { published: Snapshot | null; draft: Snapshot | null }>;
};
```

`getDocument` applies **no fallback and no publication filtering**. It returns the raw published
and draft heads for the shared scope and every locale that has a head. It is the right primitive
for a review/preview server or an editor, not for public rendering.

Two edge cases:

- Addressed by `docId`, a soft-deleted document is returned with `deletedAt` set.
- Addressed by `slug`, the lookup matches the slug on a shared published or draft head (slug fields
  are always shared). If several documents match, live documents win over deleted ones, then a
  published head wins over a draft head, then the oldest document wins.

### 2.4 `resolveReference` — cross-locale links

```ts
const target = await resolveReference(ctx, { docId: ref, locale: "de-CH" });
// { id, resolvedLocale } | null
```

It applies the document-level fallback chain (the requested locale, then its configured fallbacks;
per-field overrides do not apply) and returns the locale in which the target has a published
localized head, or the requested locale for a shared-only collection. It returns `null` for an
unknown/deleted document, a malformed id, or a collection with localized fields that has no
published localized head anywhere in the chain.

Use `resolvedLocale` to decide whether a link is a normal same-locale link or a cross-locale one
(for example, add `hreflang` or a notice).

### 2.5 Sync state and review reads

For a translation dashboard:

```ts
const rows = await getSyncState(ctx, { collection: "posts", locale: "de" });
// { docId, locale, field, state: "current"|"stale"|"untracked"|"missing"|"orphaned", sourceVersion }
```

For a custom review UI:

```ts
const heads = await listDraftHeads(ctx, { collection: "posts", locale: "de", limit: 50 });
// { items: DraftHead[], next: string | null }

const review = await getDraftReview(ctx, { docId, locale: "de" });
// per-field: source, previous, previousFrom, draft, warnings, edited, sourceChanged
```

Both are unguarded reads. `listDraftHeads` supports `state: "DRAFT_AI" | "APPROVED" | "DRAFT_HUMAN"`,
`limit` 1–200 (default 50), and an opaque `after` cursor (`next` from the previous page).
`getDraftReview` throws `NotFoundError` if there is no draft head and refuses `locale: "shared"`.

## 3. Rendering rich text

A `richText` field is stored as a portable tree. The shape is defined and validated by
`@mogging/markdown` (`RichTextRoot`), and the same tree is what `markdownToTree` produces and
`treeToMarkdown` consumes.

```ts
type RichTextRoot = { type: "root"; version: 1; mode: "md" | "mdx"; children: Block[] };
```

Value handling: a rich-text field can, in principle, be a string, object or array at the storage
layer (that is what normalization accepts). The normal shape is a `RichTextRoot`. A renderer should
first check `typeof value === "string"` and either render it as trusted Markdown/HTML through the
application's existing pipeline or convert it with `markdownToTree`; otherwise treat it as a tree
and validate it with `validateTree` before rendering.

### 3.1 Block nodes

| `type` | Shape | Render as |
| --- | --- | --- |
| `paragraph` | `{ children: Inline[] }` | `<p>` |
| `heading` | `{ depth: 1..6, children: Inline[] }` | `<h1>`…`<h6>` |
| `thematicBreak` | `{ type }` | `<hr>` |
| `blockquote` | `{ children: Block[] }` | `<blockquote>` |
| `list` | `{ ordered, start, spread, children: ListItem[] }` | `<ol start>` / `<ul>`; `spread` is a layout hint |
| `listItem` | `{ checked: boolean \| null, spread, children: Block[] }` | `<li>`; `checked` non-null is a GFM task item |
| `table` | `{ align: ("left"\|"right"\|"center"\|null)[], children: TableRow[] }` | `<table>` with per-column alignment |
| `tableRow` | `{ children: TableCell[] }` | `<tr>` |
| `tableCell` | `{ children: Inline[] }` | `<td>` / `<th>` as appropriate |
| `code` | `{ lang: string \| null, meta: string \| null, value: string, source: string }` | `<pre><code class="language-…">`; `source` is the original fenced text |
| `container` | `{ name: string, attributes: Record<string,string>, label: Inline[] \| null, children: Block[] }` | Application-defined admonition/callout component |
| `opaqueBlock` | `{ node: string, source: string }` | Application-defined; `source` is verbatim MDX/JSX/HTML |

### 3.2 Inline nodes

| `type` | Shape | Render as |
| --- | --- | --- |
| `text` | `{ value: string, marks: Mark[] }` | Text with marks applied |
| `inlineCode` | `{ value, source, marks }` | `<code>` |
| `opaqueInline` | `{ node, source, marks }` | Application-defined; `source` is verbatim |
| `image` | `{ url, title: string \| null, alt: string, marks }` | `<img src alt title>` |
| `break` | `{ type }` | `<br>` |
| `link` | `{ url, title: string \| null, children: Inline[] }` | `<a href title>`; links cannot nest |

`marks` is a sorted array drawn from `"delete"`, `"emphasis"`, `"strong"` (canonical order:
delete, emphasis, strong). Adjacent text nodes with identical marks must be merged; the validator
enforces this.

### 3.3 A minimal renderer

```tsx
import { validateTree, type Block, type Inline, type RichTextRoot } from "@mogging/markdown";

function RichText({ value }: { value: unknown }) {
  if (typeof value === "string") {
    // Legacy/plain value: render through your existing Markdown pipeline.
    return <Markdown>{value}</Markdown>;
  }
  const root: RichTextRoot = validateTree(value);
  return <>{root.children.map((b, i) => <BlockView key={i} block={b} />)}</>;
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "paragraph": return <p>{block.children.map(InlineView)}</p>;
    case "heading": {
      const H = `h${block.depth}` as "h1";
      return <H>{block.children.map(InlineView)}</H>;
    }
    case "thematicBreak": return <hr />;
    case "blockquote": return <blockquote>{block.children.map((b, i) => <BlockView key={i} block={b} />)}</blockquote>;
    case "list": {
      const L = block.ordered ? "ol" : "ul";
      return <L start={block.start ?? undefined}>{block.children.map((it, i) => (
        <li key={i}>{it.children.map((b, j) => <BlockView key={j} block={b} />)}</li>
      ))}</L>;
    }
    case "code": return <pre><code data-lang={block.lang ?? undefined}>{block.value}</code></pre>;
    case "table": return <TableView table={block} />;
    case "container": return <Callout name={block.name} attributes={block.attributes} label={block.label}>{block.children.map((b, i) => <BlockView key={i} block={b} />)}</Callout>;
    case "opaqueBlock": return <MdxBlock node={block.node} source={block.source} />;
  }
}

function InlineView(node: Inline) {
  switch (node.type) {
    case "text": return applyMarks(node.value, node.marks);
    case "inlineCode": return <code>{node.value}</code>;
    case "opaqueInline": return <MdxInline node={node.node} source={node.source} />;
    case "image": return <img src={node.url} alt={node.alt} title={node.title ?? undefined} />;
    case "break": return <br />;
    case "link": return <a href={node.url} title={node.title ?? undefined}>{node.children.map(InlineView)}</a>;
  }
}
```

`applyMarks`, `Callout`, `MdxBlock`, `MdxInline`, `TableView`, and `Markdown` are application
components, not CMS exports. The CMS supplies structure; styling, syntax highlighting, MDX
evaluation and link handling are yours.

### 3.4 Dynamic blocks and MDX

There is no named "blocks" system in which editors pick reusable block types. Structured data is
expressed with ordinary fields:

- `object({...})` for a fixed group (hero copy, SEO metadata, a CTA),
- `list(object({...}))` for repeated groups (sections, cards, FAQ entries),
- `list(reference("..."))` for related documents.

Render these by field name and kind. Because `data` is `Record<string, unknown>`, use a runtime
schema (Zod, Valibot, a hand-written guard) at the boundary if you need stronger typing.

Rich-text `container` and `opaqueBlock`/`opaqueInline` nodes are the closest thing to embedded
blocks. The engine keeps containers as structured nodes and preserves opaque nodes byte-for-byte,
but it interprets neither. An MDX consumer can compile `source`; any other consumer must map
`node`/`name` to its own components. Treat opaque source as untrusted if authors are not fully
trusted, and sanitize before injecting HTML.

## 4. Draft preview without preview tokens

There is no `draftMode`, preview URL, preview token or signed cookie in the engine. Draft content is
available through the same SDK, but only because the caller already has database access. A safe
preview design is:

1. Build an authenticated server route in **your** application (your auth, your session).
2. In that route, call `getDocument` for the raw heads and/or `getDraftReview` for a reviewer view.
3. Merge the draft over the published data for preview.
4. Return only the fields the previewer is allowed to see.
5. Never expose the database URL, a raw SDK proxy, or a generic "run any query" endpoint.

```ts
// server-only route, after your own authorization check
const doc = await getDocument(ctx, { collection, docId });
if (!doc) return notFound();

const shared = doc.shared.draft?.data ?? doc.shared.published?.data ?? {};
const localized = doc.locales[locale]?.draft?.data ?? doc.locales[locale]?.published?.data ?? {};
const preview = { ...shared, ...localized }; // no fallback applied
```

Important differences from public rendering:

- `getDocument` does **not** apply locale fallback. If the draft lacks a field, overlay the
  published `resolve` result for that locale, or implement the chain yourself with `chainFor`.
- A draft is a complete snapshot of the scope it belongs to. For a human draft, a field omitted
  from `data` is absent, not "unchanged"; do not assume the draft is a patch.
- A `DRAFT_AI` draft is unapproved model output. Preview it for reviewers, not for end users.
- `resolve` has no `preview` or `draft` flag. Do not be tempted to add one by reading the database
  from a public route.

For a scripted editorial view, the CLI exposes the same data:

```bash
mogging review list --state DRAFT_AI --json
mogging review show docs/intro --locale de --json
```

Both are reads. They require the same database access and carry the same trust boundary as the SDK.

## 5. The CLI as an integration surface

`mogging query` is read-only and never calls the licence guard. It is the simplest way for a
non-Node build step, a static-site generator, or a shell script to read published content.

```bash
# One collection, resolved for a locale; --limit 1..200, default 20
mogging query posts --locale de-CH --limit 50 --json

# One document by slug or id (nested slugs use the first slash)
mogging query posts/hello-world --locale de --json

# Raw heads and versions instead of resolved data; requires a document target
mogging query posts/hello-world --raw --json
```

With `--json`, stdout is exactly one JSON document. A successful collection query looks like:

```json
{
  "ok": true,
  "partial": false,
  "data": [
    {
      "id": "3f2c...",
      "data": { "slug": "hello-world", "title": "Hallo", "body": { "type": "root", "version": 1, "mode": "md", "children": [] } },
      "fellBack": { "body": "en" },
      "missing": []
    }
  ],
  "licence": { "state": "evaluation", "daysLeft": 12, "warn": false, "plan": null, "licensee": null, "keyError": null }
}
```

A document query has the same shape with `data` being one `ResolvedDocument`. With `--raw`, `data`
is a `DocumentRecord` (published/draft heads per scope). A failure is still one JSON document:

```json
{ "ok": false, "error": { "code": "not_found", "message": "..." }, "licence": { "...": "..." } }
```

`partial` appears only on command-result documents and is true only for exit code `4`, used by
commands that process several items. `query` is a single-item command and uses `ok: false` plus
exit `1` for a missing document.

Exit codes: `0` success, `1` error, `2` usage error, `3` licence refusal, `4` partial failure.
`query` is not licence-guarded, so a valid database URL is enough even after the evaluation ends.
Human output goes to stdout; progress and the licence line go to stderr. Passwords in database URLs
are redacted in both streams.

Invocation notes:

- From this repository, use `pnpm --filter @mogging/cli dev query ...` with an **absolute**
  `--config` path; the filter runs with `packages/cli` as its working directory. Do not put `--`
  between `dev` and the command.
- After `pnpm build`, running `node packages/cli/dist/bin.js` from the repository does not work
  because the workspace export map still points at `src/*.ts`. Use the packed install produced by
  `pnpm smoke:pack`, or run the CLI from source. Until the packages are published, there is no
  registry install.

## 6. Caching and revalidation

The engine does **not** invalidate caches, call webhooks, or push changes. Every write commits a row
and returns. Your application owns freshness:

- **Build-time rendering:** rebuild or re-fetch after the publish step. If the publish happens in
  your own admin process, trigger the rebuild/cache purge from there.
- **Runtime rendering:** cache resolved pages keyed by `(collection, locale, document id)`. A
  short TTL is the simplest correct policy. For event-driven invalidation, call your cache purge in
  the same server action that calls `publish`/`publishRelease`; derive the keys from the documents
  and locales in the call.
- **Version-aware keys:** `resolve` does not return a version. `getDocument` does: the published
  snapshot's `version` and `publishedAt` can serve as a content version/key, at the cost of one
  extra read per document. There is no SDK function for "max published timestamp across the
  collection"; if you need a cheap global build stamp, maintain it in your own database or query a
  read replica.
- **Stale translation display:** `fellBack` tells you when a field came from another locale, and
  `getSyncState` tells you whether a translation is stale. Use either to show a "not yet translated"
  notice; the engine does not hide fallback content.

There is no cache key, ETag, `Last-Modified`, CDN hook, or ISR integration in the SDK. All of that is
application-level.

## 7. Time travel

`resolve` accepts `asOf?: Date`. It selects snapshots with `published_at <= asOf` and
(`unpublished_at` is null or `> asOf`), and hides documents with `deleted_at <= asOf`. It is exact
at millisecond granularity because publish/unpublish timestamps are stored at millisecond
precision.

```ts
const asOf = new Date("2026-11-01T00:00:00.000Z");
const old = await resolve(ctx, { collection: "posts", locale: "en", asOf });
```

Only `resolve` supports `asOf`. `getDocument`, `listDocuments`, `listDraftHeads` and
`getDraftReview` always read the current state. A republished historical version is copied to a new
row (rather than mutating the old one) precisely so that its original publication window remains
valid for `asOf`.

## 8. Error handling

All engine errors extend `MoggingError` and carry a stable `code`:

| Class | `code` | Typical cause |
| --- | --- | --- |
| `ValidationError` | `validation_error` | Malformed locale, undeclared field, wrong value type, bad limit, U+0000, unknown warning acknowledgement. |
| `NotFoundError` | `not_found` | Unknown collection, document, version, release, or draft head. |
| `ConflictError` | `conflict` | `expectedVersion` mismatch, release item held at another version, duplicate release name. |
| `NotPublishableError` | `not_publishable` | Publishing a `DRAFT_AI`, approving a non-AI head, releasing a non-draft head. |
| `StaleReleaseError` | `stale_release` | Release publication found stale translations; `err.items` carries `{ docId, locale, fields }`. |
| `LicenceError` | `LICENCE_INVALID`, `LICENCE_EXPIRED`, `LICENCE_REQUIRED` | Key verification failure, or a guarded write after the evaluation window. |

For public routes, map `NotFoundError` to 404, `ValidationError` to 400, and licence errors to 402
or 403 with the message from the error. Do not expose raw database errors.

## 9. Deployment checklist

- Run the SDK and CLI only in trusted server/build environments. Never bundle `DATABASE_URL`.
- Create one `postgres` client per process and close it on shutdown (`sql.end()`).
- Apply migrations before serving traffic (`migrate`), and use a database role that can read for
  public rendering. The SDK itself has no read-only mode; restrict writes at the database role or by
  limiting which process can call write functions.
- Treat `actor` as a log field, not an identity. If you need real approvals, authenticate the person
  in your own application and pass a trustworthy actor value from that server process.
- Implement your own cache invalidation, search indexing and webhooks around the publish calls.
- Host images and other assets elsewhere; the engine stores URLs only.
- If you use AI translation, set a spend limit on the provider key and reconcile recorded spend with
  the provider's usage; the application budget is a quota, not a hard bill bound.
