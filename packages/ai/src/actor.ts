import { ValidationError, type Ctx } from "@mogging/core";

// A private copy of core's guard (core keeps `assertActor` internal so its pinned public surface does not change).
// Postgres text cannot store U+0000: refuse it with a ValidationError before any query.
export function rejectNul(s: string, path: string): void {
  if (s.includes("\u0000")) throw new ValidationError(`${path}: contains U+0000`);
}

/**
 * Refuses a ctx whose `actor` contains U+0000. Called first in every exported function that can persist the actor
 * (a column, an error_message, a lease, or through recordAiDraft), right after `assertLicensed` where the function is
 * licence-guarded so a licence refusal wins; never inside an internal helper that a loop calls.
 */
export function assertActor(ctx: Ctx): void {
  rejectNul(ctx.actor, "actor");
}
