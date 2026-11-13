import { ValidationError } from "../errors.js";

/** Postgres text and jsonb cannot store U+0000: refuse it with a ValidationError rather than a driver error. */
export function rejectNul(s: string, path: string): void {
  if (s.includes("\u0000")) throw new ValidationError(`${path}: contains U+0000`);
}
