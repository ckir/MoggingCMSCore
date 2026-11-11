# MoggingCMSCore Plan 2: `@mogging/markdown` (tree, converters, sentinel pass, import and export)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `@mogging/markdown`: the portable rich-text tree (a storage contract, spec 9.4), Markdown-to-tree and tree-to-Markdown converters, the sentinel pass and structural validator that plan 3's AI pipeline calls, and folder import and export (spec 9.4) over the merged `@mogging/core`.

**Architecture:** A new workspace package `packages/markdown`. Parsing reuses the spike's unified/remark stack (spike `spikes/rich-text-sentinel/run.ts`), and the resulting mdast is converted into our own closed, marks-based tree. Opaque nodes and code blocks keep their original source text, so they are byte-for-byte. Serialization converts our tree back to mdast and runs `mdast-util-to-markdown`; opaque text and code go out verbatim as raw `html` nodes. The sentinel pass and validator are pure functions over our tree. Import and export are the only parts that touch the database, and they do so only through `@mogging/core`'s public API.

**Tech Stack:** TypeScript 5, Node >=22, pnpm workspace, vitest 5, `@mogging/core` (workspace), pinned exactly as the spike measured them: `unified@11.0.5`, `remark-parse@11.0.0`, `remark-gfm@4.0.1`, `remark-mdx@3.1.1`, `micromark-extension-directive@4.0.0`, `mdast-util-directive@3.1.0`, `mdast-util-gfm@3.1.0`, `mdast-util-to-markdown@2.1.2`, `@types/mdast@4.0.4`; plus `yaml@^2` for front matter.

**Spec:** `docs/superpowers/specs/2026-11-11-moggingcms-core-design.md` (sections 6.1, 6.2, 6.4, 6.5, 9.4, 10). Spike evidence: `docs/superpowers/spikes/2026-11-11-rich-text-sentinel-results.md`.

**Plan series:** Plan 1 (core) is merged at `6c7c5ef`. This is plan 2. Plan 3 (`@mogging/ai`) is written only after this plan merges, because its rich-text path calls `sentinelize`/`restoreDraft` from Task 4.

**Owner decisions this plan executes (2026-11-11, agy-first `.clavity/seams/plan2-forks-first.md`, ALIGNED):**
- F1: our own marks-based tree. Opaque nodes hold the original source slice, marks are kept in canonical order, and the root records `mode: "md" | "mdx"`.
- F2: container directive bodies (`:::note[Title]`) are parsed and translatable.
- F3: sentinelize, restore and structural validation live in this package.
- F4: a reference in front matter is written as the target's slug or as a UUID, and import resolves references in two passes.
- F5: re-importing an unchanged file writes nothing. A file equal to the published head never replaces a pending `DRAFT_AI` or `APPROVED` draft head.
- F6: v0.1 export writes published heads only.
- F7: each file is imported in one transaction; a failure is recorded and import continues. Measured 2026-11-11: core writes nest as savepoints inside `sql.begin` on postgres 4.1.0 (`types/index.d.ts:926`), and a probe test showed that a rollback undoes `createDocument` plus two `saveDraft` calls.

## Global Constraints

- Node `>=22`, ESM, TypeScript strict (`tsconfig.base.json`), `engines.node: ">=22"`, `"license": "SEE LICENSE IN LICENSE.md"`, `private: true`, version `0.0.0`.
- The package talks to the database only through `@mogging/core`'s public exports (`packages/core/src/index.ts`). It never imports from `@mogging/core/src/...` internals and never writes SQL.
- No LLM call and no network access anywhere in this package (spec 4).
- Tree contract version is `1`. Changing any tree type after this plan merges requires a versioned migration with a converter (spec 9.4).
- Byte-for-byte guarantee (spec 6.5) holds for code blocks and opaque nodes relative to the **normalized input**. Import normalizes the whole file to LF line endings and Unicode NFC first, because core NFC-normalizes every rich-text string (`packages/core/src/values/normalize.ts:11`).
- Supported syntax: CommonMark, GFM tables, strikethrough and task lists, fenced code, and remark-directive containers (`:::name[label]{attrs}`). Footnotes, HTML, MDX ESM/expressions/JSX, leaf directives, definitions and reference-style links or images are opaque.
- Text directives stay disabled. They split the sentinel `⟦MOGGING:n⟧` at the `:` (spike finding 1).
- Sentinel format is `⟦MOGGING:n⟧` with `n` a 0-based document-order index (spec 6.5).
- Every write goes through a core function that takes `ctx.actor` (spec 8.7). Licence guarding is inherited from `saveDraft` and `publish`.
- Tests that need Postgres use a package-local copy of core's `withTestDb` (`packages/markdown/test/db.ts`, identical to `packages/core/test/db.ts`), so no file outside the package's `rootDir` is imported. They also need `DATABASE_URL`.
- Commit after every green task, using conventional commit messages that end with the session's attribution trailer.

## Review Focus

1. **Adjacent and intraword marks** (`a**b**c`, `***x***`, `*a*__b__`) must survive md -> tree -> md -> tree unchanged. A converter that is not idempotent re-hashes every page on every import and shows false staleness. Pinned in Task 3 (`idempotent on mark edge cases`).
2. **A code block or an HTML block inside a blockquote or list item** must keep its exact content bytes, without the container's `> ` or indentation prefix. Spec 6.5's byte-for-byte promise is easiest to break here. Pinned in Task 2 (`opaque source inside containers`) and Task 3.
3. **Source prose that contains `⟦`, `⟧` or `MOGGING:<digit>`** must make `sentinelize` throw. Otherwise restore re-inserts the wrong node with no error. Pinned in Task 4.
4. **Running the same import twice** must write nothing the second time, and an AI draft head that exists between the runs must survive. Pinned in Task 6.
5. **`banner:` (bare), `banner: ""` and a missing key** mean absent, suppressed and absent. Export followed by import must keep suppression. Pinned in Tasks 5 and 7.

---

### Task 1: Package scaffold and the tree contract

**Files:**
- Create: `packages/markdown/package.json`, `packages/markdown/tsconfig.json`, `packages/markdown/vitest.config.ts` (same content as `packages/core/vitest.config.ts`), `packages/markdown/src/index.ts`, `packages/markdown/src/tree.ts`, `packages/markdown/test/tree.test.ts`, `packages/markdown/test/api.test.ts`
- Modify: root `package.json` script `typecheck` to `tsc --noEmit -p packages/core && tsc --noEmit -p packages/markdown`

