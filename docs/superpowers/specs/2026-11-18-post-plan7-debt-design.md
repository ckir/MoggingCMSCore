# Post-plan-7 debt: three engine contracts (design, short)

Status: DRAFT for owner approval, 2026-11-18. Base: main `e056fb9`. Size: a small change across three packages (core,
cli, docs). No DDL: `0001_engine.sql` is not touched, so the freeze (ship step 3) does not depend on this work.

## Intent

Close three items from `TODO.md` that concern engine behaviour, with the owner's rulings of 2026-11-18, after an
agy-first consult (`.clavity/seams/plan8-forks-first.md`, reply `.clavity/scratch/plan8-forks/notes.md`).

Goals: every item has one defined behaviour, a test that pins it, and no doc sentence that contradicts it.
Non-goals: DDL; changing what `@mogging/ai` sends to a model (F4 stands: non-translatable fields are never copied or
translated); the migration lock (`migrate.ts:24`, taken before the tables exist); AI cost handling.
Anti-goal: any path that silently writes a source-locale value into another locale (a localized price copied from the
source is wrong without anyone noticing).

## Item A: a required localized field the AI cannot draft (owner ruled: the review lists it, the edit file fills it)

Today: `packages/ai/src/jobs.ts:156` skips every field that is not `isTranslatable` (`packages/ai/src/fields.ts:26`);
plan 7's required-on-publish check (`packages/core/src/documents/publishCore.ts:83-90`) then refuses the head;
`packages/core/src/read/review.ts:164` builds `DraftReview.fields` from the draft's own data keys, so an absent field
cannot appear in the review or in an edit file (`packages/cli/src/editFile.ts:13`, editable = text and richText only).
Core `approve` already accepts an edit for any declared localized field absent from the draft (`approve.ts:56-60`,
normalized by `normalizeValue`), but it writes provenance only for rows the AI version already has
(`approve.ts:151-165`), so a field the reviewer supplies would leave no trace (not `edited` in the review, not in
`mogging provenance`). So `approve` changes in one way (A5 below).

Contract:
1. Core: `DraftReview` gains `missing: ReviewMissing[]`, `ReviewMissing = { path: string; source: unknown }`: every
   top-level `required` localized field of the collection that the draft's `data` has no key for (stored data never
   holds a top-level null, so "no key" is the plan 7 presence test), in `Object.keys` sorted order like `fields`;
   `source` is the source head's value, or `undefined` when the source has none. Computed for every draft state and
   every locale `review` accepts, the source locale included (`review.ts:126`; publish requires the field there too);
   only a DRAFT_AI head can be approved, so only it can be filled through `review approve`.
2. CLI: `review show` prints the list (path, source value, "required, not drafted"); the edit file (text and JSON
   forms) accepts a section or key for each missing path and for the existing editable ones; a value for a field
   of kind other than text or richText is a JSON value that core's `normalizeValue` validates. Any other key stays
   "not an editable field of this draft" (so a PRESENT list or object field stays non-editable: out of scope). A
   missing section the reviewer leaves untouched is a no-op: it is never prefilled with the source value (anti-goal).
   `review show --json` gains the additive key `missing`. `review approve` does NOT refuse while `missing` is
   non-empty (plan 7: drafts may be incomplete); it prints a notice listing the paths, because `publish` will refuse.
   In the text form an empty section for a missing field is a no-op (indistinguishable from untouched), so supplying
   an empty string, `0` or `false` needs the JSON form (`"field": ""`). Exact file syntax: resolved in the plan.
   The plan must change every site that assumes a path is in `review.fields`: `edited()` (`editFile.ts:40`,
   `find(...)!` would throw on a missing path), `fieldNames`, `applyEdits`, the edit-file renderer, and the
   string-only check of `parseJsonEditFile` (`editFile.ts:97`).
3. Core `publish` / `publishRelease` error (`publishCore.ts:90`) names the remedy: the AI does not draft a field it
   cannot translate; supply it with `mogging review approve --edit-file` or `saveDraft`.
3a. (A5) Core `approve` inserts one provenance row for each edited key that has no AI row in the approved version:
   `field_path` = the key, `model_id` `'human:approve'`, `edited` true, zero tokens and cost, and the same
   approver, acknowledgements and `bulk_id` columns as the AI rows. The `human:` prefix keeps `review.ts:150` from
   mistaking it for an AI call, and `review.ts:162` then marks the field edited.
