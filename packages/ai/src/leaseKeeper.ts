/**
 * Keeps a job's lease while its provider calls run (spec 8.2). A renewal that the fence refuses (`renew` resolves false)
 * loses the lease at once; a renewal that THROWS says nothing about the lease, so it is retried instead of aborting the
 * (paid) call in flight. A watchdog loses the lease when no renewal has succeeded for `leaseMs - marginMs`, so a long
 * database outage or a renewal that never settles still aborts the call before the lease can lapse unnoticed.
 */

export const RENEW_RETRY_MS = 5_000;

/** Safety margin before the lease ends: max(30 s, 20 percent of the lease), never more than half the lease. */
export function leaseMarginMs(leaseMs: number): number {
  return Math.min(Math.max(30_000, 0.2 * leaseMs), leaseMs / 2);
}

export type LeaseKeeper = { stop(): Promise<void> };

export function startLeaseKeeper(args: {
  leaseMs: number;                    // ctx.ai.leaseSeconds * 1000
  renew: () => Promise<boolean>;      // false = the fence says the lease is gone; may throw
  onLost: () => void;                 // abort the in-flight call; called at most once
  retryMs?: number;                   // default RENEW_RETRY_MS, clamped to at most leaseMs / 3
  marginMs?: number;                  // default leaseMarginMs(leaseMs)
  now?: () => number;                 // default performance.now (monotonic, local); tests inject it
}): LeaseKeeper {
  const { leaseMs, renew, onLost } = args;
  const now = args.now ?? (() => performance.now());
  const retryMs = Math.min(args.retryMs ?? RENEW_RETRY_MS, leaseMs / 3);
  // Never more than half the lease, so a caller's margin of leaseMs or more cannot abort at once.
  const marginMs = Math.min(args.marginMs ?? leaseMarginMs(leaseMs), leaseMs / 2);

  let stopped = false;                // set by stop() and by losing the lease: nothing aborts or schedules after it
  let busy = false;
  let inFlight: Promise<void> = Promise.resolve();   // never rejects
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  // The first anchor is the keeper's start. That is after the claim AND the load phase, so it is NOT by itself a safe
  // lower bound for the claim's locked_until. The safety comes from translate.ts: no provider call starts before its
  // `beforeCall` renewal succeeds, and that renewal is sent after this point, so for any call made the lease ends at or
  // after now() + leaseMs. After that, a successful renewal anchors at its SEND time (a lower bound for its new end).
  let lastOkAt = now();

  const clearAll = () => {
    clearInterval(interval);
    clearTimeout(retry);
    clearTimeout(watchdog);
    retry = undefined;
    watchdog = undefined;
  };
  const lose = () => {
    if (stopped) return;
    stopped = true;
    clearAll();
    onLost();
  };
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(lose, Math.max(0, lastOkAt + leaseMs - marginMs - now()));
  };
  const attempt = () => {
    if (stopped || busy) return;
    busy = true;
    const sentAt = now();
    inFlight = (async () => renew())().then(
      (ok) => {
        busy = false;
        if (stopped) return;
        if (!ok) {
          lose();
          return;
        }
        lastOkAt = sentAt;
        clearTimeout(retry);
        retry = undefined;
        armWatchdog();
      },
      () => {
        busy = false;
        if (stopped) return;
        clearTimeout(retry);
        retry = setTimeout(() => {
          retry = undefined;
          attempt();
        }, retryMs);
      },
    );
  };

  const interval = setInterval(attempt, leaseMs / 3);
  armWatchdog();

  return {
    async stop() {
      stopped = true;
      clearAll();
      await inFlight;
    },
  };
}
