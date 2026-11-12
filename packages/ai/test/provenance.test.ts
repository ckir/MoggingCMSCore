import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { LanguageModel } from "ai";
import { createDocument, getDocument, publish, recordAiDraft, saveDraft } from "@mogging/core";
import { listProvenance, writeDiscardedRow } from "../src/provenance.js";
import { ctxFor, migrateAndSeed } from "./fixtures.js";
import { withTestDb } from "./db.js";

const model = {} as unknown as LanguageModel;

const discarded = (docId: string, callId: string, discardReason: string) => ({
  docId, locale: "de", jobId: null, callId, modelId: "mock/translate", promptVersion: "translate.v1.standard",
  promptTokens: 120, completionTokens: 40, costMicros: 321, discardReason,
});

test("writeDiscardedRow then listProvenance returns the row with version null, discarded true and its callId", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    const callId = randomUUID();
    await sql.begin((tx) => writeDiscardedRow(tx, discarded(docId, callId, "lease lost")));
    const rows = await listProvenance(ctx, { docId, locale: "DE" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      docId, locale: "de", version: null, fieldPath: null, jobId: null, modelId: "mock/translate",
      promptVersion: "translate.v1.standard", promptTokens: 120, completionTokens: 40, costMicros: 321, edited: false,
      discarded: true, discardReason: "lease lost", warnings: [], acknowledgedWarnings: null, bulkId: null,
      supersededVersion: null, callId, approvedBy: null, approvedAt: null,
    });
    expect(typeof rows[0]!.id).toBe("number");
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });
});

test("listProvenance without docId lists discarded rows across documents", async () => {
  await withTestDb(async (sql) => {
    const first = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    const { id: second } = await createDocument(ctx, { collection: "posts" });
    await saveDraft(ctx, { docId: second, locale: "en", data: { title: "Second" } });
    await publish(ctx, { docId: second, locale: "en" });

    // A kept AI draft row (not discarded) on the first document.
    const src = (await getDocument(ctx, { collection: "posts", docId: first }))!.locales.en!.published!;
    await recordAiDraft(ctx, {
      docId: first, locale: "de", fields: { title: "Hallo" }, sourceVersion: src.version, sourceHashes: src.sourceHashes,
      provenance: [{ fieldPath: "title", modelId: "mock/translate", promptVersion: "translate.v1.standard",
        promptTokens: 1, completionTokens: 1, costMicros: 7 }],
    });
    const a = randomUUID();
    const b = randomUUID();
    await sql.begin(async (tx) => {
      await writeDiscardedRow(tx, discarded(first, a, "validation: x"));
      await writeDiscardedRow(tx, discarded(second, b, "lease lost"));
    });

    const spend = await listProvenance(ctx, { discardedOnly: true });
    expect(spend.map((r) => [r.docId, r.callId, r.discarded])).toEqual([[first, a, true], [second, b, true]]);
    const all = await listProvenance(ctx, {});
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.discarded)).toEqual([false, true, true]); // ordered by created_at, id
    expect(await listProvenance(ctx, { docId: second })).toHaveLength(1);
    expect(await listProvenance(ctx, { limit: 1 })).toHaveLength(1);
  });
});
