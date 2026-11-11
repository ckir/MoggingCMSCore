# AGY-TEST-AUDIT ledger

One row per completed audit: `date | range | rounds | verdict | evidence`. Newest row at the BOTTOM.
Every `|` inside a cell must be escaped as `\|`. This is a record, not a proof.

| date | range | rounds | verdict | evidence |
|---|---|---|---|---|
| 2026-11-11 | 987c32f..bcd56ef | 1 | GAPS FOUND (8 raised, all closed: 7 real FOLDED, G2 mostly REJECTED with its one real part FOLDED) | brief .clavity/seams/plan1-test-audit.md; fold commit bcd56ef; new tests mutant-verified (hash digest, nested non-finite guard, locale regex x2, body-kind guard, release deleted-doc guard, approveClean catch, resolve ordering) |
| 2026-11-11 | b6e03a9..e38a801 | 1 | GAPS FOUND (3 raised, all FOLDED, plus the unpublished_by-on-publishRelease gap named in its prose) | brief .clavity/seams/prezero-test-audit.md; fold commit e38a801; four new tests mutant-verified (explicit-version draft flip, copy created_by, release unpublished_by, copy version allocation) |
