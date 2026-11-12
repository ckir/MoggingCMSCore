# AGY-CAPSTONE ledger

One row per completed capstone: `date | range | rounds | verdict | evidence`. Newest row at the BOTTOM.
Every `|` inside a cell must be escaped as `\|`. This is a record, not a proof.

| date | range | rounds | verdict | evidence |
|---|---|---|---|---|
| 2026-11-11 | 987c32f..45828ed | 2 | GREEN (owner-confirmed) | seams .clavity/seams/plan1-capstone.md and plan1-capstone-r2.md; fold commits 3ef0d22, 7a842aa, 45828ed |
| 2026-11-11 | b6e03a9..ed01932 | 1 | GREEN (owner-confirmed; 2 low by-design findings REJECTED, staleness-after-republish claim re-measured by the driver) | seam .clavity/seams/prezero-capstone-r1.md; no fold commits needed |
| 2026-11-12 | 8f8bd97..a5a8e84 | 2 | GREEN (owner-confirmed; r1 3 verified folds, r1 peer breach of ignored node_modules restored and owner-ruled; r2 clean under stricter brief + 18 driver probes) | seams .clavity/seams/plan2-capstone-r1.md and plan2-capstone-r2.md; fold commits fbc9440, a5a8e84 |
