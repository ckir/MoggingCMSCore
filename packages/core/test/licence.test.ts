import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { Sql } from "postgres";
import {
  LicenceError, addToRelease, approve, approveClean, assertLicensed, createDocument, createRelease, defineConfig,
  deleteDocument, getDocument, getLicenceState, getSyncState, hashValue, listDocuments, migrate, publish,
  publishRelease, recordAiDraft, resolve, saveDraft, trackFields, unpublish, verifyKey,
} from "../src/index.js";
import type { Ctx, LicencePayload, MoggingConfig } from "../src/index.js";
import { encodeKey } from "../src/licence/key.js";
import { config, ctxFor, posts } from "./fixtures.js";
import { withTestDb } from "./db.js";

// The shipped PUBLIC_KEYS list is empty until the owner pastes the production key (fail closed). The guard
// reads that list, so this file swaps in a generated test key; every verifyKey call below passes its list.
const TEST_KEY = await vi.hoisted(async () => {
  const { generateKeyPairSync: gen } = await import("node:crypto");
  const { publicKey, privateKey } = gen("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
});
vi.mock("../src/licence/publicKey.js", () => ({ PUBLIC_KEYS: [TEST_KEY.publicPem] }));

const DAY = 86_400_000;
const BUY = "https://mogging.dev/buy";
const SENTENCE =
  "Reads keep working and existing builds still succeed; content updates, compiles and publishing are paused until a licence key is set.";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
const kp = TEST_KEY;
const other = keypair();
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
/** Signs arbitrary payload bytes, bypassing encodeKey's payload validation. */
const signRaw = (bytes: string, privatePem = kp.privatePem) =>
  `mog1.${b64u(bytes)}.${b64u(cryptoSign(null, Buffer.from(bytes), privatePem))}`;

const payload: LicencePayload = { licensee: "Acme GmbH", license_id: "lic_0001", expiry: "2099-12-31", plan: "solo" };

function licenceCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LicenceError);
    return (e as LicenceError).code;
  }
  throw new Error("expected a LicenceError, nothing was thrown");
}
async function licenceErrorOf(p: Promise<unknown>): Promise<LicenceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LicenceError);
    return e as LicenceError;
  }
  throw new Error("expected a LicenceError, nothing was thrown");
}
async function expectRequired(p: Promise<unknown>, url = BUY): Promise<void> {
  const e = await licenceErrorOf(p);
  expect(e.code).toBe("LICENCE_REQUIRED");
  expect(e.message).toContain(url);
  expect(e.message).toContain(SENTENCE);
}

const ctxWith = (sql: Sql, extra: Partial<MoggingConfig>): Ctx => ({ ...ctxFor(sql), config: { ...config, ...extra } });
const setFirstMigration = (sql: Sql, at: Date) => sql`update migrations set applied_at = ${at}`;
const expireWindow = (sql: Sql) => setFirstMigration(sql, new Date(Date.now() - 31 * DAY));

// Keep the suite hermetic against a developer shell that exports a key.
let savedEnv: string | undefined;
beforeAll(() => { savedEnv = process.env.MOGGING_LICENSE_KEY; delete process.env.MOGGING_LICENSE_KEY; });
afterAll(() => { if (savedEnv !== undefined) process.env.MOGGING_LICENSE_KEY = savedEnv; });

const prov = (fieldPath: string) => ({
  fieldPath, modelId: "m1", promptVersion: "p1", promptTokens: 1, completionTokens: 1, costMicros: 1,
});

/**
 * Migrated database with a document: en published (v1), a de DRAFT_HUMAN head, a de-CH DRAFT_AI head, and a
 * release holding the de draft. Built while the window is open.
 */
