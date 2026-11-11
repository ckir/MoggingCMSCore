import type { Ctx } from "../ctx.js";
import { LicenceError } from "../errors.js";
import type { LicencePayload } from "./key.js";
import { verifyKey } from "./key.js";
import { PUBLIC_KEYS } from "./publicKey.js";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const WARN_DAYS = 7;
const DEFAULT_PURCHASE_URL = "https://mogging.dev/buy";
const REFUSAL =
  "Reads keep working and existing builds still succeed; content updates, compiles and publishing are paused until a licence key is set.";

export type LicenceState = {
  state: "licensed" | "evaluation" | "expired";
  daysLeft?: number;
  warn: boolean;
  payload?: LicencePayload;
  /** Set when a key was supplied but did not verify; such a key never licenses. */
  keyError?: "LICENCE_INVALID" | "LICENCE_EXPIRED";
};

/** Earliest `applied_at` in `migrations`; null for an empty or missing table (both count as day one). */
async function firstMigration(ctx: Ctx): Promise<Date | null> {
  try {
    const [row] = await ctx.sql`select min(applied_at) as first from migrations`;
    return (row?.first ?? null) as Date | null;
  } catch (e) {
    if ((e as { code?: unknown }).code === "42P01") return null; // undefined_table: not migrated yet
    throw e;
  }
}

/**
 * Licence state (spec 12.3). A key from `MOGGING_LICENSE_KEY` (else `config.license`) that verifies gives
 * `licensed`. Otherwise the 30-day evaluation window runs from the earliest migration: `daysLeft` is the
 * whole days remaining rounded up (ceil((start + 30 days - now) / 1 day), at most 30); the window is over,
 * `expired` with `daysLeft` 0, once that remainder is <= 0. `warn` is `daysLeft <= 7`.
 */
export async function getLicenceState(
  ctx: Ctx,
  opts: { publicKeys?: readonly string[]; now?: Date } = {},
): Promise<LicenceState> {
  const now = opts.now ?? new Date();
  const fromEnv = process.env.MOGGING_LICENSE_KEY?.trim();
  const token = fromEnv ? fromEnv : ctx.config.license?.trim();
  let keyError: LicenceState["keyError"];
  if (token) {
    try {
      const payload = verifyKey(token, opts.publicKeys ?? PUBLIC_KEYS, now);
      return { state: "licensed", warn: false, payload };
    } catch (e) {
      keyError = e instanceof LicenceError && e.code === "LICENCE_EXPIRED" ? "LICENCE_EXPIRED" : "LICENCE_INVALID";
    }
  }
  const first = await firstMigration(ctx);
  const startMs = first === null ? now.getTime() : Math.min(first.getTime(), now.getTime());
  const remainingMs = startMs + WINDOW_DAYS * DAY_MS - now.getTime();
  const base: LicenceState = remainingMs <= 0
    ? { state: "expired", daysLeft: 0, warn: true }
    : (() => {
        const daysLeft = Math.min(WINDOW_DAYS, Math.ceil(remainingMs / DAY_MS));
        return { state: "evaluation" as const, daysLeft, warn: daysLeft <= WARN_DAYS };
      })();
  return keyError === undefined ? base : { ...base, keyError };
}

/**
 * Guard for the write path (spec 12.3): throws `LicenceError` `LICENCE_REQUIRED` once the evaluation window is
 * over without a valid key. One read of `migrations`, no locks. Reads never call it.
 */
export async function assertLicensed(ctx: Ctx): Promise<void> {
  const s = await getLicenceState(ctx);
  if (s.state !== "expired") return;
  const url = ctx.config.purchaseUrl ?? DEFAULT_PURCHASE_URL;
  const why = s.keyError === "LICENCE_EXPIRED" ? " The configured licence key has expired."
    : s.keyError === "LICENCE_INVALID" ? " The configured licence key is not valid." : "";
  throw new LicenceError(
    "LICENCE_REQUIRED",
    `The 30-day MoggingCMS evaluation has ended and no valid licence key is set.${why} ${REFUSAL} Buy a licence key at ${url}`,
  );
}
