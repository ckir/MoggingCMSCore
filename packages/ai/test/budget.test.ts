import { expect, test, vi } from "vitest";
import postgres from "postgres";
import type { Sql } from "postgres";
import type { LanguageModel } from "ai";
import { debitBudgets, getBudgets, lockBudgets, periodStart, scopesFor } from "../src/budget.js";
import { ctxFor, migrateAndSeed } from "./fixtures.js";
import { withTestDb } from "./db.js";

const model = {} as unknown as LanguageModel;
const dbMonth = async (sql: Sql): Promise<string> => {
  const [r] = await sql`select to_char(date_trunc('month', clock_timestamp() at time zone 'UTC')::date, 'YYYY-MM-DD') as m`;
  return r!.m as string;
};

/** Inserts a job directly; `locale` varies so the active-job unique index is not hit. */
async function insertJob(
  sql: Sql, docId: string, locale: string,
  o: { state?: string; micros: number; scope: string | null; leaseSeconds?: number | null },
): Promise<number> {
  const lease = o.leaseSeconds === undefined ? 300 : o.leaseSeconds;
  const [r] = await sql`insert into ai_jobs (doc_id, locale, field_paths, source_version, state, locked_until, cost_estimate_micros, budget_scope)
    values (${docId}, ${locale}, ${["title"]}, 1, ${o.state ?? "RUNNING"},
            ${lease === null ? null : sql`clock_timestamp() + make_interval(secs => ${lease})`}, ${o.micros}, ${o.scope}) returning id`;
  return Number(r!.id);
}

test("scopesFor gives no phantom collection scope to a collection named like a prototype member", () => {
  const ai = ctxFor({} as Sql, model, { budgets: { monthlyCapUsd: 1, collections: { posts: 0.5 } } }).ai;
  expect(scopesFor(ai, "posts")).toEqual(["global", "collection:posts"]);
  expect(scopesFor(ai, "constructor")).toEqual(["global"]);
  expect(scopesFor(ai, "toString")).toEqual(["global"]);
  expect(scopesFor(ai, "pages")).toEqual(["global"]);
});

test("periodStart is the first day of the UTC month", () => {
  expect(periodStart(new Date("2026-11-12T23:59:59Z"))).toBe("2026-11-01");
  expect(periodStart(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01");
  expect(periodStart(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01-01");
});

test("scopesFor is global, plus the collection scope only when it has its own cap", () => {
  const ai = ctxFor(null as never, model, { budgets: { monthlyCapUsd: 1, collections: { posts: 0.5 } } }).ai;
  expect(scopesFor(ai, "posts")).toEqual(["global", "collection:posts"]);
  expect(scopesFor(ai, "docs")).toEqual(["global"]);
  expect(scopesFor(ctxFor(null as never, model).ai, "posts")).toEqual(["global"]);
});

test("lockBudgets creates missing rows with the config cap and returns global first", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: 1, collections: { posts: 0.25 } } });
  const rows = await sql.begin((tx) => lockBudgets(tx, ctx.ai, "posts"));
  const month = await dbMonth(sql);
  expect(rows).toEqual([
    { scope: "global", periodStart: month, capMicros: 1_000_000, spentMicros: 0, inFlightMicros: 0 },
    { scope: "collection:posts", periodStart: month, capMicros: 250_000, spentMicros: 0, inFlightMicros: 0 },
  ]);
  expect(await sql`select scope from ai_budgets`).toHaveLength(2);
  // Idempotent: a second lock does not duplicate rows.
  await sql.begin((tx) => lockBudgets(tx, ctx.ai, "posts"));
  expect(await sql`select scope from ai_budgets`).toHaveLength(2);
}));

test("only the global row exists for a collection without its own cap", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model);
  const rows = await sql.begin((tx) => lockBudgets(tx, ctx.ai, "posts"));
  expect(rows.map((r) => r.scope)).toEqual(["global"]);
}));