async function world(sql: Sql, ctx: Ctx) {
  await migrate(sql);
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello", body: "World" } });
  await saveDraft(ctx, { docId, locale: "shared", data: { slug: "hello" } });
  await publish(ctx, { docId, locale: "en" });
  await publish(ctx, { docId, locale: "shared" });
  const { version: deVersion } = await saveDraft(ctx, { docId, locale: "de", data: { title: "Hallo", body: "Welt" } });
  const hashes = { title: hashValue("Hello"), body: hashValue("World") };
  const ai = await recordAiDraft(ctx, {
    docId, locale: "de-CH", fields: { title: "Grüezi" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
  });
  if (!("version" in ai)) throw new Error("setup: AI draft was cancelled");
  const { id: releaseId } = await createRelease(ctx, { name: "r1" });
  await addToRelease(ctx, { releaseId, docId, locale: "de", version: deVersion });
  return { docId, deVersion, hashes, releaseId };
}

// ---- keys ------------------------------------------------------------------------------------------------

test("encodeKey then verifyKey round-trips the payload", () => {
  const token = encodeKey(payload, kp.privatePem);
  expect(token.startsWith("mog1.")).toBe(true);
  expect(token.split(".")).toHaveLength(3);
  expect(verifyKey(token, [kp.publicPem])).toEqual(payload);
  expect(verifyKey(token, kp.publicPem)).toEqual(payload); // a single PEM string is accepted too
});

test("a token signed with a different key is LICENCE_INVALID", () => {
  const token = encodeKey(payload, other.privatePem);
  expect(licenceCode(() => verifyKey(token, [kp.publicPem]))).toBe("LICENCE_INVALID");
});

test("an expired token is LICENCE_EXPIRED", () => {
  const token = encodeKey({ ...payload, expiry: "2020-01-31" }, kp.privatePem);
  expect(licenceCode(() => verifyKey(token, [kp.publicPem]))).toBe("LICENCE_EXPIRED");
  // The signature is checked first: an expired token under the wrong key is INVALID, not EXPIRED.
  expect(licenceCode(() => verifyKey(token, [other.publicPem]))).toBe("LICENCE_INVALID");
});

test("a tampered payload with the original signature is LICENCE_INVALID", () => {
  const token = encodeKey({ ...payload, plan: "noncommercial" }, kp.privatePem);
  const [, , sig] = token.split(".");
  const forged = `mog1.${b64u(JSON.stringify({ ...payload, plan: "solo" }))}.${sig}`;
  expect(licenceCode(() => verifyKey(forged, [kp.publicPem]))).toBe("LICENCE_INVALID");
});

test("a valid token with extra and reordered payload keys still verifies (signature over raw bytes)", () => {
  const raw = `{ "plan": "solo", "future_field": {"x": 1},\n "expiry": "2099-12-31", "license_id": "lic_0001", "licensee": "Acme GmbH" }`;
  const out = verifyKey(signRaw(raw), [kp.publicPem]);
  expect(out).toMatchObject(payload);
});

test("limits are carried through verifyKey unchanged", () => {
  const token = encodeKey({ ...payload, limits: { seats: 3, sites: 1.5 } }, kp.privatePem);
  expect(verifyKey(token, [kp.publicPem]).limits).toEqual({ seats: 3, sites: 1.5 });
});

test("expiry is valid through 23:59:59.999 UTC on the stated date and expired at 00:00 UTC the next day", () => {
  const token = encodeKey({ ...payload, expiry: "2026-11-11" }, kp.privatePem);
  expect(verifyKey(token, [kp.publicPem], new Date("2026-11-11T00:00:00.000Z")).expiry).toBe("2026-11-11");
  expect(verifyKey(token, [kp.publicPem], new Date("2026-11-11T23:59:59.999Z")).expiry).toBe("2026-11-11");
  expect(licenceCode(() => verifyKey(token, [kp.publicPem], new Date("2026-11-12T00:00:00.000Z")))).toBe("LICENCE_EXPIRED");
});

test("malformed tokens are LICENCE_INVALID and never another error type", () => {
  const good = encodeKey(payload, kp.privatePem);
  const [, p, s] = good.split(".") as [string, string, string];
  const shortSig = b64u(Buffer.from(s, "base64url").subarray(0, 63));
  const without = (k: string) => { const o: Record<string, unknown> = { ...payload }; delete o[k]; return JSON.stringify(o); };
  const cases: Record<string, unknown> = {
    "wrong prefix": `mog2.${p}.${s}`,
    "no prefix": `${p}.${s}`,
    "2 segments": `mog1.${p}`,
    "4 segments": `mog1.${p}.${s}.${s}`,
    "empty": "",
    "not a string": undefined,
    "a number": 42,
    "bad base64url in payload": `mog1.${p}*.${s}`,
    "standard base64 padding": `mog1.${p}==.${s}`,
    "bad base64url in signature": `mog1.${p}.${s}!`,
    "empty payload segment": `mog1..${s}`,
    "wrong-length signature": `mog1.${p}.${shortSig}`,
    "empty signature": `mog1.${p}.`,
    "non-JSON payload": signRaw("not json"),
    "invalid UTF-8 payload": signRaw("ÿ") /* valid UTF-8 encoding; real invalid bytes below */,
    "array payload": signRaw(JSON.stringify([payload])),
    "null payload": signRaw("null"),
    "string payload": signRaw('"solo"'),
    "missing licensee": signRaw(without("licensee")),
    "missing license_id": signRaw(without("license_id")),
    "missing expiry": signRaw(without("expiry")),
    "missing plan": signRaw(without("plan")),
    "numeric licensee": signRaw(JSON.stringify({ ...payload, licensee: 7 })),
    "numeric expiry": signRaw(JSON.stringify({ ...payload, expiry: 20991231 })),
    "expiry with time": signRaw(JSON.stringify({ ...payload, expiry: "2099-12-31T00:00:00Z" })),
    "expiry month 13": signRaw(JSON.stringify({ ...payload, expiry: "2099-13-01" })),
    "expiry Feb 30": signRaw(JSON.stringify({ ...payload, expiry: "2099-02-30" })),
    "null plan": signRaw(JSON.stringify({ ...payload, plan: null })),
    "limits array": signRaw(JSON.stringify({ ...payload, limits: [1] })),
    "limits null": signRaw(JSON.stringify({ ...payload, limits: null })),
    "limits string value": signRaw(JSON.stringify({ ...payload, limits: { seats: "3" } })),
    "limits infinite value": signRaw(JSON.stringify({ ...payload, limits: {} }).replace("{}", '{"seats":1e999}')),
  };
  // Genuinely invalid UTF-8 bytes in the payload, correctly signed.
  const bad = Buffer.from([0x7b, 0xff, 0x7d]);
  cases["invalid UTF-8 payload"] = `mog1.${b64u(bad)}.${b64u(cryptoSign(null, bad, kp.privatePem))}`;
  for (const [name, token] of Object.entries(cases)) {
    let caught: unknown;
    try {
      verifyKey(token as string, [kp.publicPem], new Date("2026-11-11T00:00:00Z"));
    } catch (e) {
      caught = e;
    }
    expect(caught, name).toBeInstanceOf(LicenceError);
    expect((caught as LicenceError).code, name).toBe("LICENCE_INVALID");
    if (typeof token === "string" && token.length > 10) {
      expect((caught as LicenceError).message, `${name}: message must not echo the token`).not.toContain(token.slice(5, 25));
    }
  }
});

test("key rotation: a token signed by the second listed key verifies; empty or unusable key lists are LICENCE_INVALID", () => {
  const byOther = encodeKey(payload, other.privatePem);
  expect(verifyKey(byOther, [kp.publicPem, other.publicPem])).toEqual(payload);
  expect(verifyKey(byOther, ["not a pem", other.publicPem])).toEqual(payload);
  expect(licenceCode(() => verifyKey(byOther, []))).toBe("LICENCE_INVALID");
  expect(licenceCode(() => verifyKey(byOther, ["not a pem"]))).toBe("LICENCE_INVALID");
  // An RSA public key in the list is not an Ed25519 key and never verifies.
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  expect(licenceCode(() => verifyKey(byOther, [rsa]))).toBe("LICENCE_INVALID");
});

test("tools/licence/sign.ts signs through encodeKey and its token verifies; it never prints the private key", async () => {
  const signerUrl = new URL("../../../tools/licence/sign.ts", import.meta.url).href;
  const signer = (await import(signerUrl)) as {
    signFromArgs: (argv: string[], env: Record<string, string | undefined>) => string;
  };
  const env = { MOGGING_LICENSE_PRIVATE_KEY: kp.privatePem };
  const token = signer.signFromArgs(
    ["--licensee", "Acme GmbH", "--id", "lic_0001", "--expiry", "2099-12-31", "--plan", "solo"], env,
  );
  expect(verifyKey(token, [kp.publicPem])).toEqual(payload);
  expect(token).not.toContain("PRIVATE");
  for (const [argv, e] of [
    [["--licensee", "A", "--id", "x", "--expiry", "2099-12-31", "--plan", "solo"], {}],
    [["--licensee", "A", "--id", "x", "--expiry", "31.12.2099", "--plan", "solo"], env],
    [["--licensee", "A", "--id", "x", "--expiry", "2099-12-31"], env],
  ] as const) {
    let msg = "";
    try { signer.signFromArgs([...argv], e); } catch (err) { msg = String((err as Error).message); }
    expect(msg).not.toBe("");
    expect(msg).not.toContain("PRIVATE KEY");
  }
});

// ---- evaluation window -----------------------------------------------------------------------------------

test("fresh database is in evaluation with 30 days left", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const s = await getLicenceState(ctxFor(sql));
  expect(s).toMatchObject({ state: "evaluation", daysLeft: 30, warn: false });
  expect(s.keyError).toBeUndefined();
  expect(s.payload).toBeUndefined();
}));

