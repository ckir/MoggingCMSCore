import { expect, test } from "vitest";
import * as api from "../src/index.js";
import * as pkg from "@mogging/core";
import type { Ctx, DocumentRecord, DraftHead, DraftReview, Field, ReviewField, LicencePayload, MoggingConfig, Snapshot } from "../src/index.js";

// THE CONTRACT: this is the complete runtime surface of @mogging/core (spec 9.3). Adding or removing an
// export must be a deliberate edit here; a leaked internal (encodeKey, stripTopLevelNulls, isEmptyValue,
// PUBLIC_KEYS, publishWithinTx, resolveLocale, ...) fails the exact-surface test.
const FUNCTIONS = [
  "defineConfig", "defineCollection",
  "text", "richText", "number", "boolean", "dateTime", "slug", "reference", "list", "object",
  "normalizeLocale", "chainFor", "migrate",
  "createDocument", "deleteDocument", "getDocument", "listDocuments",
  "saveDraft", "publish", "unpublish", "recordAiDraft", "approve", "approveClean",
  "resolve", "resolveReference", "getSyncState", "trackFields",
  "createRelease", "addToRelease", "publishRelease",
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
  const head: Pick<DraftHead, "warningCount"> = { warningCount: 0 };
  const review: Pick<DraftReview, "fields"> = { fields: [] };
  const reviewField: Pick<ReviewField, "path"> = { path: "title" };
  expect([config.collections.length, field.kind, payload, snap.version, rec.collection, ctxShape.actor])
    .toEqual([1, "text", undefined, 1, "pages", "a"]);
  expect([head.warningCount, review.fields.length, reviewField.path]).toEqual([0, 0, "title"]);
});