**Interfaces:**
- Produces, in `src/tree.ts`. These are the contract types, exact copy:

```ts
export type Mark = "delete" | "emphasis" | "strong";          // canonical order = this (alphabetical) order
export const MARK_ORDER: readonly Mark[] = ["delete", "emphasis", "strong"];

export type Text = { type: "text"; value: string; marks: Mark[] };
export type InlineCode = { type: "inlineCode"; value: string; source: string; marks: Mark[] };
export type OpaqueInline = { type: "opaqueInline"; node: string; source: string; marks: Mark[] };
export type Image = { type: "image"; url: string; title: string | null; alt: string; marks: Mark[] };
export type Break = { type: "break" };
export type Link = { type: "link"; url: string; title: string | null; children: Array<Text | InlineCode | OpaqueInline | Image | Break> };
export type Inline = Text | InlineCode | OpaqueInline | Image | Break | Link;

export type Paragraph = { type: "paragraph"; children: Inline[] };
export type Heading = { type: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] };
export type ThematicBreak = { type: "thematicBreak" };
export type Blockquote = { type: "blockquote"; children: Block[] };
export type ListItem = { type: "listItem"; checked: boolean | null; spread: boolean; children: Block[] };
export type List = { type: "list"; ordered: boolean; start: number | null; spread: boolean; children: ListItem[] };
export type TableCell = { type: "tableCell"; children: Inline[] };
export type TableRow = { type: "tableRow"; children: TableCell[] };
export type Table = { type: "table"; align: Array<"left" | "right" | "center" | null>; children: TableRow[] };
export type Code = { type: "code"; lang: string | null; meta: string | null; value: string; source: string };
export type Container = { type: "container"; name: string; attributes: Record<string, string>; label: Inline[] | null; children: Block[] };
export type OpaqueBlock = { type: "opaqueBlock"; node: string; source: string };
export type Block = Paragraph | Heading | ThematicBreak | Blockquote | List | Table | Code | Container | OpaqueBlock;

export type RichTextRoot = { type: "root"; version: 1; mode: "md" | "mdx"; children: Block[] };
```

- Produces: `validateTree(value: unknown, path?: string): RichTextRoot`. It throws core's `ValidationError` naming the JSON path of the first violation, and returns the same object on success. Checks: every node has exactly the keys its type declares (no extras, none missing); `marks` is sorted in `MARK_ORDER` with no duplicates; a `Link`'s children contain no `Link`; adjacent `Text` siblings never carry identical marks; no `Text` has `value === ""`; a `container` label is `null` or a non-empty inline array; `version === 1`.
- Canonical-form invariants (Tasks 2 to 4 must emit only trees that pass `validateTree`): marks sorted and unique; adjacent equal-marks text merged; empty text dropped; every nullable key present (as `null`), never omitted.

- [ ] **Step 1: Write `package.json`.** Name `@mogging/markdown`, `type: module`, `main`/`exports` `./src/index.ts` (same pattern as core), `files: ["src", "README.md"]`, script `test: "vitest run"`. Dependencies are the exact versions in the Tech Stack line plus `"@mogging/core": "workspace:*"` and `"yaml": "^2"`. devDependencies: `@types/node@^22`, `typescript@^5`, `vitest@^5`. `tsconfig.json` copies `packages/core/tsconfig.json`. Run `pnpm install`. Expected: lockfile updated, no peer warnings for the remark stack.
- [ ] **Step 2: Write the failing tests** in `test/tree.test.ts`:
  - `validateTree accepts a canonical tree`: a root with every block type and every inline type once (including a `container` with `label`, and a `link` holding an `inlineCode`) returns the same reference.
  - `validateTree rejects`: one `it.each` case per violation, each expecting `ValidationError` whose message contains the given path. Cases: unsorted marks `["strong","emphasis"]` at `$.children[0].children[0].marks`; duplicate mark; extra key `foo`; missing `title` on a link; nested link; two adjacent text nodes with equal marks; empty text; `version: 2`; unknown `type: "html"`; `depth: 7`; a container with `label: []`.
- [ ] **Step 3: Write `test/api.test.ts`**, which pins the exact export surface as `Object.keys(await import("../src/index.js")).sort()`. At the end of this task the list is `["MARK_ORDER", "validateTree"]`. Every later task updates this list in the same commit that adds an export.
- [ ] **Step 4: Run** `pnpm --filter @mogging/markdown test`. Expected: FAIL (module not found).
- [ ] **Step 5: Implement** `src/tree.ts` and `src/index.ts`. The validator is one recursive function with a `switch` over `type`. Import `ValidationError` from `@mogging/core`.
- [ ] **Step 6: Run** `pnpm --filter @mogging/markdown test` and `pnpm --filter @mogging/markdown exec tsc --noEmit`. Expected: PASS, tsc clean.
- [ ] **Step 7: Commit** `feat(markdown): package scaffold and portable rich-text tree contract v1`.

---

### Task 2: Markdown to tree

**Files:**
- Create: `packages/markdown/src/parse.ts`, `packages/markdown/test/parse.test.ts`
- Create: `packages/markdown/test/corpus/` (copy the 20 `.md` pages from `spikes/rich-text-sentinel/corpus/`) and `packages/markdown/test/corpus/README.md` (copy the "Corpus provenance" section of `spikes/rich-text-sentinel/README.md` verbatim, then add one line saying the pages were copied from the spike at `6c7c5ef`)

**Interfaces:**
- Consumes: the Task 1 types.
- Produces: `markdownToTree(markdown: string, options?: { mode?: "md" | "mdx" }): RichTextRoot`. The default mode is `"md"`. The input is first normalized (`\r\n` and `\r` become `\n`, then `.normalize("NFC")`). An MDX parse error is thrown as core's `ValidationError` with the message `invalid MDX: <parser message>`. There is **no** automatic md fallback: the mode comes from the caller (import uses the file extension, Task 6).
- Produces (internal, used by Tasks 3 and 4): `parseMdast(markdown: string, mode: "md" | "mdx"): import("mdast").Root`. This is the spike's `parse` (run.ts:62-71) with block-only directives: `unified().use(remarkParse).use(remarkGfm)`, then the spike's `remarkBlockDirectives` (run.ts:62-66), then `remarkMdx` when mode is `mdx`.

**Conversion table (complete; any mdast type not listed falls into the "any other" row):**

