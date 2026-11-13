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

test("a licence refusal still wins over the actor check in a guarded writer", async () => withTestDb(async (sql) => {
  await api.migrate(sql);
  await sql`update migrations set applied_at = ${new Date(Date.now() - 31 * DAY)}`;
  const ctx = ctxFor(sql, NUL_ACTOR);
  await expect(api.saveDraft(ctx, { docId: DOC, locale: "en", data: {} })).rejects.toThrow(api.LicenceError);
  await expect(api.approveClean(ctx)).rejects.toThrow(api.LicenceError);
  // An unguarded writer has no licence check, so the actor check answers.
  await expect(api.createDocument(ctx, { collection: "posts" })).rejects.toThrow(api.ValidationError);
}));

test("an ordinary actor, including non-ASCII text, is unaffected", async () => withTestDb(async (sql) => {
  await api.migrate(sql);
  const ctx = ctxFor(sql, "Zoë ✓ O'Neil");
  const { id } = await api.createDocument(ctx, { collection: "posts" });
  const [row] = await sql`select created_by from documents where id = ${id}`;
  expect(row!.created_by).toBe("Zoë ✓ O'Neil");
}));
