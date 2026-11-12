# AGY-TEST-AUDIT ledger

One row per completed audit: `date | range | rounds | verdict | evidence`. Newest row at the BOTTOM.
Every `|` inside a cell must be escaped as `\|`. This is a record, not a proof.

| date | range | rounds | verdict | evidence |
|---|---|---|---|---|
| 2026-11-11 | 987c32f..bcd56ef | 1 | GAPS FOUND (8 raised, all closed: 7 real FOLDED, G2 mostly REJECTED with its one real part FOLDED) | brief .clavity/seams/plan1-test-audit.md; fold commit bcd56ef; new tests mutant-verified (hash digest, nested non-finite guard, locale regex x2, body-kind guard, release deleted-doc guard, approveClean catch, resolve ordering) |
| 2026-11-11 | b6e03a9..e38a801 | 1 | GAPS FOUND (3 raised, all FOLDED, plus the unpublished_by-on-publishRelease gap named in its prose) | brief .clavity/seams/prezero-test-audit.md; fold commit e38a801; four new tests mutant-verified (explicit-version draft flip, copy created_by, release unpublished_by, copy version allocation) |
| 2026-11-12 | 8f8bd97..d199d20 | 1 | GAPS FOUND (5 raised: 4 in json + 1 in prose, all verified and FOLDED) | brief .clavity/seams/plan2-test-audit.md; fold commit d199d20; six logic mutants each turned exactly the new test red (table align, container attrs, APPROVED unchanged, APPROVED warning, symlink follow, delete mark) |
| 2026-11-12 | 2193e9c..bdc1a6a | 1 | GAPS FOUND (3 raised, all verified by a surviving logic mutant, all closed: 3 FOLDED as tests only; agy below-floor notes: provenance.ts:56 non-UUID guard, prompt.ts:56 surrogate-pair guard; known test debt from the plan 3 review ledger was inlined as do-not-re-raise and goes to the owner as tracked debt) | brief .clavity/seams/plan3-test-audit.md; fold commit bdc1a6a (tests only, source unchanged since 18c1a63 so the capstone GREEN stands) |
