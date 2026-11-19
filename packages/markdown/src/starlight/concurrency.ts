import type { Sql } from "postgres";
import { ValidationError } from "@mogging/core";

/**
 * How many locale files the import writes at once, and why. `effective` is what the run used; `limit` says what held
 * it at or below `requested`: `"pool"` (the connection pool's `max`, reported as `poolMax`), `"transaction"` (the
 * context's `sql` is a transaction handle, which runs one statement at a time) or `"unknown"` (the pool size could
 * not be read, so the run stays at 1).
 */
export type ConcurrencyDetails = {
  requested: number;
  effective: number;
  limit: "pool" | "transaction" | "unknown";
  /** The pool's `max`; present only when `limit` is `"pool"`. */
  poolMax?: number;
};

/**
 * Resolves the requested write concurrency against the connection the import runs on. A transaction handle (it has
 * `savepoint`) always runs at 1. A pool runs at `min(requested, options.max)`. A handle whose `options.max` is not a
 * positive integer runs at 1.
 *
 * @param sql the context's connection, a pool or a transaction handle.
 * @param requested the requested number of concurrent file writes; `undefined` means 1.
 * @returns the requested and effective concurrency and what limited it.
 * @throws {ValidationError} when `requested` is neither `undefined` nor an integer of at least 1.
 */
export function resolveConcurrency(sql: Sql, requested: number | undefined): ConcurrencyDetails {
  const want = requested ?? 1;
  if (!Number.isInteger(want) || want < 1) {
    throw new ValidationError(`concurrency must be an integer of at least 1, got ${String(requested)}`);
  }
  if (typeof (sql as { savepoint?: unknown }).savepoint === "function") {
    return { requested: want, effective: 1, limit: "transaction" };
  }
  const max = (sql as { options?: { max?: unknown } }).options?.max;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    return { requested: want, effective: 1, limit: "unknown" };
  }
  return { requested: want, effective: Math.min(want, max), limit: "pool", poolMax: max };
}

/**
 * Runs `work` over every item of every group with at most `concurrency` items in flight. Each worker takes a whole
 * group from a shared queue and runs its items one after the other, in order, so two items of one group never
 * overlap while different groups may. It resolves only after every worker has settled. A rejection from `work` does not
 * stop anything: every other item still runs, and the first rejection (in time) is rethrown afterwards.
 *
 * @param groups the items, grouped; the groups are taken in order.
 * @param concurrency the number of workers; at least 1.
 * @param work the per-item job.
 * @returns when every worker has settled.
 * @throws {unknown} the first rejection of `work`, after the other workers have settled.
 */
export async function runGroups<T>(
  groups: T[][], concurrency: number, work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (next < groups.length) {
      const group = groups[next++]!;
      for (const item of group) {
        try {
          await work(item);
        } catch (e) {
          failures.push(e);
        }
      }
    }
  };
  const count = Math.max(1, Math.min(concurrency, groups.length));
  await Promise.all(Array.from({ length: count }, worker));
  if (failures.length > 0) throw failures[0];
}
