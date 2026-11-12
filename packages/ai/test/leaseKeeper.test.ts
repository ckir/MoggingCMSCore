import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RENEW_RETRY_MS, leaseMarginMs, startLeaseKeeper } from "../src/leaseKeeper.js";

// Fake timers only: no database, no real sleeps. `now` is the faked Date.now, so it moves with the fake clock.
// A 300 s lease: regular renewal every 100 s, margin 60 s, so the watchdog fires 240 s after the last success.
const LEASE = 300_000;
const TICK = LEASE / 3;
const WATCHDOG = LEASE - leaseMarginMs(LEASE);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

type Step = boolean | "throw" | "hang" | Deferred;
type Deferred = { promise: Promise<boolean>; resolve: (v: boolean) => void; reject: (e: unknown) => void };

function deferred(): Deferred {
  let resolve!: (v: boolean) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<boolean>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A scripted `renew`: each call takes the next step (the last one repeats) and records the fake time it was made at. */
function script(...steps: Step[]) {
  const calls: number[] = [];
  const renew = (): Promise<boolean> => {
    const step = steps[Math.min(calls.length, steps.length - 1)]!;
    calls.push(Date.now());
    if (step === "throw") return Promise.reject(new Error("connection terminated unexpectedly"));
    if (step === "hang") return new Promise<boolean>(() => undefined);
    if (typeof step === "object") return step.promise;
    return Promise.resolve(step);
  };
  return { renew, calls };
}

function start(renew: () => Promise<boolean>, extra: { retryMs?: number } = {}) {
  const onLost = vi.fn();
  const keeper = startLeaseKeeper({ leaseMs: LEASE, renew, onLost, now: () => Date.now(), ...extra });
  return { keeper, onLost };
}

/** Advances the fake clock to the absolute time `t`, running timers and the promise jobs they queue. */
const at = (t: number) => vi.advanceTimersByTimeAsync(t - Date.now());

test("leaseMarginMs: 300 s lease -> 60 s; 100 s lease -> 30 s; 3 s lease -> 1.5 s (never more than half)", () => {
  expect(leaseMarginMs(300_000)).toBe(60_000);
  expect(leaseMarginMs(100_000)).toBe(30_000);
  expect(leaseMarginMs(3_000)).toBe(1_500);
  expect(RENEW_RETRY_MS).toBe(5_000);
});

test("a renewal that throws once does not abort; the retry after retryMs succeeds", async () => {
  const { renew, calls } = script("throw", true);
  const { keeper, onLost } = start(renew);
  await at(TICK);
  expect(calls).toEqual([TICK]);
  await at(TICK + RENEW_RETRY_MS - 1);
  expect(calls).toEqual([TICK]);
  await at(TICK + RENEW_RETRY_MS);
  expect(calls).toEqual([TICK, TICK + RENEW_RETRY_MS]); // the retry, not the next regular tick
  await at(2 * TICK - 1);
  expect(calls).toHaveLength(2); // the successful retry cancelled any further retry
  await at(2 * TICK);
  expect(calls).toEqual([TICK, TICK + RENEW_RETRY_MS, 2 * TICK]);
  // The retry's success re-armed the watchdog: still kept well past the first attempt's deadline.
  await at(TICK + WATCHDOG);
  expect(onLost).not.toHaveBeenCalled();
  await keeper.stop();
  expect(onLost).not.toHaveBeenCalled();
});

test("a renewal that returns false aborts immediately and stops the timers", async () => {
  const { renew, calls } = script(false);
  const { keeper, onLost } = start(renew);
  await at(TICK - 1);
  expect(onLost).not.toHaveBeenCalled();
  await at(TICK);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  await at(5 * LEASE);
  expect(calls).toEqual([TICK]);
  expect(onLost).toHaveBeenCalledTimes(1);
  await keeper.stop();
});

test("repeated throws abort exactly when the watchdog fires (last success + lease - margin), not earlier", async () => {
  const { renew, calls } = script("throw");
  const { keeper, onLost } = start(renew);
  await at(WATCHDOG - 1);
  expect(onLost).not.toHaveBeenCalled();
  expect(calls.length).toBeGreaterThan(2); // it kept retrying
  await at(WATCHDOG);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  const made = calls.length;
  await at(5 * LEASE);
  expect(calls).toHaveLength(made);
  await keeper.stop();
});

test("a successful renewal re-arms the watchdog", async () => {
  const { renew, calls } = script(true, "throw");
  const { keeper, onLost } = start(renew);
  await at(TICK);
  expect(calls).toEqual([TICK]); // the success, at t = TICK
  await at(WATCHDOG);             // the deadline before that success
  expect(onLost).not.toHaveBeenCalled();
  await at(TICK + WATCHDOG - 1);
  expect(onLost).not.toHaveBeenCalled();
  await at(TICK + WATCHDOG);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  await keeper.stop();
});

test("a renewal that hangs forever still aborts at the watchdog", async () => {
  const { renew, calls } = script("hang");
  const { onLost } = start(renew);
  await at(WATCHDOG - 1);
  expect(onLost).not.toHaveBeenCalled();
  expect(calls).toEqual([TICK]); // the regular tick at 2 * TICK is skipped while the first attempt is in flight
  await at(WATCHDOG);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  // stop() is not awaited here: it would wait for the attempt that never settles.
});

test("stop() clears all timers (no pending fake timers remain), resolves after an in-flight renewal settles, and a result arriving after stop neither aborts nor schedules a retry", async () => {
  // (a) A pending retry and the interval and the watchdog are all cleared.
  {
    const { renew, calls } = script("throw");
    const { keeper, onLost } = start(renew);
    await at(TICK); // the attempt threw: a retry is pending
    expect(vi.getTimerCount()).toBe(3);
    await keeper.stop();
    await keeper.stop(); // twice is safe
    expect(vi.getTimerCount()).toBe(0);
    await at(5 * LEASE);
    expect(calls).toEqual([TICK]);
    expect(onLost).not.toHaveBeenCalled();
  }
  // (b) An in-flight attempt that resolves false after stop: stop waits for it, and it does not abort.
  {
    const d = deferred();
    const { renew } = script(d);
    const { keeper, onLost } = start(renew);
    await at(Date.now() + TICK);
    let stopped = false;
    const stopping = keeper.stop().then(() => { stopped = true; });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    d.resolve(false);
    await stopping;
    expect(stopped).toBe(true);
    expect(onLost).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }
  // (c) An in-flight attempt that throws after stop: no retry is scheduled, no abort.
  {
    const d = deferred();
    const { renew, calls } = script(d);
    const { keeper, onLost } = start(renew);
    const t0 = Date.now();
    await at(t0 + TICK);
    let stopped = false;
    const stopping = keeper.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    d.reject(new Error("connection terminated unexpectedly"));
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    await at(t0 + 5 * LEASE);
    expect(calls).toHaveLength(1);
    expect(onLost).not.toHaveBeenCalled();
  }
});

test("onLost is called at most once", async () => {
  // (a) false, then past the watchdog's deadline.
  {
    const { renew } = script(false);
    const { keeper, onLost } = start(renew);
    await at(TICK);
    await at(3 * LEASE);
    expect(onLost).toHaveBeenCalledTimes(1);
    await keeper.stop();
  }
  // (b) the watchdog fires while an attempt hangs, then that attempt returns false.
  {
    const d = deferred();
    const { renew } = script(d);
    const { keeper, onLost } = start(renew);
    const t0 = Date.now();
    await at(t0 + WATCHDOG);
    expect(onLost).toHaveBeenCalledTimes(1);
    d.resolve(false);
    await keeper.stop();
    expect(onLost).toHaveBeenCalledTimes(1);
  }
});