test("evaluation expires 30 days after the first migration", async () => withTestDb(async (sql) => {
  await migrate(sql);
  await setFirstMigration(sql, new Date(Date.now() - 31 * DAY));
  expect(await getLicenceState(ctxFor(sql))).toMatchObject({ state: "expired", daysLeft: 0 });
  await expectRequired(assertLicensed(ctxFor(sql)));
}));

test("day arithmetic: whole days remaining rounded up, with exact boundaries", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const now = new Date("2026-11-11T12:00:00.000Z");
  const at = async (agoMs: number) => {
    await setFirstMigration(sql, new Date(now.getTime() - agoMs));
    return getLicenceState(ctxFor(sql), { now });
  };
  expect(await at(0)).toEqual({ state: "evaluation", daysLeft: 30, warn: false });
  expect(await at(1)).toEqual({ state: "evaluation", daysLeft: 30, warn: false });
  expect(await at(22 * DAY)).toEqual({ state: "evaluation", daysLeft: 8, warn: false });
  expect(await at(22 * DAY + 1)).toEqual({ state: "evaluation", daysLeft: 8, warn: false });
  expect(await at(23 * DAY - 1)).toEqual({ state: "evaluation", daysLeft: 8, warn: false });
  expect(await at(23 * DAY)).toEqual({ state: "evaluation", daysLeft: 7, warn: true });
  expect(await at(30 * DAY - 1)).toEqual({ state: "evaluation", daysLeft: 1, warn: true });
  expect(await at(30 * DAY)).toEqual({ state: "expired", daysLeft: 0, warn: true });
  expect(await at(31 * DAY)).toEqual({ state: "expired", daysLeft: 0, warn: true });
  // A first migration in the future (clock skew) never grants more than 30 days.
  expect(await at(-5 * DAY)).toEqual({ state: "evaluation", daysLeft: 30, warn: false });
}));