| context | mdast type | becomes |
|---|---|---|
| block (children of root, blockquote, listItem, containerDirective) | `paragraph` | `paragraph` |
| block | `heading` | `heading` (depth kept) |
| block | `thematicBreak` | `thematicBreak` |
| block | `blockquote` | `blockquote` |
| block | `list` | `list` (`ordered ?? false`, `start ?? null`, `spread ?? false`) |
| list | `listItem` | `listItem` (`checked ?? null`, `spread ?? false`) |
| block | `table` | `table` (`align` entries `?? null`) -> `tableRow` -> `tableCell` |
| block | `code` | `code` (`lang ?? null`, `meta ?? null`, `value`, `source` = sliced source) |
| block | `containerDirective` | `container`. `name`; `attributes` = the directive's attributes with null or undefined values mapped to `""`; `label` = inlines of the first child paragraph whose `data.directiveLabel === true`, else `null`, and an empty label (`:::tip[]`) is `null` too (`validateTree` rejects `label: []`); `children` = the remaining children as blocks |
| block | `html`, `leafDirective`, `definition`, `footnoteDefinition`, `mdxjsEsm`, `mdxFlowExpression`, `mdxJsxFlowElement`, `yaml`, `toml`, `math`, and any other type | `opaqueBlock` { `node`: mdast type, `source`: sliced source } |
| inline (children of paragraph, heading, tableCell, link, emphasis, strong, delete, directive label) | `text` | `text` with the marks currently in scope |
| inline | `emphasis` / `strong` / `delete` | adds `emphasis` / `strong` / `delete` to the marks in scope, then descends |
| inline | `link` | `link` (`title ?? null`). Marks in scope are pushed down onto its children, never stored on the link |
| inline | `image` | `image` (`title ?? null`, `alt ?? ""`, marks in scope) |
| inline | `break` | `break` |
| inline | `inlineCode` | `inlineCode` (`value`, `source` = sliced source, marks in scope) |
| inline | `html`, `mdxJsxTextElement`, `mdxTextExpression`, `footnoteReference`, `linkReference`, `imageReference`, `textDirective`, `inlineMath`, and any other type | `opaqueInline` { `node`, `source`, marks in scope } |

After conversion, canonicalize each inline list: sort and deduplicate marks, drop empty text, and merge adjacent text with equal marks.

**Source slicing (an algorithm the types do not determine):** `slice(src, node, ancestors)` takes `src.slice(node.position.start.offset, node.position.end.offset)` and splits it on `\n`. The first line is kept as is. On every later line, it removes the longest prefix of at most `node.position.start.column - 1` characters that consists only of space, tab and `>`. The result is the lines rejoined with `\n`. This removes container prefixes (`> `, list indentation) but keeps the node's own content. If a node has no `position`, throw an `Error` with the message `internal: node without position`.

- [ ] **Step 1: Write the failing tests** in `test/parse.test.ts`:
  - `paragraph with marks, inline code and link`: `markdownToTree("Hello **big** `x` [a](u)\n")` deep-equals
    `{ type: "root", version: 1, mode: "md", children: [{ type: "paragraph", children: [ {type:"text",value:"Hello ",marks:[]}, {type:"text",value:"big",marks:["strong"]}, {type:"text",value:" ",marks:[]}, {type:"inlineCode",value:"x",source:"`x`",marks:[]}, {type:"text",value:" ",marks:[]}, {type:"link",url:"u",title:null,children:[{type:"text",value:"a",marks:[]}]} ] }] }`.
  - `marks pushed into links and sorted`: `**[a](u)**` gives a link child `{type:"text",value:"a",marks:["strong"]}` and no marks on the link. `***x***` gives `marks: ["emphasis","strong"]`.
  - `container directive with label and attributes`: `":::warning[Be **careful**]{#w .x}\nBody text.\n:::\n"` gives `container` with `name: "warning"`, `attributes: { id: "w", class: "x" }`, label `[text "Be ", text "careful" strong]`, and children `[paragraph "Body text."]`.
  - `text directive syntax is not parsed`: `"see ⟦MOGGING:3⟧ and :abbr here"` gives a single text node containing the whole line.
  - `opaque source inside containers`: in `"> ```js\n> let a = 1;\n>   b\n> ```\n"` the code node's `source` is exactly `` "```js\nlet a = 1;\n  b\n```" ``. In `"- item\n\n  <div>\n    x\n  </div>\n"` the opaqueBlock (`node: "html"`) `source` is exactly `"<div>\n  x\n</div>"`.
  - `mdx mode`: `markdownToTree("<Badge text=\"x\" /> and {name}\n", { mode: "mdx" })` gives a paragraph with an `opaqueInline` `mdxJsxTextElement` and an `opaqueInline` `mdxTextExpression` whose `source` is `{name}`. The same string in md mode gives text with `{name}` inside it and an `opaqueInline` `html` for `<Badge text="x" />`.
  - `invalid MDX throws`: `markdownToTree("<br>\n", { mode: "mdx" })` throws `ValidationError` whose message starts with `invalid MDX:`.
  - `CRLF and NFC normalized`: `"Café\r\n"` gives text `"Café"` (NFC, one code point) with no `\r`.
  - `every corpus page converts to a valid tree`: for each file in `test/corpus/*.md`, `validateTree(markdownToTree(text))` does not throw.
- [ ] **Step 2: Run** `pnpm --filter @mogging/markdown test -- parse`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/parse.ts` per the table and the slicing algorithm. Export `markdownToTree` from `src/index.ts` and add it to the api test list.
- [ ] **Step 4: Run** the package tests and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(markdown): markdown-to-tree converter with byte-exact opaque slices`.

---

### Task 3: Tree to Markdown

**Files:**
- Create: `packages/markdown/src/serialize.ts`, `packages/markdown/test/serialize.test.ts`

**Interfaces:**
- Consumes: `markdownToTree`, `parseMdast` (Task 2), and the tree types.
- Produces: `treeToMarkdown(root: RichTextRoot): string`. It calls `validateTree` first. It converts to mdast and runs `toMarkdown(mdast, { extensions: [gfmToMarkdown(), directiveToMarkdown()] })`. `code`, `opaqueBlock`, `inlineCode` and `opaqueInline` are emitted as mdast `html` nodes whose `value` is the node's `source`, so they come out verbatim and the serializer re-adds any container prefix. A `container` becomes `containerDirective` with its label as a first paragraph carrying `data: { directiveLabel: true }`.
- Marks to mdast nesting (an algorithm the types do not determine). `wrap(inlines, applied: Set<Mark>)` walks the list left to right. For node `i`, take the first mark in `MARK_ORDER` that is on node `i` and not in `applied`. If there is none, emit the leaf. Otherwise take the maximal run of consecutive nodes from `i` that carry that mark, and emit `{ type: <mdast name>, children: wrap(run, applied ∪ {mark}) }`. `Break` and `Link` carry no marks, so they end a run.

