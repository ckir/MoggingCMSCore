import { expect, test } from "vitest";
import * as api from "../src/index.js";
import * as pkg from "@mogging/core";
import type { Ctx, DocumentRecord, DraftHead, DraftReview, Field, ReviewField, ReviewMissing, LicencePayload, MoggingConfig, ReleaseSummary, Snapshot, PublishedVersion } from "../src/index.js";

// THE CONTRACT: this is the complete runtime surface of @mogging/core (spec 9.3). Adding or removing an
// export must be a deliberate edit here; a leaked internal (encodeKey, stripTopLevelNulls, isEmptyValue,
// PUBLIC_KEYS, publishWithinTx, resolveLocale, ...) fails the exact-surface test.
const FUNCTIONS = [
  "defineConfig", "defineCollection",
  "text", "richText", "number", "boolean", "dateTime", "slug", "json", "reference", "list", "object",
  "normalizeLocale", "chainFor", "migrate",
  "createDocument", "deleteDocument", "getDocument", "getDocuments", "listDocuments", "listPublishedVersions", "listLocaleRows",
  "saveDraft", "publish", "unpublish", "recordAiDraft", "approve", "approveClean",
  "resolve", "resolveReference", "getSyncState", "trackFields",
  "createRelease", "addToRelease", "removeFromRelease", "publishRelease",
  "rejectDraft", "listDraftHeads", "getDraftReview", "listReleases",
  "hashValue", "normalizeValue", "verifyKey", "getLicenceState", "assertLicensed",
];
const ERROR_CLASSES = [
  "MoggingError", "ValidationError", "ConflictError", "NotPublishableError", "StaleReleaseError", "NotFoundError",
  "LicenceError",
];
const EXPECTED = [...FUNCTIONS, ...ERROR_CLASSES].sort();

for (const [label, mod] of [["relative", api], ["package self-reference", pkg]] as const) {
  test(`${label}: every function is exported as a function`, () => {
    for (const name of FUNCTIONS) expect(typeof (mod as Record<string, unknown>)[name], name).toBe("function");
  });

  test(`${label}: every error class extends MoggingError`, () => {
    const m = mod as unknown as Record<string, new (...a: string[]) => Error>;
    for (const name of ERROR_CLASSES) {
      const err = name === "LicenceError" ? new m[name]!("LICENCE_INVALID", "m") : new m[name]!("m");
      expect(err, name).toBeInstanceOf(mod.MoggingError);
      expect(err.name).toBe(name);
    }
  });

  test(`${label}: the runtime surface is exactly the contract`, () => {
    expect(Object.keys(mod).sort()).toEqual(EXPECTED);
  });
}

test("the listed types are importable and usable", () => {
  const config: MoggingConfig = api.defineConfig({
    collections: [api.defineCollection("pages", { body: api.richText({ localized: true, body: true }) })],
    locales: { source: "en", chains: {} },
  });
  const field: Field = api.text();
  const payload: LicencePayload | undefined = undefined;
  const snap: Pick<Snapshot, "version"> = { version: 1 };
  const rec: Pick<DocumentRecord, "collection"> = { collection: "pages" };
  const ctxShape: Pick<Ctx, "actor"> = { actor: "a" };
  const pv: Pick<PublishedVersion, "version"> = { version: 3 };
  const head: Pick<DraftHead, "warningCount"> = { warningCount: 0 };
  const review: Pick<DraftReview, "fields" | "missing"> = { fields: [], missing: [] };
  const reviewField: Pick<ReviewField, "path"> = { path: "title" };
  const missing: Pick<ReviewMissing, "path"> = { path: "price" };
  expect([config.collections.length, field.kind, payload, snap.version, rec.collection, ctxShape.actor, pv.version])
    .toEqual([1, "text", undefined, 1, "pages", "a", 3]);
  const release: Pick<ReleaseSummary, "name" | "itemCount" | "publishedAt"> = { name: "r", itemCount: 0, publishedAt: null };
  expect([head.warningCount, review.fields.length, reviewField.path, review.missing.length, missing.path]).toEqual([0, 0, "title", 0, "price"]);
  expect([release.name, release.itemCount, release.publishedAt]).toEqual(["r", 0, null]);
});