test("the window starts at the EARLIEST migration", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const now = new Date("2026-11-11T12:00:00.000Z");
  await sql`update migrations set applied_at = ${new Date(now.getTime() - 2 * DAY)}`;
  await sql`insert into migrations (name, applied_at) values ('0000_early.sql', ${new Date(now.getTime() - 25 * DAY)})`;
  expect(await getLicenceState(ctxFor(sql), { now })).toMatchObject({ state: "evaluation", daysLeft: 5, warn: true });
}));

test("an empty or missing migrations table counts as day one", async () => withTestDb(async (sql) => {
  expect(await getLicenceState(ctxFor(sql))).toEqual({ state: "evaluation", daysLeft: 30, warn: false });
  await sql`create table migrations (name text primary key, applied_at timestamptz not null default clock_timestamp())`;
  expect(await getLicenceState(ctxFor(sql))).toEqual({ state: "evaluation", daysLeft: 30, warn: false });
  await assertLicensed(ctxFor(sql));
}));

// ---- keys in the state -----------------------------------------------------------------------------------

test("a valid key licenses and carries limits; the shipped key list is used by default", async () => withTestDb(async (sql) => {
  await migrate(sql);
  await expireWindow(sql);
  const token = encodeKey({ ...payload, plan: "noncommercial", limits: { seats: 2 } }, kp.privatePem);
  const s = await getLicenceState(ctxWith(sql, { license: token }));
  expect(s).toEqual({ state: "licensed", warn: false, payload: { ...payload, plan: "noncommercial", limits: { seats: 2 } } });
  // Explicit keys override the default list: the same token under another key list does not license.
  const s2 = await getLicenceState(ctxWith(sql, { license: token }), { publicKeys: [other.publicPem] });
  expect(s2).toMatchObject({ state: "expired", keyError: "LICENCE_INVALID" });
}));