- [ ] **Step 1: Write the failing tests** in `test/serialize.test.ts`:
  - `idempotent on every corpus page`: for each corpus page, `t1 = markdownToTree(src)`, `md1 = treeToMarkdown(t1)`, `t2 = markdownToTree(md1)`, then `expect(t2).toEqual(t1)` and `expect(treeToMarkdown(t2)).toBe(md1)`.
  - `idempotent on mark edge cases`: the same property for `it.each` over `["a**b**c", "***x***", "*a*__b__", "**a *b* c**", "~~*x*~~ y", "[**a** b](u \"t\")", "`x` **`y`**", "a  \nb"]`.
  - `code and opaque bytes survive inside containers`: for each source in Task 2's container tests plus ``"- a\n\n  ~~~py\n  x = 1\n  ~~~\n"``, every `code`, `opaqueBlock`, `inlineCode` and `opaqueInline` `source` in `markdownToTree(treeToMarkdown(markdownToTree(src)))` equals the one in `markdownToTree(src)`.
  - `container round trip`: `":::tip[Title]\nText\n:::\n"` serializes to a string that parses back to an equal tree, and the string contains `:::tip[Title]`.
  - `mdx mode preserved`: an mdx tree with an `opaqueInline` JSX element round-trips through `treeToMarkdown` and then `markdownToTree(..., { mode: "mdx" })`.
  - `rejects an invalid tree`: `treeToMarkdown({ ...valid, version: 2 } as never)` throws `ValidationError`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** `src/serialize.ts`. Export `treeToMarkdown` and add it to the api list. If a corpus page is not idempotent, fix the converter in `parse.ts` or `serialize.ts`. Do not exclude the page. If a page truly cannot be made idempotent, STOP and report it with the minimal reproducing snippet.
- [ ] **Step 4: Run** the package tests and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(markdown): tree-to-markdown serializer, idempotent over the corpus`.

---

### Task 4: Sentinel pass and structural validation

**Files:**
- Create: `packages/markdown/src/sentinel.ts`, `packages/markdown/test/sentinel.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces (plan 3 depends on these exact names):

```ts
export type RejectionCode =
  | "PARSE_ERROR" | "SENTINEL_ALTERED" | "SENTINEL_DUPLICATED" | "SENTINEL_MISSING"
  | "BLOCK_SEQUENCE" | "LINK_TARGETS" | "PLACEHOLDER";
export const REJECTION_ORDER: readonly RejectionCode[] =
  ["PARSE_ERROR", "SENTINEL_ALTERED", "SENTINEL_DUPLICATED", "SENTINEL_MISSING", "BLOCK_SEQUENCE", "LINK_TARGETS", "PLACEHOLDER"];
export type SentinelOriginal = { index: number; kind: "block" | "inline"; node: Code | OpaqueBlock | InlineCode | OpaqueInline };
export type SentinelPrepared = { source: RichTextRoot; markdown: string; originals: SentinelOriginal[] };
export type RestoreResult =
  | { ok: true; root: RichTextRoot }
  | { ok: false; codes: RejectionCode[]; detail: string };   // codes non-empty, in REJECTION_ORDER, unique
export function sentinelize(root: RichTextRoot): SentinelPrepared;
export function restoreDraft(prepared: SentinelPrepared, draftMarkdown: string): RestoreResult;
```

- `sentinelize` validates the tree, then deep-clones it. It walks in document order. A `code` or `opaqueBlock` becomes `{type:"paragraph",children:[{type:"text",value:"⟦MOGGING:n⟧",marks:[]}]}`. An `inlineCode` or `opaqueInline` becomes `{type:"text",value:"⟦MOGGING:n⟧",marks:<its marks>}`. Text is then re-canonicalized (merged). `markdown = treeToMarkdown(clone)`. It throws `ValidationError("source already contains a sentinel token at <path>")` when any `text.value`, `image.alt`, link or image `url`, or `title` in the **input** matches `/[⟦⟧]|MOGGING:\d/`. This is the same pattern `restoreDraft` treats as residue, so an identity translation of any accepted source is never rejected.
- `restoreDraft` port of spike `validate` (run.ts:178-288), with these deliberate differences:
  1. **Draft parse:** `markdownToTree(draft, { mode: prepared.source.mode })`. If it throws, return `PARSE_ERROR` immediately.
  2. **Sentinel scan** on the raw draft string with `/⟦MOGGING:(\d+)⟧/g`. Any residue matching `/[⟦⟧]|MOGGING:\d/` left after removing the matches, or any index `>= originals.length`, is `SENTINEL_ALTERED`. A count above 1 is `SENTINEL_DUPLICATED`. A count of 0 is `SENTINEL_MISSING`.
  3. **Re-insertion** walks our tree. A block original is legal only as the sole text child (marks `[]`) of a `paragraph` directly under root, blockquote, listItem or container. An inline original is legal inside a text value anywhere inline: split the text and insert a clone of the original with the draft text's marks. Any matched sentinel not re-inserted at a legal position is `SENTINEL_ALTERED`.
  4. **Structure signature,** compared between the source and the restored draft: a preorder list emitting `paragraph`, `heading:<depth>`, `blockquote`, `list:o` or `list:u`, `listItem`, `table`, `tableRow:<cell count>`, `thematicBreak`, `code`, `opaqueBlock:<node>`, `container:<name>`, `inlineCode`, `opaqueInline:<node>`. Text, link, image, break and marks are not emitted. Any difference is `BLOCK_SEQUENCE`. Steps 4 and 5 run **only when steps 2 and 3 recorded no code**: a missing or misplaced sentinel already removes a node from the restored tree, so comparing its structure would add a spurious `BLOCK_SEQUENCE`. This is how the spike caught a model wrapping plain words in backticks.
  5. **`LINK_TARGETS`** (new; spike finding 3; gated with step 4): the sorted multiset of `link.url` and `image.url` differs between the source and the restored draft.
  6. **`PLACEHOLDER`:** the sorted multiset of `/\{[A-Za-z_][A-Za-z0-9_]*\}/g` matches differs between `prepared.markdown` and the draft, each with sentinels removed.
  7. **Re-serialization check:** `markdownToTree(treeToMarkdown(restored), { mode })` throws, which is `PARSE_ERROR`.
  - `detail` is the `" | "`-joined notes, as in the spike. `ok: true` only when no code fired, and the returned root passes `validateTree`.

