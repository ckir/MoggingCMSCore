import { describe, expect, it } from "vitest";
import { withTestDb } from "../db.js";
import { migrate } from "@mogging/core";
import { capturingSql, ctxFor } from "./fixtures.js";
import { runScenario } from "./endState.js";
import { transactionsOf } from "./statementKinds.js";
import type { TxKind } from "./statementKinds.js";

/**
 * Exact statement count per transaction kind (`begin` and `commit` included), pinned on the write-run code. The
 * unchanged code ran 39, 19, 20, 10, 11 and 11 (the baseline of Task 2).
 */
const EXPECTED: Record<TxKind, number> = {
  source: 25,
  "locale-dayone-save-publish": 12,
  "locale-tracked-save-publish": 13,
  "locale-dayone-save-only": 7,
  "locale-tracked-save-only": 8,
  "locale-publish-only": 8,
};

/** The scenario runs three imports (phases A, B and C). */
const IMPORTS = 3;

describe("statement counts per transaction kind", () => {
  it("pins the statements of every write transaction of the scenario", async () => {
    await withTestDb(async (sql) => {
      await migrate(sql);
      const cap = await capturingSql(sql);
      try {
        await runScenario(sql, ctxFor(cap.sql), {});
        const raw = cap.statements();
        const txs = transactionsOf(raw);
        const measured: Record<string, { transactions: number; counts: number[] }> = {};
        for (const t of txs) {
          const m = (measured[t.kind] ??= { transactions: 0, counts: [] });
          m.transactions++;
          m.counts.push(t.statements.length);
        }
        for (const kind of Object.keys(EXPECTED) as TxKind[]) {
          const m = measured[kind];
          expect(m?.transactions ?? 0, `${kind}: transactions in the scenario`).toBeGreaterThanOrEqual(1);
          for (const n of m!.counts) expect(n, `${kind}: statements per transaction`).toBe(EXPECTED[kind]);
        }
        expect(Object.keys(measured).sort()).toEqual(Object.keys(EXPECTED).sort());
        for (const t of txs) {
          expect(t.statements.some((x) => /savepoint/i.test(x)), `${t.kind}: no savepoint`).toBe(false);
        }
        // Counted over the raw log: the licence read happens before `begin`, outside every transaction. One per import.
        const licenceReads = raw.filter((x) => /from migrations/i.test(x)).length;
        expect(licenceReads, "one licence read per import: phases A, B and C all write").toBe(IMPORTS);
      } finally {
        await cap.sql.end();
      }
    });
  });
});