test("a raised cap in config updates an existing row's cap_micros", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const low = ctxFor(sql, model, { budgets: { monthlyCapUsd: 1, collections: { posts: 0.25 } } });
  await sql.begin((tx) => lockBudgets(tx, low.ai, "posts"));
  await sql`update ai_budgets set spent_micros = 77`;
  const high = ctxFor(sql, model, { budgets: { monthlyCapUsd: 5, collections: { posts: 2 } } });
  const rows = await sql.begin((tx) => lockBudgets(tx, high.ai, "posts"));
  expect(rows.map((r) => [r.scope, r.capMicros, r.spentMicros])).toEqual([
    ["global", 5_000_000, 77], ["collection:posts", 2_000_000, 77],
  ]);
  expect(await sql`select cap_micros from ai_budgets order by scope`).toHaveLength(2);
}));

test("inFlightMicros counts a RUNNING job with a live lease and ignores one whose lease expired", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model);
  await insertJob(sql, docId, "de", { micros: 300, scope: "global" });
  const expired = await insertJob(sql, docId, "fr", { micros: 4000, scope: "global" });
  await sql`update ai_jobs set locked_until = clock_timestamp() - interval '1 second' where id = ${expired}`;
  await insertJob(sql, docId, "es", { micros: 50_000, scope: "global", state: "QUEUED", leaseSeconds: null });
  await insertJob(sql, docId, "it", { micros: 600_000, scope: "global", state: "COMPLETED" });
  await insertJob(sql, docId, "nl", { micros: 7_000_000, scope: "global", leaseSeconds: null });
  const [global] = await sql.begin((tx) => lockBudgets(tx, ctx.ai, "posts"));
  expect(global!.inFlightMicros).toBe(300);
}));

test("the global scope's in-flight includes a RUNNING job whose budget_scope is a collection scope", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: 1, collections: { posts: 0.5, docs: 0.5 } } });
  await insertJob(sql, docId, "de", { micros: 100, scope: "collection:posts" });
  await insertJob(sql, docId, "fr", { micros: 20, scope: "collection:docs" });
  await insertJob(sql, docId, "es", { micros: 3, scope: "global" });
  const rows = await sql.begin((tx) => lockBudgets(tx, ctx.ai, "posts"));
  expect(rows.map((r) => [r.scope, r.inFlightMicros])).toEqual([["global", 123], ["collection:posts", 100]]);
}));

test("the month is the database's, whatever the host clock says", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model);
  const month = await dbMonth(sql);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2001-02-03T04:05:06Z"));
    const rows = await sql.begin((tx) => lockBudgets(tx, ctx.ai, "posts"));
    expect(rows[0]!.periodStart).toBe(month);
    await sql.begin((tx) => debitBudgets(tx, ["global"], 5));
    const got = await getBudgets(ctx);
    expect(got[0]).toMatchObject({ periodStart: month, spentMicros: 5 });
  } finally {
    vi.useRealTimers();
  }
  expect(await sql`select period_start from ai_budgets where period_start < ${month}::date`).toHaveLength(0);
}));

test("a row of another month is neither returned, locked into the result, nor debited", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model);
  await sql`insert into ai_budgets (scope, period_start, cap_micros, spent_micros) values ('global', '2001-01-01', 9, 8)`;
  const rows = await sql.begin((tx) => lockBudgets(tx, ctx.ai, "posts"));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.spentMicros).toBe(0);
  await sql.begin((tx) => debitBudgets(tx, ["global"], 10));
  expect(await sql`select cap_micros, spent_micros from ai_budgets where period_start = '2001-01-01'`)
    .toMatchObject([{ cap_micros: "9", spent_micros: "8" }]);
}));