4. Docs: `CONTENT_ARCHITECTURE.md` (review, edit files, required-on-publish), the CLI README, spec F4 note
   (`core-design.md:635`) gains "a required one is supplied by the reviewer".

## Item B: rejecting an AI draft that superseded an APPROVED draft (owner ruled: base on the newest non-AI row)

Today (`recordAiDraft.ts:89-91`): base = `order by is_head_draft desc, is_head_published desc, version desc`. After
`rejectDraft`, the APPROVED row it superseded is a non-head row; a published locale restarts from the published head,
a never-published locale from the approved row.
Contract: `order by is_head_draft desc, version desc` over the same candidate rows (`is_head_draft or state <>
'DRAFT_AI'`), in BOTH places that carry the query: `recordAiDraft.ts:89-91` and `saveDraft.ts:121-124` (a human
save in a target locale carries fields forward from the same base, and the two must not diverge). Measured by enumerating every writer that clears `is_head_draft` (`rejectDraft`, `approve`,
`recordAiDraft`, `saveDraft`, the publish flip): the only non-AI row newer than the published head that is not itself
a head is an APPROVED draft superseded and then rejected, so every other case picks the same row as today. A rejected
AI row is still never a base. The next draft's provenance `superseded_version` stays null (the approved row was not
a head when the new draft was built, `recordAiDraft.ts` `superseded`), so the review's `previous` falls back to the
published value as it does today. Docs: `CONTENT_ARCHITECTURE.md` 3.4 (reject leaves the pair stale; the next draft starts
from the superseded approved draft when one exists, spec 8.1) and design 6.3 wording.

## Item C: the slug advisory lock (plain fix, no fork)

Today (`slugGuard.ts:17`): key `hashtext('mogging_slug:' || name)` is shared by every schema of a database, and the
lock is taken for collections with no `slug` field (`saveDraft.ts:98`, `publishCore.ts:98`, `releases.ts:215`).
Contract: key = `hashtext('mogging_slug:' || 'documents'::regclass::oid::text || ':' || name)`, so the lock is scoped
to one set of engine tables; `lockSlugs(tx, ctx, collections)` (it takes `ctx` for the config; internal, not
exported from `index.ts`, three callers: `saveDraft.ts:98`, `publishCore.ts:98`, `releases.ts:215`) skips a collection whose config has no `slug` field, and one the config does
not declare (as `assertSlugFree` does). Engines on the old and the new key do not exclude each other: a non-goal while
v0.1 is unreleased. `current_schema()` is
NOT used: measured on 2026-11-18, `search_path` `a,b` and `b` share `b.documents` but gave different keys
(`1714723868` vs `-1792751507`), and an unresolvable path gives NULL, for which `pg_advisory_xact_lock` took 0 locks;
the table oid gave one key (`-1988387175`) for both.

## Approaches considered

A: copy source value into the draft (rejected: the anti-goal); refuse `required` on such a field in `defineConfig`
(rejected: translatability exists only in `@mogging/ai`, core cannot know it); document only (rejected as the sole
fix); review lists the gap and the edit file fills it (CHOSEN, owner). agy proposed widening the edit file's kinds
alone; measured insufficient (review.ts:164). B: document as intended; re-head the approved row (compile-reject loop
risk); base rule (CHOSEN, owner and agy). C: `current_schema()` (rejected by measurement); table oid (CHOSEN).

## Left to the plan

Edit-file syntax for non-text values; the exact `review show` layout; test names and their oracles (C: `pg_locks`
objid for the new key as in `slugGuard.test.ts:235-254`; B: a published locale and a never-published locale each
reject-then-recompile; A: a `required` number field end to end, create draft, review, edit, publish); the
`packages/core/test/api.test.ts` pin if `ReviewMissing` is exported; TODO.md items ticked.

## Self-audit (done before handoff)

Contracts and field names: A1 to A4, B, C defined; defaults: `missing` is `[]` when nothing is missing, never absent.
Placeholders: none; the items under "Left to the plan" are named and resolved in the plan. Edge cases: a required field
in a source-locale draft (listed; only DRAFT_AI heads can be approved); a field whose source value is absent
(`source: undefined`); a draft head that is not DRAFT_AI (listed, not fillable through `review approve`); soft-deleted
documents (review already refuses); a missing text field that the AI rejected or skipped (listed, same rule); an
empty-string supply (JSON form only). Every requirement above maps to one section.

## Stand-downs

None. Panel round 1 findings (five from agy, six from the driver's own seats) were all folded above.