test("an invalid or expired key in config does not license; the state says why", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const forged = encodeKey(payload, other.privatePem);
  const lapsed = encodeKey({ ...payload, expiry: "2020-01-01" }, kp.privatePem);
  expect(await getLicenceState(ctxWith(sql, { license: forged }))).toEqual(
    { state: "evaluation", daysLeft: 30, warn: false, keyError: "LICENCE_INVALID" });
  expect(await getLicenceState(ctxWith(sql, { license: "garbage" }))).toMatchObject(
    { state: "evaluation", keyError: "LICENCE_INVALID" });
  expect(await getLicenceState(ctxWith(sql, { license: lapsed }))).toEqual(
    { state: "evaluation", daysLeft: 30, warn: false, keyError: "LICENCE_EXPIRED" });
  await expireWindow(sql);
  expect(await getLicenceState(ctxWith(sql, { license: lapsed }))).toEqual(
    { state: "expired", daysLeft: 0, warn: true, keyError: "LICENCE_EXPIRED" });
  const e = await licenceErrorOf(assertLicensed(ctxWith(sql, { license: lapsed })));
  expect(e.code).toBe("LICENCE_REQUIRED");
  expect(e.message).not.toContain(lapsed);
  await expectRequired(saveDraft(ctxWith(sql, { license: forged }), {
    docId: "00000000-0000-0000-0000-000000000000", locale: "en", data: {},
  }));
}));

test("MOGGING_LICENSE_KEY takes precedence over config.license", async () => withTestDb(async (sql) => {
  await migrate(sql);
  await expireWindow(sql);
  const valid = encodeKey(payload, kp.privatePem);
  const forged = encodeKey(payload, other.privatePem);
  const before = process.env.MOGGING_LICENSE_KEY;
  try {
    process.env.MOGGING_LICENSE_KEY = valid;
    expect(await getLicenceState(ctxWith(sql, { license: forged }))).toMatchObject({ state: "licensed", payload });
    process.env.MOGGING_LICENSE_KEY = forged;
    expect(await getLicenceState(ctxWith(sql, { license: valid }))).toMatchObject(
      { state: "expired", keyError: "LICENCE_INVALID" });
    process.env.MOGGING_LICENSE_KEY = "";
    expect(await getLicenceState(ctxWith(sql, { license: valid }))).toMatchObject({ state: "licensed" });
  } finally {
    if (before === undefined) delete process.env.MOGGING_LICENSE_KEY;
    else process.env.MOGGING_LICENSE_KEY = before;
  }
}));

test("defineConfig carries license and purchaseUrl; the refusal names a custom purchase URL", async () => withTestDb(async (sql) => {
  const cfg = defineConfig({
    collections: [posts], locales: { source: "en", chains: { de: ["en"] } },
    license: "mog1.x.y", purchaseUrl: "https://example.test/licence",
  });
  expect(cfg.license).toBe("mog1.x.y");
  expect(cfg.purchaseUrl).toBe("https://example.test/licence");
  const plain = defineConfig({ collections: [posts], locales: { source: "en", chains: {} } });
  expect(Object.hasOwn(plain, "license")).toBe(false);
  expect(Object.hasOwn(plain, "purchaseUrl")).toBe(false);
  await migrate(sql);
  await expireWindow(sql);
  await expectRequired(assertLicensed(ctxWith(sql, { purchaseUrl: "https://example.test/licence" })), "https://example.test/licence");
  await expectRequired(assertLicensed(ctxFor(sql)), BUY);
}));

