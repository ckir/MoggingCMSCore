# Rich-text sentinel spike: results (run 2026-11-11)

Spike code: `spikes/rich-text-sentinel/` (run.ts, README.md with corpus provenance). Raw per-run JSON (including every draft) is in the gitignored `out/`.

## Decision

**Keep the sentinel mechanism with one Markdown string per field for plan 3.** The strong model (`anthropic/claude-sonnet-5.5`) was rejected on 0 of 20 pages in each of 2 runs (0 of 40 page-translations, 0 percent), below the spec's 10 percent threshold, so the per-block structured-items fallback is not triggered.
Caveats the decision rests on: n = 40 page-translations from one corpus family (Vite and VitePress docs, English to German); 0/40 bounds the true rate at roughly 7 percent at 95 percent confidence, so it is "no evidence of a problem above 10 percent" rather than proof. The cheap model was rejected on 10 percent of pages in each run (2/20, 2/20), exactly at, not above, the threshold, so plan 3 must keep the validate-then-reject step and treat rejection as a normal outcome.

## Setup

- Models chosen at run time from the OpenRouter catalogue (GET /api/v1/models): cheap `openai/gpt-4o-mini` ($0.15 / $0.60 per Mtok in/out), strong `anthropic/claude-sonnet-5.5` (newest `anthropic/claude-sonnet-N`, $2 / $10 per Mtok).
- `ai@7.0.154` `generateObject` (deprecated in ai 7 in favour of generateText with an output setting; still works) with `@openrouter/ai-sdk-provider@3.1.0`, zod schema `{ markdown: string }`, default temperature, 2 SDK retries, up to 12000 output tokens. Pages sent 4 at a time.
- 20 corpus pages (about 113 KB), 2 runs per model, 80 calls, 0 API errors.
- Validation: parse draft (mdast + gfm + block directives + mdx, same mode as the source), sentinel scan on the raw string (missing / duplicated / altered or invented), re-insertion of originals at legal positions, block type sequence compare (including table rows, list ordering and opaque node markers), `{placeholder}` multiset compare, re-serialise and re-parse. Primary code precedence: PARSE_ERROR, SENTINEL_ALTERED, SENTINEL_DUPLICATED, SENTINEL_MISSING, BLOCK_SEQUENCE, PLACEHOLDER (all reasons are kept in the JSON). Link targets are compared as information only (not a rejection reason).
- Offline control: with the sentinel Markdown returned unchanged ("identity translation"), 20 of 20 pages are ACCEPTED, so rejections below come from the models, not from the validator.
- Every accepted draft was German (checked by stopword scan on all 80 drafts).

## Rejection rate per model per run

| model | run | accepted | rejected | rate | failure codes | cost (USD) |
|---|---|---|---|---|---|---|
| openai/gpt-4o-mini | 1 | 18 | 2 | 10% | SENTINEL_ALTERED 1, BLOCK_SEQUENCE 1 | 0.0179 |
| openai/gpt-4o-mini | 2 | 18 | 2 | 10% | BLOCK_SEQUENCE 2 | 0.0176 |
| anthropic/claude-sonnet-5.5 | 1 | 20 | 0 | 0% | none | 0.5338 |
| anthropic/claude-sonnet-5.5 | 2 | 20 | 0 | 0% | none | 0.5351 |

Tokens per run: cheap 25,692 in / about 25,500 out; strong 41,375 in / about 45,100 out (Claude tokenises more tokens for the same text).

## Failure kinds, one example each (all from the cheap model)

- **SENTINEL_ALTERED**: `05-asset-handling.md`, run 1: closing bracket changed, `⟦MOGGING:12⟦` (sentinel 12 therefore also counted missing; the draft also lost one block-sequence node).
- **BLOCK_SEQUENCE**: `15-runtime-api.md`, runs 1 and 2 (same page both times): the model wrapped plain words in backticks (`beforeMount`, `mounted` in the last paragraph), creating inline code spans that were not in the source (draft 75 structural markers vs 73). All sentinels intact. Also `01-getting-started.md`, run 2: draft has 2 more structural nodes than the source (74 vs 76) with all 26 sentinels present exactly once, i.e. the model restructured blocks without touching a sentinel.
- Not observed in any run: SENTINEL_MISSING as a primary code, SENTINEL_DUPLICATED, PLACEHOLDER, PARSE_ERROR (the cheap model run-1 draft for page 05 also had a secondary missing sentinel). Structured output was always valid. Placeholders such as `{name}` survived on all 80 calls.
- Observation for plan 3: gpt-4o-mini failures are mostly structural drift, not sentinel damage, so the sentinels themselves held in 79 of 80 translations, but models do add formatting (inline code) of their own.

## Opaque blocks that contain prose (spec section 10 question)

Counted by the parser on every page (identical across runs): **12 of 20 pages** (01, 02, 03, 04, 05, 06, 09, 10, 11, 12, 16, 20) contain at least one opaque block with translatable prose, 38 such blocks out of 633 opaque nodes in the corpus. Heuristic: an opaque node counts as prose if its non-code text has at least 3 words of 2 or more letters. All 38 are `:::note`-style admonition bodies or raw HTML / JSX with text; they are copied through untranslated by design. All 11 admonition pages are among the 12. So untranslated prose is common in admonition-heavy docs (about 60 percent of this corpus's pages), which supports parsing admonition bodies in v0.1 or at least flagging such drafts as partially translated. The heuristic is rough (it can count a note of mostly code-adjacent words); it was not hand-audited.

## Cost

Final dataset (4 runs, 80 calls): **USD 1.1045**. Total spent on the OpenRouter account for the spike including a 1-page dry run (0.03) and one earlier full pass over the same 80 calls that I discarded and re-ran after adding the missing inline-code sentence to page 20 (1.10): about USD 2.24. The 1-page dry run projected about USD 1.2 for the full run (strong model $0.0286 per 6 KB page), actual 1.10.

## Other findings

1. **The pinned sentinel collides with remark-directive text directives.** `:3` inside `⟦MOGGING:3⟧` is parsed as a text directive and splits the sentinel; all 20 identity round-trips failed until text directives were switched off (only container/leaf directives, needed for `:::note`, are enabled). Plan 3 must parse drafts with text directives disabled (or choose a sentinel without a colon, which would change the spec's format).
2. 4 of 20 corpus pages (01, 09, 11, 20) are not valid MDX (bare HTML) and needed a non-MDX parse; real docs sets will mix both modes, so the importer needs the same fallback.
3. Link targets: informational compare matched on every final-run page (an earlier discarded pass showed the cheap model rewriting a Wikipedia URL to the de.wikipedia host and dropping two links on page 01, so link-target checking is worth keeping as a rejection reason).
4. `generateObject` is deprecated in ai 7; plan 3 should use `generateText` with the output setting.
