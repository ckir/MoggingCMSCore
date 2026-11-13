import type { Sql } from "postgres";
import type { MoggingConfig } from "./schema/config.js";
import { rejectNul } from "./values/nul.js";

export type Ctx = { sql: Sql; config: MoggingConfig; actor: string };

/**
 * Refuses a ctx whose `actor` contains U+0000 (Postgres text cannot store it) with a ValidationError, before any
 * query. Called first in every exported function that can persist the actor, right after `assertLicensed` where
 * the function is licence-guarded (a licence refusal wins), and never inside an internal helper that a loop calls.
 * The actor is attribution, not authentication (spec 8.7): only NUL is refused, no format check.
 */
export function assertActor(ctx: Ctx): void {
  rejectNul(ctx.actor, "actor");
}