// ---- guarded operations ----------------------------------------------------------------------------------

test("expired without key: saveDraft, approve, publish, publishRelease throw LICENCE_REQUIRED naming the purchase URL; resolve and getDocument still work", async () => withTestDb(async (sql) => {
  const ctx = ctxFor(sql);
  const { docId, releaseId } = await world(sql, ctx);
  await expireWindow(sql);
  const rowsBefore = await sql`select doc_id, locale, version, state, is_head_draft, is_head_published from document_localized order by locale, version`;

  await expectRequired(saveDraft(ctx, { docId, locale: "en", data: { title: "New" } }));
  await expectRequired(approve(ctx, { docId, locale: "de-CH" }));
  await expectRequired(publish(ctx, { docId, locale: "de" }));
  await expectRequired(publishRelease(ctx, { releaseId }));
  // First statement: the licence check precedes input validation.
  await expectRequired(saveDraft(ctx, { docId: "nope", locale: "xx", data: {} }));
  await expectRequired(publish(ctx, { docId: "nope", locale: "xx" }));
  await expectRequired(approve(ctx, { docId: "nope", locale: "xx" }));
  await expectRequired(publishRelease(ctx, { releaseId: "nope" }));

  expect(await sql`select doc_id, locale, version, state, is_head_draft, is_head_published from document_localized order by locale, version`).toEqual(rowsBefore);
  const [rel] = await sql`select published_at from releases where id = ${releaseId}`;
  expect(rel!.published_at).toBeNull();

  const resolved = await resolve(ctx, { collection: "posts", locale: "de" });
  expect(resolved.map((r) => [r.id, r.data.title])).toEqual([[docId, "Hello"]]);
  const doc = await getDocument(ctx, { collection: "posts", docId });
  expect(doc!.locales.en!.published!.data).toMatchObject({ title: "Hello" });
  expect(doc!.locales.de!.draft!.data).toMatchObject({ title: "Hallo" });
}));

test("expired without key: approveClean and recordAiDraft throw LICENCE_REQUIRED and approveClean approves nothing", async () => withTestDb(async (sql) => {
  const ctx = ctxFor(sql);
  const { docId, hashes } = await world(sql, ctx);
  await expireWindow(sql);
  await expectRequired(approveClean(ctx));
  await expectRequired(approveClean(ctx, { collection: "nope" })); // guard precedes the scan's validation
  await expectRequired(recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo AI" }, sourceVersion: 1, sourceHashes: hashes, provenance: [prov("title")],
  }));
  await expectRequired(recordAiDraft(ctx, {
    docId: "nope", locale: "shared", fields: {}, sourceVersion: 1, sourceHashes: {}, provenance: [],
  }));
  const [head] = await sql`select state from document_localized where doc_id = ${docId} and locale = 'de-CH' and is_head_draft`;
  expect(head!.state).toBe("DRAFT_AI");
  const [{ n }] = await sql`select count(*)::int as n from content_provenance where bulk_id is not null or approved_by is not null`;
  expect(n).toBe(0);
}));

test("expired without key: unpublish, createRelease, addToRelease, trackFields, getSyncState, createDocument, deleteDocument and reads still work", async () => withTestDb(async (sql) => {
  const ctx = ctxFor(sql);
  const { docId, deVersion } = await world(sql, ctx);
  await expireWindow(sql);
  expect((await getLicenceState(ctx)).state).toBe("expired");

  const { id: newDoc } = await createDocument(ctx, { collection: "posts" });
  const { id: rel2 } = await createRelease(ctx, { name: "r2" });
  await addToRelease(ctx, { releaseId: rel2, docId, locale: "de", version: deVersion });
  await trackFields(ctx, { docId, locale: "de", fields: ["title"] });
  const sync = await getSyncState(ctx, { docId, locale: "de" });
  expect(sync.length).toBeGreaterThan(0);
  expect((await listDocuments(ctx, { collection: "posts" })).items.map((i) => i.id)).toContain(newDoc);
  await deleteDocument(ctx, { docId: newDoc });
  await unpublish(ctx, { docId, locale: "en" });
  const [en] = await sql`select count(*)::int as n from document_localized where doc_id = ${docId} and locale = 'en' and is_head_published`;
  expect(en!.n).toBe(0);
}));

