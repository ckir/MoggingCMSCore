import { afterAll, beforeAll, expect, test } from "vitest";
import { LicenceError, ValidationError } from "@mogging/core";
import * as api from "../src/index.js";
import type { AiCtx } from "../src/config.js";
import { ctxFor, migrateAndSeed } from "./fixtures.js";
import { identity, mockModel } from "./mockModel.js";
import { withTestDb } from "./db.js";

const DAY = 24 * 60 * 60 * 1000;
const NUL_ACTOR = "bad\u0000actor";

// Keep the suite hermetic against a developer shell that exports a key.
let savedEnv: string | undefined;
beforeAll(() => { savedEnv = process.env.MOGGING_LICENSE_KEY; delete process.env.MOGGING_LICENSE_KEY; });
afterAll(() => { if (savedEnv !== undefined) process.env.MOGGING_LICENSE_KEY = savedEnv; });

const withActor = (ctx: AiCtx, actor: string): AiCtx => ({ ...ctx, actor });

// Every exported function that can persist `ctx.actor` (a column, an error_message, a lease, or via recordAiDraft),
// called with junk or EMPTY input: the guard runs at the entry, so even a call that would write nothing is refused.
const WRITERS: Record<string, (ctx: AiCtx) => Promise<unknown>> = {
  upsertGlossary: (c) => api.upsertGlossary(c, []),
  enqueueStale: (c) => api.enqueueStale(c, { locales: [] }),
  retryJobs: (c) => api.retryJobs(c, { ids: [] }),
  cancelJobs: (c) => api.cancelJobs(c, { ids: [] }),
  // The explicit workerId means the actor is NOT in the lease, yet complete() persists it through recordAiDraft.
  runWorker: (c) => api.runWorker(c, { once: true, workerId: "w" }),
  compile: (c) => api.compile(c, {} as never),
};
const READERS = ["listGlossary", "getBudgets", "listJobs", "listProvenance"];
const NO_CTX = ["defineAiConfig", "usdToMicros", "priceFor", "glossaryModeFor", "estimateRequest", "planRequests"];

test("every exported function is classified: a new export must decide whether it persists the actor", () => {
  const exported = Object.entries(api).filter(([, v]) => typeof v === "function").map(([name]) => name).sort();
  const classified = [...Object.keys(WRITERS), ...READERS, ...NO_CTX].sort();
  expect(classified).toEqual(exported);
  expect(new Set(classified).size).toBe(classified.length);
});

test("every writer refuses a ctx whose actor contains U+0000 with a ValidationError", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = withActor(ctxFor(sql, mockModel([identity])), NUL_ACTOR);
  for (const [name, call] of Object.entries(WRITERS)) {
    const e = await call(ctx).catch((x: unknown) => x);
    expect(e, name).toBeInstanceOf(ValidationError);
    expect((e as Error).message, name).toBe("actor: contains U+0000");
  }
}));

test("runWorker with a bad actor claims no job, even with an explicit workerId", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const good = ctxFor(sql, mockModel([identity]));
  await api.enqueueStale(good, { locales: ["de"] });
  const before = await sql`select id, state, attempts from ai_jobs order by id`;
  expect(before.length).toBeGreaterThan(0);
  await expect(api.runWorker(withActor(good, NUL_ACTOR), { once: true, workerId: "w" })).rejects.toThrow(ValidationError);
  expect(await sql`select id, state, attempts from ai_jobs order by id`).toEqual(before);
}));

test("runWorker refuses an explicit workerId containing U+0000", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = ctxFor(sql, mockModel([identity]));
  const e = await api.runWorker(ctx, { once: true, workerId: "w\u0000x" }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  expect((e as Error).message).toBe("workerId: contains U+0000");
}));

test("a licence refusal still wins over the actor check in the guarded writers", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  await sql`update migrations set applied_at = ${new Date(Date.now() - 31 * DAY)}`;
  const ctx = withActor(ctxFor(sql, mockModel([identity])), NUL_ACTOR);
  await expect(api.runWorker(ctx, { once: true })).rejects.toThrow(LicenceError);
  await expect(api.enqueueStale(ctx, { locales: [] })).rejects.toThrow(LicenceError);
  await expect(api.compile(ctx, {} as never)).rejects.toThrow(LicenceError);
  // The unguarded writers have no licence check, so the actor check answers.
  await expect(api.cancelJobs(ctx, { ids: [] })).rejects.toThrow(ValidationError);
  await expect(api.upsertGlossary(ctx, [])).rejects.toThrow(ValidationError);
}));

// The refusal is the FIRST thing an ai writer does: a bad actor with input that is itself invalid is answered with the
// actor message, so the guard cannot move below input handling (which would otherwise throw its own error).
test("the actor check runs before input handling in every ai writer", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const ctx = withActor(ctxFor(sql, mockModel([identity])), NUL_ACTOR);
  const fns = api as unknown as Record<string, (c: AiCtx, input: unknown) => Promise<unknown>>;
  for (const name of Object.keys(WRITERS)) {
    const e = await fns[name]!(ctx, {}).catch((x: unknown) => x);
    expect(e, name).toBeInstanceOf(ValidationError);
    expect((e as Error).message, name).toBe("actor: contains U+0000");
  }
}));

// Near misses of NUL and other control characters are ordinary text: neither the actor nor an explicit workerId guard
// may be wider than NUL, and a NUL-only workerId is still refused.
test("control characters and NUL look-alikes are accepted in the actor and in a workerId; a NUL-only workerId is refused", async () => withTestDb(async (sql) => {
  await migrateAndSeed(sql);
  const good = ctxFor(sql, mockModel([identity]));
  for (const text of ["tab\there", "line\nbreak", "\u0001", "\u007f", "\ufffd", "\u2400"]) {
    const ctx = withActor(good, text);
    expect(await api.cancelJobs(ctx, { ids: [] }), JSON.stringify(text)).toEqual({ cancelled: 0 });
    expect(await api.runWorker(good, { once: true, workerId: `w${text}` }), JSON.stringify(text)).toMatchObject({ completed: 0 });
  }
  const e = await api.runWorker(good, { once: true, workerId: "\u0000" }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  expect((e as Error).message).toBe("workerId: contains U+0000");
}));
