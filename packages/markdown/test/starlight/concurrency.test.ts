import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { ValidationError } from "@mogging/core";
import { resolveConcurrency, runGroups } from "../../src/starlight/concurrency.js";

const fake = (o: unknown): Sql => o as Sql;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe("resolveConcurrency", () => {
  it("clamps to the pool size and reports it", () => {
    expect(resolveConcurrency(fake({ options: { max: 8 } }), 4)).toEqual({ requested: 4, effective: 4, limit: "pool", poolMax: 8 });
    expect(resolveConcurrency(fake({ options: { max: 4 } }), 8)).toEqual({ requested: 8, effective: 4, limit: "pool", poolMax: 4 });
    expect(resolveConcurrency(fake({ options: { max: 1 } }), 4)).toEqual({ requested: 4, effective: 1, limit: "pool", poolMax: 1 });
  });

  it("treats undefined as 1", () => {
    expect(resolveConcurrency(fake({ options: { max: 8 } }), undefined)).toEqual({ requested: 1, effective: 1, limit: "pool", poolMax: 8 });
  });

  it("runs a transaction handle at 1", () => {
    expect(resolveConcurrency(fake({ savepoint() {}, options: {} }), 4)).toEqual({ requested: 4, effective: 1, limit: "transaction" });
    expect(resolveConcurrency(fake({ savepoint() {}, options: { max: 8 } }), 4)).toEqual({ requested: 4, effective: 1, limit: "transaction" });
  });

  it("runs at 1 when the pool size is unknown", () => {
    expect(resolveConcurrency(fake({ options: {} }), 4)).toEqual({ requested: 4, effective: 1, limit: "unknown" });
    expect(resolveConcurrency(fake({}), 4)).toEqual({ requested: 4, effective: 1, limit: "unknown" });
    expect(resolveConcurrency(fake({ options: { max: 0 } }), 4)).toEqual({ requested: 4, effective: 1, limit: "unknown" });
    expect(resolveConcurrency(fake({ options: { max: 2.5 } }), 4)).toEqual({ requested: 4, effective: 1, limit: "unknown" });
  });

  it("rejects a request that is not an integer of at least 1", () => {
    for (const bad of [0, -1, 0.5, NaN, Infinity]) {
      expect(() => resolveConcurrency(fake({ options: { max: 8 } }), bad), String(bad)).toThrow(ValidationError);
    }
  });
});

describe("runGroups", () => {
  const groups = [["a1", "a2", "a3"], ["b1", "b2"], ["c1"], ["d1", "d2"], ["e1"]];

  it("never has more than `concurrency` items in flight", async () => {
    for (const c of [1, 2, 3]) {
      let inFlight = 0;
      let peak = 0;
      await runGroups(groups, c, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
      });
      expect(peak, `concurrency ${c}`).toBe(c);
    }
  });

  it("runs the items of a group in order and never two of one group at once", async () => {
    const log: string[] = [];
    const running = new Set<string>();
    await runGroups(groups, 4, async (item) => {
      const g = item[0]!;
      expect(running.has(g), `two of group ${g} at once`).toBe(false);
      running.add(g);
      await tick();
      log.push(item);
      running.delete(g);
    });
    for (const g of groups) {
      expect(log.filter((x) => x[0] === g[0]![0])).toEqual(g);
    }
    expect(log).toHaveLength(9);
  });

  it("resolves only after every worker has settled", async () => {
    let done = 0;
    await runGroups([["slow"], ["fast"]], 2, async (item) => {
      await new Promise((r) => setTimeout(r, item === "slow" ? 30 : 1));
      done++;
    });
    expect(done).toBe(2);
  });

  it("finishes the rest and then rethrows the first rejection", async () => {
    const ran: string[] = [];
    let settledWhenRejected = 0;
    const p = runGroups([["x"], ["slow"], ["y"], ["z"]], 2, async (item) => {
      if (item === "x") throw new Error("first");
      if (item === "slow") await new Promise((r) => setTimeout(r, 30));
      ran.push(item);
    });
    await expect(p.catch((e: unknown) => { settledWhenRejected = ran.length; throw e; })).rejects.toThrow("first");
    expect(ran.sort()).toEqual(["slow", "y", "z"]);
    expect(settledWhenRejected).toBe(3);
  });

  it("handles no groups", async () => {
    await runGroups<string>([], 4, async () => { throw new Error("never"); });
  });
});