test("expired with a valid key: everything works and state is licensed", async () => withTestDb(async (sql) => {
  const ctx = ctxWith(sql, { license: encodeKey(payload, kp.privatePem) });
  const { docId, hashes, releaseId } = await world(sql, ctxFor(sql));
  await expireWindow(sql);
  expect(await getLicenceState(ctxFor(sql))).toMatchObject({ state: "expired" });
  expect(await getLicenceState(ctx)).toEqual({ state: "licensed", warn: false, payload });
  await assertLicensed(ctx);

  await saveDraft(ctx, { docId, locale: "en", data: { title: "Hello 2" } });
  await publish(ctx, { docId, locale: "en" });
  await approve(ctx, { docId, locale: "de-CH" });
  await publish(ctx, { docId, locale: "de-CH" });
  const ai = await recordAiDraft(ctx, {
    docId, locale: "de-CH", fields: { title: "Grüezi 2" }, sourceVersion: 2, sourceHashes: hashes, provenance: [prov("title")],
  });
  expect(ai).toHaveProperty("version");
  expect(await approveClean(ctx)).toMatchObject({ approved: 1 });
  await publishRelease(ctx, { releaseId, allowStale: true });
  const [rel] = await sql`select published_at from releases where id = ${releaseId}`;
  expect(rel!.published_at).not.toBeNull();
}));

// ---- structure: the guard stays the first statement of exactly the guarded functions ---------------------

test("structure: assertLicensed is the first statement of each guarded public function and absent elsewhere", () => {
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  /** Text of a top-level function: from its header to the next top-level declaration or doc comment. */
  const fnText = (file: string, name: string) => {
    const text = src(file);
    const start = text.search(new RegExp(`\\n(export )?(async )?function ${name}\\(`));
    expect(start, `${file}: function ${name}`).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n(export |async |function |\/\*\*|const |type )/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };
  /** First non-blank line after the line that opens the body (the first line ending in "{"). */
  const firstStatement = (body: string) => {
    const lines = body.split("\n");
    const open = lines.findIndex((l) => l.trimEnd().endsWith("{"));
    return lines.slice(open + 1).find((l) => l.trim() !== "")!.trim();
  };
  const guarded: Array<[string, string]> = [
    ["documents/saveDraft.ts", "saveDraft"],
    ["documents/recordAiDraft.ts", "recordAiDraft"],
    ["documents/approve.ts", "approve"],
    ["documents/approve.ts", "approveClean"],
    ["documents/publish.ts", "publish"],
    ["releases/releases.ts", "publishRelease"],
  ];
  for (const [file, name] of guarded) {
    expect(firstStatement(fnText(file, name)), `${name} must start with the guard`).toMatch(/^await assertLicensed\(ctx\);/);
  }
  const unguardedFns: Array<[string, string]> = [
    ["documents/approve.ts", "approveImpl"],
    ["documents/publish.ts", "unpublish"],
    ["releases/releases.ts", "createRelease"],
    ["releases/releases.ts", "addToRelease"],
  ];
  for (const [file, name] of unguardedFns) expect(fnText(file, name), name).not.toContain("assertLicensed");
  const count = (file: string) => src(file).split("assertLicensed(").length - 1;
  expect(count("documents/approve.ts")).toBe(2);
  expect(count("documents/publish.ts")).toBe(1);
  expect(count("releases/releases.ts")).toBe(1);
  for (const file of ["documents/create.ts", "documents/publishCore.ts", "sync/state.ts", "read/resolve.ts", "read/query.ts"]) {
    expect(src(file), file).not.toContain("assertLicensed");
  }
});
