import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { migrate } from "@mogging/core";
import { withTestDb } from "../db.js";
import { capturingSql, ctxFor } from "./fixtures.js";
import { runScenario } from "./endState.js";
import { CLOCK_READ, ROW_LOCK, SLUG_LOCK, firstIndex, transactionsOf } from "./statementKinds.js";
import type { TxKind } from "./statementKinds.js";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "statement-sequences.json");

const KINDS: TxKind[] = [
  "source",
  "locale-dayone-save-publish",
  "locale-tracked-save-publish",
  "locale-dayone-save-only",
  "locale-tracked-save-only",
  "locale-publish-only",
];

/**
 * The statement SEQUENCE of each write transaction kind (spec "Oracles and checks"): the whitespace-normalized SQL
 * texts in order, `begin` and `commit` included, as one golden per kind. Parameters are not captured. Run
 * `UPDATE_GOLDEN=1` to regenerate after a deliberate change, then read the diff: the ordering `expect`s below are the
 * human-readable contract and must still hold.
 *
 * Every transaction of a kind in the scenario has the same sequence (the code has no data-dependent branch inside a
 * kind), so one sequence per kind is the golden and every other transaction of the kind is compared to it.
 */
describe("statement sequence per transaction kind", () => {
  it("pins the ordered statements of every write transaction of the scenario", async () => {
    await withTestDb(async (sql) => {
      await migrate(sql);
      const cap = await capturingSql(sql);
      try {
        await runScenario(sql, ctxFor(cap.sql), {});
        const raw = cap.statements();
        const txs = transactionsOf(raw);

        // Every transaction of a kind has the same sequence as the first of its kind.
        const kinds: Partial<Record<TxKind, string[]>> = {};
        for (const t of txs) {
          const first = (kinds[t.kind] ??= t.statements);
          expect(t.statements, `${t.kind}: every transaction of the kind has one sequence`).toEqual(first);
        }
        expect(Object.keys(kinds).sort()).toEqual([...KINDS].sort());

        // The ordering contract, stated apart from the golden.
        for (const kind of KINDS) {
          const tx = kinds[kind]!;
          expect(tx[0], `${kind}: begin is first`).toBe("begin");
          expect(tx[tx.length - 1], `${kind}: commit is last`).toBe("commit");
          const lock = firstIndex(tx, ROW_LOCK);
          const clock = firstIndex(tx, CLOCK_READ);
          const slug = firstIndex(tx, SLUG_LOCK);
          expect(lock, `${kind}: the documents row lock is taken`).toBeGreaterThan(0);
          if (clock !== -1) expect(lock, `${kind}: the row lock comes before the clock read`).toBeLessThan(clock);
          if (slug !== -1) expect(lock, `${kind}: the row lock comes before the slug lock`).toBeLessThan(slug);
          expect(tx.some((x) => /savepoint/i.test(x)), `${kind}: no savepoint`).toBe(false);
          expect(tx.some((x) => /from migrations/i.test(x)), `${kind}: the licence read is outside the transaction`).toBe(false);
        }
        // Only a transaction that publishes reads the clock; one that only saves never does.
        for (const kind of ["locale-dayone-save-only", "locale-tracked-save-only"] as const) {
          expect(firstIndex(kinds[kind]!, CLOCK_READ), `${kind}: no clock read`).toBe(-1);
        }

        if (process.env.UPDATE_GOLDEN === "1") {
          const generatedFromCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
          fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
          fs.writeFileSync(goldenPath, JSON.stringify({ generatedFromCommit, kinds }, null, 2) + "\n");
          return;
        }
        const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as { generatedFromCommit: string; kinds: unknown };
        expect(kinds).toEqual(golden.kinds);
      } finally {
        await cap.sql.end();
      }
    });
  });
});
