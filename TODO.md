# Open items

Tracked debt promoted from local anomaly captures (see the clavity open-issues skill). One line per item; tick or delete when shipped.

- [ ] `@mogging/core` `normalizeValue` accepts a `text`, `slug` or nested `richText` string containing U+0000, but Postgres `jsonb` rejects `\u0000`, so `saveDraft` fails at the database instead of with a `ValidationError`. Reject U+0000 in `packages/core/src/values/normalize.ts` (`normalizeAt` and `nfcDeep`) with a `ValidationError`, and update the markdown import test that relies on it to force a pass-2 failure. Captured 2026-11-12 during plan 2 Task 6.
