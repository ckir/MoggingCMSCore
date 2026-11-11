# AGY-CAPSTONE ledger

One row per completed capstone: `date | range | rounds | verdict | evidence`. Newest row at the BOTTOM.
Every `|` inside a cell must be escaped as `\|`. This is a record, not a proof.

| date | range | rounds | verdict | evidence |
|---|---|---|---|---|
| 2026-11-11 | 987c32f..45828ed | 2 | GREEN (owner-confirmed) | seams .clavity/seams/plan1-capstone.md and plan1-capstone-r2.md; fold commits 3ef0d22, 7a842aa, 45828ed |
| 2026-11-11 | b6e03a9..ed01932 | 1 | GREEN (owner-confirmed; 2 low by-design findings REJECTED, staleness-after-republish claim re-measured by the driver) | seam .clavity/seams/prezero-capstone-r1.md; no fold commits needed |