test("debitBudgets adds to every scope and getBudgets reflects the debit", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: 1, collections: { posts: 0.25, docs: 0.5 } } });
  const scopes = scopesFor(ctx.ai, "posts");
  await sql.begin(async (tx) => {
    await lockBudgets(tx, ctx.ai, "posts");
    await debitBudgets(tx, scopes, 1234);
  });
  await sql.begin(async (tx) => {
    await lockBudgets(tx, ctx.ai, "posts");
    await debitBudgets(tx, scopes, 100);
  });
  const month = await dbMonth(sql);
  const got = await getBudgets(ctx);
  expect(got).toEqual([
    { scope: "global", periodStart: month, capMicros: 1_000_000, spentMicros: 1334, inFlightMicros: 0 },
    // docs has a configured cap but no row yet: config cap, nothing spent.
    { scope: "collection:docs", periodStart: month, capMicros: 500_000, spentMicros: 0, inFlightMicros: 0 },
    { scope: "collection:posts", periodStart: month, capMicros: 250_000, spentMicros: 1334, inFlightMicros: 0 },
  ]);
}));

test("getBudgets synthesizes absent rows with the in-flight sum, writes nothing, and takes no lock", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: 2, collections: { posts: 1 } } });
  await insertJob(sql, docId, "de", { micros: 40, scope: "collection:posts" });
  await insertJob(sql, docId, "fr", { micros: 2, scope: "global" });
  const month = await dbMonth(sql);
  expect(await getBudgets(ctx)).toEqual([
    { scope: "global", periodStart: month, capMicros: 2_000_000, spentMicros: 0, inFlightMicros: 42 },
    { scope: "collection:posts", periodStart: month, capMicros: 1_000_000, spentMicros: 0, inFlightMicros: 40 },
  ]);
  expect(await sql`select 1 from ai_budgets`).toHaveLength(0);

  // No lock: a writer holding the rows does not block getBudgets. Deterministic: the writer holds its locks until
  // getBudgets has resolved, and getBudgets runs under a lock_timeout, so a lock wait fails with 55P03 instead of
  // hanging (no wall-clock threshold).
  await sql.begin((tx) => lockBudgets(tx, ctx.ai, "posts"));
  const other = await extraConnection(sql);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  try {
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    const writer = other.begin(async (tx) => {
      await lockBudgets(tx, ctx.ai, "posts");
      locked();
      await gate;
    });
    await holding;
    await sql`set lock_timeout = '100ms'`;
    try {
      const got = await getBudgets(ctx);
      expect(got.map((r) => r.inFlightMicros)).toEqual([42, 40]);
      // The probe can fail: the same connection waiting on the held rows does time out.
      await expect(sql.begin((tx) => lockBudgets(tx, ctx.ai, "posts"))).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await sql`reset lock_timeout`;
    }
    release();
    await writer;
  } finally {
    release();
    await other.end();
  }
}));

test("lockBudgets takes a row lock: a second transaction waits for the first to commit", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = ctxFor(sql, model, { budgets: { monthlyCapUsd: 1, collections: { posts: 0.25 } } });
  const other = await extraConnection(sql);
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    const first = sql.begin(async (tx) => {
      await lockBudgets(tx, ctx.ai, "posts");
      locked();
      await gate;
      await debitBudgets(tx, ["global", "collection:posts"], 10);
    });
    await holding;
    let secondDone = false;
    const second = other.begin(async (tx) => {
      const rows = await lockBudgets(tx, ctx.ai, "posts");
      secondDone = true;
      return rows;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(secondDone).toBe(false);
    release();
    await first;
    const rows = await second;
    expect(secondDone).toBe(true);
    // The second transaction sees the committed debit (it read after the lock was granted).
    expect(rows.map((r) => r.spentMicros)).toEqual([10, 10]);
  } finally {
    await other.end();
  }
}));

async function extraConnection(sql: Sql): Promise<Sql> {
  const [{ s }] = (await sql`select current_schema() as s`) as unknown as [{ s: string }];
  return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: s } });
}
