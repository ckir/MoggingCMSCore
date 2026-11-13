import { afterAll, beforeAll, expect, test } from "vitest";
import type { Sql } from "postgres";
import * as api from "../src/index.js";
import type { Ctx } from "../src/index.js";
import { ctxFor } from "./fixtures.js";
import { withTestDb } from "./db.js";

const DAY = 24 * 60 * 60 * 1000;
const NUL_ACTOR = "bad\u0000actor";
const DOC = "00000000-0000-0000-0000-000000000000";

// Keep the suite hermetic against a developer shell that exports a key.
let savedEnv: string | undefined;
beforeAll(() => { savedEnv = process.env.MOGGING_LICENSE_KEY; delete process.env.MOGGING_LICENSE_KEY; });
afterAll(() => { if (savedEnv !== undefined) process.env.MOGGING_LICENSE_KEY = savedEnv; });

// Every exported function that can persist `ctx.actor`, called with junk input: the guard runs at the entry, so
// nothing below it (input validation, queries) is reached. approveClean with no input is an EMPTY scan: it must be
// refused too, not succeed until a candidate exists.
const WRITERS: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  createDocument: (c) => api.createDocument(c, { collection: "posts" }),
  deleteDocument: (c) => api.deleteDocument(c, { docId: DOC }),
  saveDraft: (c) => api.saveDraft(c, { docId: DOC, locale: "en", data: {} }),
  publish: (c) => api.publish(c, { docId: DOC, locale: "en" }),
  unpublish: (c) => api.unpublish(c, { docId: DOC, locale: "en" }),
  recordAiDraft: (c) => api.recordAiDraft(c, {} as never),
  rejectDraft: (c) => api.rejectDraft(c, { docId: DOC, locale: "de" }),
  approve: (c) => api.approve(c, { docId: DOC, locale: "de" }),
  approveClean: (c) => api.approveClean(c),
  trackFields: (c) => api.trackFields(c, {} as never),
  createRelease: (c) => api.createRelease(c, { name: "r" }),
  addToRelease: (c) => api.addToRelease(c, { releaseId: "1", docId: DOC, locale: "de", version: 1 }),
  publishRelease: (c) => api.publishRelease(c, { releaseId: "1" }),
};
// Take a ctx but never persist the actor (reads, and removeFromRelease, which records nothing: spec 9.3).
const READERS = [
  "migrate", "getDocument", "listDocuments", "resolve", "resolveReference", "getSyncState", "removeFromRelease",
  "listDraftHeads", "getDraftReview", "listReleases", "getLicenceState", "assertLicensed",
];
// Pure helpers and schema builders: no ctx at all.
const NO_CTX = [
  "defineConfig", "defineCollection", "text", "richText", "number", "boolean", "dateTime", "slug", "reference", "list",
  "object", "normalizeLocale", "chainFor", "hashValue", "normalizeValue", "verifyKey",
];

test("every exported function is classified: a new export must decide whether it persists the actor", () => {
  const exported = Object.entries(api)
    .filter(([name, v]) => typeof v === "function" && !name.endsWith("Error")).map(([name]) => name).sort();
  const classified = [...Object.keys(WRITERS), ...READERS, ...NO_CTX].sort();
  expect(classified).toEqual(exported);
  expect(new Set(classified).size).toBe(classified.length); // in exactly one list
});

test("every writer refuses a ctx whose actor contains U+0000 with a ValidationError and writes nothing", async () => withTestDb(async (sql) => {
  await api.migrate(sql);
  const ctx = ctxFor(sql, NUL_ACTOR);
  for (const [name, call] of Object.entries(WRITERS)) {
    const e = await call(ctx).catch((x: unknown) => x);
    expect(e, name).toBeInstanceOf(api.ValidationError);
    expect((e as Error).message, name).toBe("actor: contains U+0000");
  }
  const [{ n }] = await sql`select (select count(*) from documents)::int + (select count(*) from releases)::int
    + (select count(*) from content_provenance)::int as n`;
  expect(n).toBe(0);
}));

// The licence-guarded writers check the licence FIRST (spec 12.3), so an expired evaluation is a LicenceError (CLI exit 3)
// even with a bad actor; the unguarded writers have no licence check, so the actor check answers.
const GUARDED = ["saveDraft", "recordAiDraft", "approve", "approveClean", "publish", "publishRelease"];

test("a licence refusal wins over the actor check in every guarded writer, and the actor check answers in the others", async () => withTestDb(async (sql) => {
  await api.migrate(sql);
  await sql`update migrations set applied_at = ${new Date(Date.now() - 31 * DAY)}`;
  const ctx = ctxFor(sql, NUL_ACTOR);
  for (const name of GUARDED) expect(Object.keys(WRITERS), name).toContain(name);
  for (const [name, call] of Object.entries(WRITERS)) {
    const e = await call(ctx).catch((x: unknown) => x);
    expect(e, name).toBeInstanceOf(GUARDED.includes(name) ? api.LicenceError : api.ValidationError);
  }
}));

// The refusal is the FIRST thing a writer does: with a bad actor AND input that is itself invalid, the actor message
// answers, not the writer's own input error (so the guard cannot move below input validation unnoticed).
test("the actor check runs before input validation in every writer", async () => withTestDb(async (sql) => {
  await api.migrate(sql);
  const ctx = ctxFor(sql, NUL_ACTOR);
  const fns = api as unknown as Record<string, (c: Ctx, input: unknown) => Promise<unknown>>;
  for (const name of Object.keys(WRITERS)) {
    const e = await fns[name]!(ctx, {}).catch((x: unknown) => x);
    expect(e, name).toBeInstanceOf(api.ValidationError);
    expect((e as Error).message, name).toBe("actor: contains U+0000");
  }
}));

test("U+0000 is refused wherever it sits in the actor", async () => withTestDb(async (sql) => {
  await api.migrate(sql);
  for (const actor of ["\u0000", "\u0000x", "x\u0000", "caf\u00e9\u0000\u0301"]) {
    const e = await api.createDocument(ctxFor(sql, actor), { collection: "posts" }).catch((x: unknown) => x);
    expect(e, JSON.stringify(actor)).toBeInstanceOf(api.ValidationError);
    expect((e as Error).message).toBe("actor: contains U+0000");
  }
}));

// Near misses of NUL, and other control characters, are ordinary text: the guard must not be wider than NUL.
test("an actor with other control characters or NUL look-alikes is accepted and stored as given", async () => withTestDb(async (sql) => {
  await api.migrate(sql);
  for (const actor of ["tab\there", "line\nbreak", "\u0001", "\u001f", "\u007f", "\ufffd", "\u2400", "a\u0301"]) {
    const { id } = await api.createDocument(ctxFor(sql, actor), { collection: "posts" });
    const [row] = await sql`select created_by from documents where id = ${id}`;
    expect(row!.created_by, JSON.stringify(actor)).toBe(actor);
  }
}));

test("an ordinary actor, including non-ASCII text, is unaffected", async () => withTestDb(async (sql) => {
  await api.migrate(sql);
  const ctx = ctxFor(sql, "Zoë ✓ O'Neil");
  const { id } = await api.createDocument(ctx, { collection: "posts" });
  const [row] = await sql`select created_by from documents where id = ${id}`;
  expect(row!.created_by).toBe("Zoë ✓ O'Neil");
}));