- [ ] **Step 1: Write the failing tests** in `test/sentinel.test.ts`:
  - `identity translation accepted on every corpus page`: `restoreDraft(p, p.markdown)` returns `{ ok: true }`, and its `root` deep-equals `p.source`. This is the spike's offline control.
  - `numbering and kinds`: on `"Run `a` then:\n\n```sh\nb\n```\n"`, `originals` are `[{index:0,kind:"inline"},{index:1,kind:"block"}]` (match with `toMatchObject`), and `markdown` contains `⟦MOGGING:0⟧` and `⟦MOGGING:1⟧`.
  - `throws on a pre-existing sentinel`: `sentinelize(markdownToTree("text ⟦MOGGING:0⟧"))` throws `ValidationError`.
  - One test per code, each starting from `p = sentinelize(markdownToTree("Use `x` and [docs](https://a.example) for {name}.\n\n```js\nq\n```\n"))` and editing `p.markdown`:
    - `SENTINEL_ALTERED` with `SENTINEL_MISSING`: replace `⟦MOGGING:0⟧` with `⟦MOGGING:0⟦` (the spike's observed failure). The expected `codes` are exactly `["SENTINEL_ALTERED","SENTINEL_MISSING"]`. Every other case in this list expects exactly its one code.
    - `prose word MOGGING is fine`: a source with the text `MOGGING rocks` sentinelizes, and its identity translation is accepted.
    - `SENTINEL_DUPLICATED`: append ` ⟦MOGGING:0⟧` to the first line.
    - `SENTINEL_MISSING`: delete `⟦MOGGING:1⟧`.
    - `SENTINEL_ALTERED` for a block sentinel moved inline: change `\n\n⟦MOGGING:1⟧` to ` ⟦MOGGING:1⟧`.
    - `BLOCK_SEQUENCE`: wrap the word `docs` in backticks.
    - `LINK_TARGETS`: change the URL to `https://de.example`.
    - `PLACEHOLDER`: change `{name}` to `{Name}`.
    - `PARSE_ERROR` on an mdx source with an unclosed JSX tag in the draft.
  - `codes are ordered and unique`: one draft with both a missing sentinel and a placeholder change gives `codes: ["SENTINEL_MISSING","PLACEHOLDER"]`.
  - `translated prose accepted`: replacing `Use` with `Verwende` and `for` with `für` gives `ok: true`. The restored `inlineCode` keeps `source` `` "`x`" ``.
  - `container label and body are translatable`: on `":::tip[Title]\nBody `c`.\n:::\n"`, translating `Title` and `Body` gives `ok: true`. Renaming `tip` to `tipp` gives `BLOCK_SEQUENCE`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** `src/sentinel.ts`. Export the five values and types and update the api list (`REJECTION_ORDER`, `restoreDraft`, `sentinelize` are runtime keys).
- [ ] **Step 4: Run** the package tests and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(markdown): sentinel pass and structural draft validation for the AI pipeline`.

---

### Task 5: Content files (front matter and field mapping; no database)

**Files:**
- Create: `packages/markdown/src/contentFile.ts`, `packages/markdown/test/contentFile.test.ts`

**Interfaces:**
- Consumes: `markdownToTree`, `treeToMarkdown`, `validateTree`; from core, `Collection`, `Field`, `ValidationError`.
- Produces:

```ts
export type ParsedFile = { frontMatter: Record<string, unknown>; body: string };
export function splitFrontMatter(text: string): ParsedFile;
// Maps one file onto a collection. Reference values are NOT resolved here: each one becomes a
// RefPlaceholder and is resolved by import (Task 6), which owns the database.
export type RefPlaceholder = { $ref: string; collection: string };
export type MappedFile = { shared: Record<string, unknown>; localized: Record<string, unknown>; warnings: string[] };
export function mapFile(col: Collection, parsed: ParsedFile, opts: { isSourceLocale: boolean; mode: "md" | "mdx" }): MappedFile;
export function renderFile(col: Collection, data: { shared: Record<string, unknown>; localized: Record<string, unknown> }, opts: { isSourceLocale: boolean; refToText: (id: string, collection: string) => string }): string;
```

- `splitFrontMatter`: normalizes LF and NFC. If the text starts with `---\n`, the front matter runs up to the next line that is exactly `---`. It is parsed with `YAML.parse(fm, { schema: "core", uniqueKeys: true })`. An empty block is `{}`. A non-mapping result, a YAML error or a missing closing `---` throws `ValidationError` (`front matter: <reason>`). The body is the rest after the closing line. Text without a leading `---\n` has no front matter.
- `mapFile` rules (spec 9.4 and 6.2):
  - A key equal to the body field's name is an error: `"<key>: the body field comes from the Markdown body, not front matter"`.
  - The key `slug` is ignored with the warning `slug comes from the file path; front-matter "slug" ignored`.
  - An undeclared key is an error: `"<key>: undeclared field"`.
  - A **shared** key in a non-source file is ignored with the warning `shared field "<key>" is read from the source locale only; ignored`.
  - A value of YAML `null` is treated as absent, so the key is omitted from the output. Empty values (`""`, `[]`, `{}`) are kept.
  - Value conversion, recursive over the field schema: a `richText` string is passed through `markdownToTree(value, { mode })`. A `""` becomes the empty tree `{type:"root",version:1,mode,children:[]}`. A non-string `richText` value goes through `validateTree`. A `reference` string becomes `{ $ref: value, collection: field.collection }`. Every other kind passes through unchanged; core's `normalizeValue` validates it at save time.
  - Body: if `body.trim() === ""`, the body field is **absent**. Otherwise it is `markdownToTree(body, { mode })` under the body field's name. The body field goes to `localized` when it is declared `localized`. When it is shared (core allows a shared body), it goes to `shared` in a source-locale file and is ignored with the shared-field warning above in a target-locale file.
  - `warnings` also gets `"line <n>: \"::: <name>\" (VitePress container syntax) is not supported; use \":::<name>[Title]\""` for every body line matching `/^\s*:::\s+\S/` outside fenced code. v0.1 supports remark-directive syntax only (the first integration, Starlight, uses it).
- `renderFile` is the inverse used by export. Front matter holds the shared fields (source locale only, never `slug`) and the localized fields, except the body. The key order is the collection's field declaration order. Empties are written explicitly (`""`, `[]`, `{}`; an empty richText tree is written as `""`), and absent fields are omitted, so the output never has a bare key. Value conversion is recursive over the field schema, mirroring `mapFile`: inside `list` items and `object` fields too, richText becomes `treeToMarkdown` and a reference becomes `refToText(id, collection)`; any other value is written as is. The block is serialized with `YAML.stringify(obj)` and wrapped in `---\n...---\n`, or omitted entirely when there are no keys. Then comes the body: `treeToMarkdown(body)`, or `""` when it is absent. If the body is the empty tree, it is written as `""` and the warning is the caller's concern.

- [ ] **Step 1: Write the failing tests** in `test/contentFile.test.ts`, using a test-local collection `docs` = { slug, title: text localized, description: text localized, banner: text localized, summary: richText localized, tags: list(text()) localized, author: reference("people"), related: list(reference("docs")), order: number(), body: richText localized body }:
  - `bare key, empty string and missing key`: front matter `banner:` gives no `banner` in `localized`. `banner: ""` gives `banner: ""`. A missing key gives no `banner`. (Review Focus 5)
  - `shared key in a target file is warned and ignored`, `undeclared key is an error`, `body key in front matter is an error`, `slug key warned`.
  - `reference becomes a placeholder`: `author: jane` in a source file gives `shared.author` equal to `{ $ref: "jane", collection: "people" }`.
  - `richText front-matter field becomes a tree`, and `summary: ""` becomes the empty tree.
  - `whitespace-only body is absent`: `"---\ntitle: T\n---\n\n  \n"` gives no `body`.
  - `CRLF front matter`: `"---\r\ntitle: T\r\n---\r\nHi\r\n"` maps `title: "T"` and a body tree with the text `Hi`.
  - `unclosed front matter`, `non-mapping front matter` (`- a`) and `duplicate key` each throw `ValidationError`.
  - `VitePress container warned`: a body containing `"::: tip Hint\nx\n:::\n"` produces the warning above with `line 1`. The same text inside a fenced code block gives no warning.
  - `renderFile then mapFile round trip`: for data with `banner: ""`, `tags: []`, `summary` as the empty tree, `author` as a UUID, `related` as a list of two UUIDs and `refToText` returning `"jane"`, rendering then splitting then mapping gives equal shared and localized data (with `author` and both `related` items as `{ $ref: "jane", ... }`). The rendered text never matches `/^\w+:\s*$/m` (no bare key).
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** `src/contentFile.ts`. These functions are internal: they are **not** exported from `index.ts`, so the api list does not change.
- [ ] **Step 4: Run** the package tests and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(markdown): front-matter parsing and field mapping for content files`.

---

### Task 6: Folder import

**Files:**
- Create: `packages/markdown/src/import.ts`, `packages/markdown/src/slug.ts`, `packages/markdown/test/import.test.ts`, `packages/markdown/test/fixtures.ts`, `packages/markdown/test/db.ts` (a verbatim copy of `packages/core/test/db.ts`)

**Interfaces:**
- Consumes: Task 5 internals; from core: `Ctx`, `createDocument`, `saveDraft`, `publish`, `getDocument`, `normalizeValue`, `hashValue`, `normalizeLocale`, `migrate` (tests), `ValidationError`, `MoggingError`, `LicenceError`.
- Produces (internal, also used by Task 7): `isSafeSlug(slug: string): boolean` in `src/slug.ts`. It is true when the slug is non-empty, splits on `/` into segments that are none of `""`, `.` or `..`, and contains no `\` and no `\0`.
- Produces:

```ts
export type ImportInput = { dir: string; publish?: boolean };
export type FileOutcome = { file: string; docId: string | null; outcome: "created" | "updated" | "unchanged" | "error"; published: boolean };
export type FileMessage = { file: string; message: string };
export type ImportReport = { files: FileOutcome[]; warnings: FileMessage[]; errors: FileMessage[] };
export function importFolder(ctx: Ctx, input: ImportInput): Promise<ImportReport>;
```

`file` is the POSIX path relative to `dir`. The CLI (plan 4) exits non-zero when `errors.length > 0`.

**Algorithm:**
1. **Scan.** If `dir` does not exist or is not a directory, throw `ValidationError("import directory not found: <dir>")` before any write. The layout is `<dir>/<locale>/<collection>/<slug path>.(md|mdx)`. A locale directory is normalized with `normalizeLocale`. One that is undeclared in `ctx.config`, or does not normalize, gets a warning and is skipped. An unknown collection directory gets a warning and is skipped. Dotfiles and dot-directories are ignored silently. Any other file extension gets a warning and is skipped. The slug is the path below the collection directory, without the extension and with `/` separators. If it differs from its lowercase NFC form, the file is an error (`slug path must be lowercase`). If it fails `isSafeSlug` (the same helper export uses, in `src/slug.ts`), the file is an error (`unsafe slug path`). If one slug has both `.md` and `.mdx` in the same locale, both files are errors. `mode` is `mdx` for `.mdx` and `md` otherwise. Processing order is sorted by relative path. Read, `splitFrontMatter` and `mapFile` each file now, and run `normalizeValue` on every value after substituting each `RefPlaceholder`, at any depth, by its `$ref` string (core's `reference` case accepts any string, `normalize.ts:48-50`), so a `list(reference(...))` or an `object` holding a reference is validated without a resolved id. Then **pre-resolve references** with reads only: a `$ref` resolves when it is UUID-shaped and `getDocument(ctx, { collection, docId })` finds a non-deleted document (a dangling or wrong-collection id is an error), names a scanned source file of its collection that passed the checks so far, or names a non-deleted document found with `getDocument` by slug. Any failure here makes the file an `error` that is never written, so pass 1 creates no document for it. A source file that becomes an error this way also fails, in this same step, every reference to it from other files. Repeat until no new error appears. Memoize the `getDocument` slug lookups by `(collection, slug)` for the whole scan, so a repeat iteration issues no new query; pass 2 (a) reuses the same memo for lookups that missed the run map.
2. **Pass 1, identity** (source-locale files, one `ctx.sql.begin` each). Call `getDocument(tctx, { collection, slug })`. If it returns a document with `deletedAt === null`, use its id. Otherwise call `createDocument` and then `saveDraft(tctx, { docId, locale: "shared", data: { slug } })`, and mark the file `created`. Fill the run map `(collection, slug) -> docId`. A file that fails pass 1 is an `error` and is skipped in pass 2; target-locale files of the same slug then find their document through `getDocument` or fail with the pass-2 (b) error. Here `tctx = { ...ctx, sql: tx as unknown as Sql }`; core's internal `sql.begin` then runs as a savepoint (measured; see F7).
3. **Pass 2, content** (all source-locale files first, then target-locale files, each in its own transaction):
   - (a) Resolve every `RefPlaceholder` recursively. A UUID-shaped `$ref` (core's UUID regex) is used as is; the scan already checked it exists in that collection. Otherwise look it up in the run map, then with `getDocument(tctx, { collection, slug })` (not deleted). If both miss, the file is an error: `"<field>: unresolved reference \"<ref>\" in collection <c>"`.
   - (b) A target-locale file needs the document: from the run map, else from `getDocument` by slug. If neither finds it, the file is an error: `no source document for <collection>/<slug>`.
   - (c) For each scope, compute the file data. For the shared scope (source files only) that is `{ slug, ...shared }`; for the locale scope it is `localized`. Normalize each value with `normalizeValue(field, v, key)`. Compare with the heads from `getDocument(tctx, { collection, docId })` using `hashValue`. A scope whose file data is `{}` and that has neither a draft nor a published head is unchanged, so no empty snapshot is written. **Unchanged** means one of three things: the draft head exists and equals the file; there is no draft head and the published head equals the file; or the draft head's `state` is `DRAFT_AI` or `APPROVED` and the published head equals the file. A scope that is not unchanged gets `saveDraft(tctx, { docId, locale, data })`. If that save replaces a `DRAFT_AI` or `APPROVED` draft head, add the warning `replaced pending <state> draft v<version> for <locale>`.
   - (d) When `input.publish` is set, then for each scope whose draft head (re-read after the saves) is `DRAFT_HUMAN` and equals the file data, call `publish(tctx, { docId, locale })`. `FileOutcome.published` is `true` exactly when this run called `publish` for at least one scope of the file; an unchanged file whose heads are already published reports `false`.
   - (e) The outcome is `created` (from pass 1), else `updated` when any scope was saved, else `unchanged`.
   - (f) Any thrown error rolls back the file's transaction and is recorded as `error` with `err.message`, and import continues. A `LicenceError` is the one exception: it is rethrown immediately, because every later write would fail the same way.

- [ ] **Step 1: Write `test/fixtures.ts`.** It holds the `docs` collection from Task 5 plus `people` = { slug, name: text(), body: richText localized body }, a config with locales `{ source: "en", chains: { de: ["en"] } }`, a `ctxFor(sql)`, and `writeTree(root: string, files: Record<string, string>)`, which writes files under a fresh `fs.mkdtempSync(path.join(os.tmpdir(), "mog-"))` directory.
- [ ] **Step 2: Write the failing tests** in `test/import.test.ts`. Each is wrapped in `withTestDb` with `migrate(sql)` first:
  - `first import creates documents, shared and localized drafts`: `en/docs/guide/intro.md` (front matter `title`, `author: jane`, body), `en/people/jane.md`, `de/docs/guide/intro.md`. Expected: 3 file outcomes; `intro` and `jane` `created`; the de file `updated`; `getDocument` by slug `guide/intro` has an en draft whose body is a tree, a de draft, and a shared draft with `author` equal to jane's id. The **forward reference** is real: `en/docs/guide/intro.md` sorts before `en/people/jane.md`, so the referencing file is scanned and written first.
  - `second identical import writes nothing`: run twice. The second report has every outcome `unchanged`, and the max version per scope is unchanged. (Review Focus 4)
  - `an AI draft survives a re-import of the old translation`: after import with `publish: true`, call `recordAiDraft(ctx, { docId, locale: "de", fields: { title: "KI" }, sourceVersion: <en published version from getDocument>, sourceHashes: {}, provenance: [{ fieldPath: "title", modelId: "m", promptVersion: "v1", promptTokens: 1, completionTokens: 1, costMicros: 1 }] })` and expect a `{ version }` result, then re-import the same folder. The de outcome is `unchanged` and the draft head is still `DRAFT_AI`. Then edit the de file's title and import again. The outcome is `updated`, the warning `replaced pending DRAFT_AI draft` appears, and the head is `DRAFT_HUMAN`. (Review Focus 4)
  - `publish publishes human drafts equal to the file`: with `publish: true` the en, de and shared published heads exist and `published: true`. A second `publish: true` run publishes nothing new (no new versions).
  - `a failing file rolls back alone`: one good file plus one whose `order: "x"` fails `normalizeValue`. The good file is `created`. The bad file is `error` and `docId` is null: the scan rejects it, so pass 1 never runs for it and `listDocuments` returns exactly 1 document. `errors[0].file` names it.
  - `unresolved reference is a per-file error`, `a dangling UUID reference is a per-file error` (a random v4 UUID in `author`), `target file without source document is an error` (a pass-2 error: the en file of the same run is still `created`), `undeclared locale directory warned`, `unknown collection warned`, `uppercase slug path is an error`, `slug path with a backslash in a file name is an error`, `md and mdx twins are both errors`, `list of references resolves`: an en file with `related: [guide/intro, other]` where `other` is a later-scanned docs file stores both ids in order; with `related: [missing]` the file is an error naming `related`.
  - `mdx extension parses in mdx mode`: an `.mdx` file with `<Badge />` stores a body tree with `mode: "mdx"`.
- [ ] **Step 3: Run** `DATABASE_URL=postgres://mogging:mogging@127.0.0.1:54329/mogging_test pnpm --filter @mogging/markdown test -- import`. Expected: FAIL.
- [ ] **Step 4: Implement** `src/import.ts`. Export `importFolder` and the four types, and add `importFolder` to the api list.
- [ ] **Step 5: Run** the full package suite and tsc, then the core suite (`pnpm --filter @mogging/core test`) to show core is untouched. Expected: all PASS; core still 197 tests.
- [ ] **Step 6: Commit** `feat(markdown): folder import with two-pass references, unchanged-skip and per-file transactions`.

---

### Task 7: Folder export, package README and spec notes

**Files:**
- Create: `packages/markdown/src/export.ts`, `packages/markdown/test/export.test.ts`, `packages/markdown/README.md`
- Modify: `docs/superpowers/specs/2026-11-11-moggingcms-core-design.md` section 9.4 (append the implementation notes listed in Step 5)

**Interfaces:**
- Consumes: `renderFile` (Task 5); core `listDocuments`, `getDocument`, `Ctx`.
- Produces:

```ts
export type ExportInput = { dir: string; collections?: string[]; locales?: string[] };
export type ExportReport = { files: string[]; warnings: FileMessage[] };
export function exportFolder(ctx: Ctx, input: ExportInput): Promise<ExportReport>;
```

- Behaviour: page through `listDocuments` (deleted documents excluded) for each collection in scope. For each document, read `getDocument`. A document without a published shared head, or without `slug`, gets the warning `no published slug; skipped` and is skipped. A slug that is not a safe relative path gets the warning `unsafe slug "<slug>"; skipped` and is skipped. A safe path has segments split on `/`, none of them empty, `.` or `..`, and contains no `\` and no NUL (`isSafeSlug`, Task 6). Core only lower-cases slugs, so a slug saved through the SDK, such as `../x`, would otherwise write outside `dir`. The resolved path must also start with `path.resolve(dir) + path.sep`. For each locale in scope with a **published** localized head, write `<dir>/<locale>/<collection>/<slug>.<ext>`, where `ext` is `mdx` when the published body tree has `mode: "mdx"` and `md` otherwise. The source-locale file includes the shared fields. When the source locale has no published head but the shared head is published, a source file is still written, with the shared fields and no body. `refToText` is synchronous, so before rendering a document collect every reference id in its published data and resolve each id not yet cached with one `getDocument` (any collection, in scope or not), keeping an `id -> slug | null` cache for the whole export; `refToText(id, c)` then returns the cached published shared slug, else the id. A richText value that is a string (saved through the SDK, not through import) is written as is. A non-string richText value that fails `validateTree` gets the warning `<field>: not a v1 tree; omitted` and is omitted. Parent directories are created and existing files are overwritten; stale files are never deleted. The output is sorted.

- [ ] **Step 1: Write the failing tests** in `test/export.test.ts` (`withTestDb`):
  - `exports published heads only`: import with `publish: true`, then add a `DRAFT_HUMAN` en edit through `saveDraft`. Export writes the **published** title, not the draft one.
  - `export then import is unchanged`: import with `publish: true`, export to a fresh directory, then import that directory. Every outcome is `unchanged`. (This is the round-trip contract of spec 9.4.)
  - `suppression survives the round trip`: an en document saved and published with `banner: ""` and `tags: []` is exported. The file contains `banner: ""` and `tags: []`, and re-import leaves the data equal. (Review Focus 5)
  - `unsafe slug is skipped`: a document saved through `saveDraft` with the shared slug `../escape` and published is skipped with the warning, and no file appears outside `dir`.
  - `references exported as slugs`, `mdx body exported with .mdx extension`, `document without published shared head is warned and skipped`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** `src/export.ts`. Export `exportFolder` and its two types, and add `exportFolder` to the api list. The final api list is `["MARK_ORDER", "REJECTION_ORDER", "exportFolder", "importFolder", "markdownToTree", "restoreDraft", "sentinelize", "treeToMarkdown", "validateTree"]`.
- [ ] **Step 4: Write `packages/markdown/README.md`.** It covers the licence line (same wording as core's README) and the import layout. It lists the supported syntax and what is opaque, with the VitePress `::: tip` limitation and the fix (`:::tip[Title]`). It states the byte-for-byte rule relative to LF/NFC-normalized input, and the known limits: reference-style links and definitions are opaque, so their link text is not translated; a suppressed (empty-tree) **body** exports as an empty body and re-imports as absent; concurrent imports of the same new slug can create two documents (there is no unique slug index in core); export never deletes stale files; renaming a page between `.md` and `.mdx` changes its tree `mode`, so its hash changes and its translations show as stale.
- [ ] **Step 5: Spec notes:** append to spec 9.4 a short paragraph "Implementation notes (plan 2)". It states: slugs may contain `/` (nested folders) and must be lowercase; `.md` and `.mdx` are both accepted and the extension sets the parse mode; undeclared front-matter keys are a per-file error; references in front matter are a slug or a UUID; a whitespace-only body means absent; an unchanged file is skipped, as approved in F5. **Do not** change any other section.
- [ ] **Step 6: Run** the full suites: `pnpm --filter @mogging/markdown test`, `pnpm --filter @mogging/core test`, then `pnpm typecheck`. Expected: all PASS, tsc clean.
- [ ] **Step 7: Commit** `feat(markdown): folder export of published heads; README and spec 9.4 notes`.

---

## Self-review (done at authoring time)

- **Spec coverage:**
  - 6.5 tree: Task 1. Converters: Tasks 2 and 3. Opaque byte-for-byte: Tasks 2 and 3. Sentinel and structural validation: Task 4.
  - 6.2 null and empty in files: Tasks 5 and 7.
  - 6.4 normalization and hashing: reused from core in Task 6.
  - 9.4 layout, identity, shared-from-source, re-import as new `DRAFT_HUMAN` (amended by F5), `--publish`, and the export empties rule: Tasks 6 and 7.
  - 10 admonition question: F2, Task 2.
  - Deferred to plan 3 by design: calling the model, 8.4 glossary and do-not-translate checks, and per-field placeholder parity for non-rich-text fields.
  - Deferred to plan 4: the CLI exit code and the `mogging import`/`export` argument parsing.
- **Citations verified at `6c7c5ef`:**
  - core exports: `packages/core/src/index.ts`
  - richText NFC: `values/normalize.ts:11,34-39`
  - empty tree rule: `values/normalize.ts:98-105`, where an object with `children: []` is empty, which the empty root satisfies
  - body rule: `schema/config.ts:34-45`
  - `saveDraft` carry-forward: `documents/saveDraft.ts:87-108`
  - `getDocument({slug})`: `read/resolve.ts:147-195`
  - `withTestDb`: `packages/core/test/db.ts`
  - spike functions: `spikes/rich-text-sentinel/run.ts:62-71,111-139,178-288`
  - postgres savepoint nesting: `node_modules/.pnpm/postgres@4.1.0/node_modules/postgres/types/index.d.ts:926`, measured by a removed probe test
- **Type consistency:** `RichTextRoot`, `SentinelPrepared`, `RestoreResult` and `RejectionCode` are defined once (Tasks 1 and 4). `FileMessage` is defined in Task 6 and reused in Task 7.
