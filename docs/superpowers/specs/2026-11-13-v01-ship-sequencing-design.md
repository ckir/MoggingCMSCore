# v0.1 ship sequencing: the open TODO.md items versus the remaining ship path

Date: 2026-11-13. Status: DRAFT, awaiting owner approval. Size: a small change (a sequencing decision, no new
feature). Companion to the roadmap (section 5, v0.1) and TODO.md.

## Intent and why

Engine plans 1 to 4 are merged and pushed (origin/main == main at c34541f). What stands between the repository
and the first paying unknown adopter (the success criterion, core design section 2) is the ship path plus the
open TODO.md items. This note fixes the ORDER, so that the first publish does not lock in a cheap-now,
costly-later defect and so that the only measurement that matters (do people pay) starts as soon as is safe.

## Goals, non-goals, anti-goals

- Goal: a paying adopter meets an engine that neither corrupts nor strands their content, and nothing that is
  free to change today becomes an SDK or schema break after first publish.
- Non-goal: clearing all of TODO.md before launch; the CLI polish, test debt and the v0.2 items stay deferred.
- Anti-goal: letting "hardening" absorb the whole backlog and delay launch; the pre-ship tranche is closed to
  new entries unless an item meets the rule under Constraints.

## Constraints

- Nothing is pushed or published without the owner's explicit word.
- Migration 0001 may still be edited in place until it is frozen (dev-setup.md); after the freeze, schema
  changes need migration 0002.
- Admission rule for the pre-ship tranche: an item is in only if it (a) corrupts or loses content, (b) changes
  the public SDK surface or the migration, (c) a buyer would hit it in the first hour with no workaround, or
  (d) fixing it later would change an error or behaviour contract adopters will depend on (a thrown error
  class, an accepted input). Everything else is v0.1.x or v0.2. Adding an item to the tranche needs the
  owner's ruling, not the implementer's reading of the rule.
- Owner exception: `release remove` meets none of (a) to (d) strictly (it is additive and a stuck release has
  a new-name workaround); it is in the tranche because the owner chose so on 2026-11-13.

## Approaches considered

- A. Clear the debt first. Safest engine; delays the measurement; spends effort on items the roadmap already
  defers. Not chosen.
- B. Ship path first, all debt after launch. Fastest; the listProvenance cursor becomes an SDK break and
  rejected-draft text can leak into a buyer's drafts. Not chosen.
- C. Small pre-ship hardening tranche, then the ship path, then the rest. Chosen as the base.
- D (agy's addition, adopted). C, with the starter template and integration package built BEFORE the migration
  freeze, because a real consumer can still surface a schema or SDK change while 0001 is editable.
Chosen by the owner on 2026-11-13: D. agy-first consult: seam .clavity/seams/todo-sequencing-first.md, reply
.clavity/scratch/todo-sequencing/notes.md, [VERDICT: ALIGNED] after verification (agy's "bricking" and
"irreversible publish" wording discounted: a stuck release has a new-name workaround, a bad npm version has a
patch release).

## The order

1. Pre-ship hardening (to be written as plan 5, against code that exists now):
   - `normalizeValue` rejects U+0000 with a `ValidationError` (normalize.ts, `nfcDeep` has no check today).
   - Rejected-draft text must not resurface in the next AI draft for a never-published locale
     (recordAiDraft.ts base selection).
   - `runWorker` validates `pollMs` with a `ValidationError` (worker.ts).
   - `listProvenance`: make cursor and ordering agree (provenance.ts:60-64 pages by `id > afterId` but orders by
     `created_at, id`); the cursor shape is public, so this lands before publish. The fix (order by id, or a
     composite cursor) is a plan-5 decision.
   - `listDraftHeads`: document the `after` cursor as opaque.
   - `release remove`: SDK function plus CLI verb, no schema change (owner chose pre-ship on 2026-11-13).
2. Starlight-class drop-in integration package and the cloneable starter template (roadmap section 5). Spec
   only for now; the line-level plan waits until the code it builds on exists.
3. Freeze migration 0001 (no more in-place edits). Fold in any schema or SDK change the starter surfaced.
   Freeze trigger (my proposal, the owner may change it): the starter template builds and its acceptance flow
   passes against the SDK without a schema change, and no schema item is open. If step 2 turns up a change
   that is larger than a TODO-class fix, stop and bring it to the owner instead of extending step 2.
4. Self-serve checkout and key delivery, v0.1 operations (key re-issue, refund policy, support address,
   evaluation/purchase/CI docs, enterprise contact form), owner-written gate numbers (roadmap section 10), then
   the `prepack` build gate (today `prepack` only runs `copy-licence.mjs`, it never builds; `pnpm smoke:pack`
   does build and pack, so only a bare `pnpm pack` or `publish` can ship a stale `dist`) and publish. Before
   publish the owner confirms the `@mogging` npm scope is registered to them: `npm view @mogging/core` returns
   404 today, which shows nothing is published, not who owns the scope.
5. After launch, v0.1.x: the Plan 4 follow-up bullets (CLI polish, exit codes, helper moves), the plan 3 test
   debt and minor findings, the `withTestDb` stale-schema sweep, `approve` `expectedSourceVersion`.
6. v0.2 and owner decisions: `status --check` (needs the owner's failing-states ruling), the review web page,
   actor identity beyond attribution, abort-spend reconciliation and streaming.

## Review ledger

Solo panel round 1 (2026-11-13, persona relentless-adversarial-auditor; seats Axiom Breaker, Cascade Analyst,
Literal Implementer, Mechanism Gamer, Blindspot Auditor; dropped: State Corruptor, Boundary Smuggler, Resource
Vampire, Protocol Pedant, Dependency Cynic, Activation Auditor, none of whose triggers this note meets), all
FOLDED:
- The admission rule contradicted the tranche (release remove and U+0000 met none of a to c): added criterion
  (d) and an explicit owner exception for `release remove`.
- The rule was gameable by the implementer: additions now need an owner ruling.
- The freeze of migration 0001 had no trigger and step 2 had no exit: freeze trigger and an escalate-instead-of-
  extend rule added to step 3.
- `prepack` wording overstated: `smoke:pack` already builds; and the npm scope ownership is unconfirmed.
Round 2 with the agy escalation: WAIVED by the owner on 2026-11-13 (the ordering itself had an agy-first consult,
verdict ALIGNED; this note adds no code or new design). The panel is therefore the solo floor only, one round.

## Stand-downs

None. No finding was discarded below the floor.

## Left to the builder

The `listProvenance` cursor shape; the exact `release remove` semantics (what happens to a release that becomes
empty); the order inside step 1; how the starter template is structured.
