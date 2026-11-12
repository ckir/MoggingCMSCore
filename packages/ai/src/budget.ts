import type { Sql, TransactionSql } from "postgres";
import { usdToMicros } from "./config.js";
import type { AiConfig, AiCtx } from "./config.js";

export type BudgetRow = {
  scope: string; periodStart: string; capMicros: number; spentMicros: number; inFlightMicros: number;
};

type Row = {
  scope: string; period_start: string; cap_micros: string; spent_micros: string; in_flight_micros: string;
};

const toBudgetRow = (r: Row): BudgetRow => ({
  scope: r.scope, periodStart: r.period_start,
  capMicros: Number(r.cap_micros), spentMicros: Number(r.spent_micros), inFlightMicros: Number(r.in_flight_micros),
});

/** ["global"], plus `collection:<name>` when that collection has its own cap. */
export function scopesFor(ai: AiConfig, collection: string): string[] {
  // An own key only: a collection named like an Object.prototype member ("constructor") has no phantom cap.
  const own = ai.budgets.collections !== undefined && Object.hasOwn(ai.budgets.collections, collection)
    && ai.budgets.collections[collection] !== undefined;
  return own ? ["global", `collection:${collection}`] : ["global"];
}

/** "YYYY-MM-01" of the UTC month of `now`. Only labels rows the database selected; never selects a period itself. */
export function periodStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

/** Every configured scope with its cap in micro-dollars: global first, then the collection scopes by name. */
function configuredCaps(ai: AiConfig, only?: string[]): { scope: string; cap: number }[] {
  const all = [
    { scope: "global", cap: usdToMicros(ai.budgets.monthlyCapUsd) },
    ...Object.keys(ai.budgets.collections ?? {}).sort().map((name) => ({
      scope: `collection:${name}`, cap: usdToMicros(ai.budgets.collections![name]!),
    })),
  ];
  return only ? all.filter((s) => only.includes(s.scope)) : all;
}

/**
 * Upserts the current month's rows for the scopes of `collection` (the config is the source of truth for the cap),
 * then locks them `for update`, global first, and returns them with their in-flight sums.
 * The month is the database's, so every worker and the reaper agree on the period whatever their host clocks say.
 */
export async function lockBudgets(tx: TransactionSql, ai: AiConfig, collection: string): Promise<BudgetRow[]> {
  const caps = configuredCaps(ai, scopesFor(ai, collection));
  const scopes = caps.map((c) => c.scope);
  // Global sorts first, so concurrent claimers take the row locks in the same order and cannot deadlock.
  // Do not simplify away: the upsert's `do update` takes each row lock in THIS statement, and the in-flight sum in the
  // next statement relies on it (a concurrent claimer is already serialized here, so the sum it reads is current).
  await tx`insert into ai_budgets (scope, period_start, cap_micros)
    select s.scope, date_trunc('month', clock_timestamp() at time zone 'UTC')::date, s.cap
    from unnest(${scopes}::text[], ${caps.map((c) => String(c.cap))}::bigint[]) as s(scope, cap)
    order by (s.scope = 'global') desc, s.scope
    on conflict (scope, period_start) do update set cap_micros = excluded.cap_micros`;
  const rows = (await tx`select b.scope, to_char(b.period_start, 'YYYY-MM-DD') as period_start, b.cap_micros, b.spent_micros,
      coalesce((select sum(j.cost_estimate_micros) from ai_jobs j
                where j.state = 'RUNNING' and j.locked_until > clock_timestamp()
                  and (b.scope = 'global' or j.budget_scope = b.scope)), 0) as in_flight_micros
    from ai_budgets b
    where b.scope = any(${scopes}) and b.period_start = date_trunc('month', clock_timestamp() at time zone 'UTC')::date
    order by (b.scope = 'global') desc, b.scope
    for update of b`) as unknown as Row[];
  return rows.map(toBudgetRow);
}

/** Adds `micros` to the current DB month's row of every scope. Call inside the transaction that holds `lockBudgets`. */
export async function debitBudgets(tx: TransactionSql, scopes: string[], micros: number): Promise<void> {
  await tx`update ai_budgets set spent_micros = spent_micros + ${micros}
    where scope = any(${scopes}) and period_start = date_trunc('month', clock_timestamp() at time zone 'UTC')::date`;
}

/** The current month for every configured scope, without locks. A scope with no row yet shows the config cap and nothing spent. */
export async function getBudgets(ctx: AiCtx): Promise<BudgetRow[]> {
  const sql: Sql = ctx.sql;
  const caps = configuredCaps(ctx.ai);
  const rows = (await sql`select s.scope, to_char(m.ps, 'YYYY-MM-DD') as period_start,
      coalesce(b.cap_micros, s.cap) as cap_micros, coalesce(b.spent_micros, 0) as spent_micros,
      coalesce((select sum(j.cost_estimate_micros) from ai_jobs j
                where j.state = 'RUNNING' and j.locked_until > clock_timestamp()
                  and (s.scope = 'global' or j.budget_scope = s.scope)), 0) as in_flight_micros
    from unnest(${caps.map((c) => c.scope)}::text[], ${caps.map((c) => String(c.cap))}::bigint[]) as s(scope, cap)
    cross join (select date_trunc('month', clock_timestamp() at time zone 'UTC')::date as ps) m
    left join ai_budgets b on b.scope = s.scope and b.period_start = m.ps
    order by (s.scope = 'global') desc, s.scope`) as unknown as Row[];
  return rows.map(toBudgetRow);
}
