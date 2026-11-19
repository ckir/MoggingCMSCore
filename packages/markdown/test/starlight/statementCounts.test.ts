import { describe, expect, it } from "vitest";
import { withTestDb } from "../db.js";
import { migrate } from "@mogging/core";
import { capturingSql, ctxFor } from "./fixtures.js";
import { runScenario } from "./endState.js";
import { transactionsOf } from "./statementKinds.js";
import type { TxKind } from "./statementKinds.js";

/** Exact statement count per transaction kind (`begin` and `commit` included), pinned on the unchanged code. */
const EXPECTED: Record<TxKind, number> = {
  source: 39,
  "locale-dayone-save-publish": 19,
  "locale-tracked-save-publish": 20,
  "locale-dayone-save-only": 10,
  "locale-tracked-save-only": 11,
  "locale-publish-only": 11,
};

describe("statement counts per transaction kind", () => {
  it("pins the statements of every write transaction of the scenario", async () => {
    await withTestDb(async (sql) => {
      await migrate(sql);
      const cap = await capturingSql(sql);
      try {
        await runScenario(sql, ctxFor(cap.sql), {});
        const txs = transactionsOf(cap.statements());
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
      } finally {
        await cap.sql.end();
      }
    });
  });
});
