// The public API of @mogging/core (spec 9.3). Every export is named on purpose: test/api.test.ts pins
// this surface exactly, so a new export (or a leaked internal) is a deliberate, visible change.

export {
  MoggingError, ValidationError, ConflictError, NotPublishableError, StaleReleaseError, NotFoundError, LicenceError,
} from "./errors.js";
export type { LicenceErrorCode } from "./errors.js";

export { text, richText, number, boolean, dateTime, slug, reference, list, object } from "./schema/fields.js";
export type { Field, FieldOptions } from "./schema/fields.js";
export { defineCollection } from "./schema/collection.js";
export type { Collection } from "./schema/collection.js";
export { defineConfig, chainFor } from "./schema/config.js";
export type { MoggingConfig } from "./schema/config.js";
export { normalizeLocale } from "./schema/locale.js";

export { normalizeValue } from "./values/normalize.js";
export { hashValue } from "./values/hash.js";
export type { Ctx } from "./ctx.js";
export { migrate } from "./migrate.js";

export { createDocument, deleteDocument } from "./documents/create.js";
export { saveDraft } from "./documents/saveDraft.js";
export type { SaveDraftInput } from "./documents/saveDraft.js";
export { publish, unpublish } from "./documents/publish.js";
export type { PublishInput, UnpublishInput } from "./documents/publish.js";
export { recordAiDraft } from "./documents/recordAiDraft.js";
export type { AiProvenanceInput, RecordAiDraftInput, RecordAiDraftResult } from "./documents/recordAiDraft.js";
export { rejectDraft } from "./documents/rejectDraft.js";
export { approve, approveClean } from "./documents/approve.js";
export type { ApproveInput, ApproveCleanInput, ApproveCleanResult } from "./documents/approve.js";

export { resolve, resolveReference, getDocument, listDocuments } from "./read/resolve.js";
export type { ResolveInput, ResolvedDocument, Snapshot, HeadPair, DocumentRecord } from "./read/resolve.js";
export { listDraftHeads, getDraftReview } from "./read/review.js";
export type { DraftHead, DraftReview, ReviewField } from "./read/review.js";

export { getSyncState, trackFields } from "./sync/state.js";
export type { SyncStateKind, SyncStateRow, SyncStateInput, TrackFieldsInput } from "./sync/state.js";

export { createRelease, addToRelease, publishRelease, listReleases } from "./releases/releases.js";
export type {
  CreateReleaseInput, AddToReleaseInput, PublishReleaseInput, ReleaseSummary, StaleReleaseItem, StaleReleaseErrorWithItems,
} from "./releases/releases.js";

export { verifyKey } from "./licence/key.js";
export type { LicencePayload } from "./licence/key.js";
export { getLicenceState, assertLicensed } from "./licence/guard.js";
export type { LicenceState } from "./licence/guard.js";
