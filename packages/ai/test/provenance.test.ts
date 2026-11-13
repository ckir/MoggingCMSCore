import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { LanguageModel } from "ai";
import { ValidationError, createDocument, getDocument, publish, recordAiDraft, saveDraft } from "@mogging/core";
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

test("listProvenance afterId returns the next page with no overlap", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) await sql.begin((tx) => writeDiscardedRow(tx, discarded(docId, id, "lease lost")));
    const all = await listProvenance(ctx, {});
    expect(all.map((r) => r.callId)).toEqual(ids);
    const first = await listProvenance(ctx, { limit: 2 });
    expect(first.map((r) => r.callId)).toEqual(ids.slice(0, 2));
    const next = await listProvenance(ctx, { limit: 2, afterId: first.at(-1)!.id });
    expect(next.map((r) => r.callId)).toEqual(ids.slice(2));
    expect(await listProvenance(ctx, { afterId: all.at(-1)!.id })).toEqual([]);
    await expect(listProvenance(ctx, { afterId: 1.5 })).rejects.toBeInstanceOf(ValidationError);
  });
});

test("listProvenance orders by id, so afterId is an exact page boundary even when created_at disagrees", async () => {
  await withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ctx = ctxFor(sql, model);
    // The lower id gets the LATER created_at: ordering by created_at would return the rows in descending id order.
    const [low, high] = [randomUUID(), randomUUID()];
    for (const [callId, createdAt] of [[low, "2026-01-02T00:00:00Z"], [high, "2026-01-01T00:00:00Z"]] as const) {
      await sql`insert into content_provenance
          (doc_id, locale, call_id, model_id, prompt_version, prompt_tokens, completion_tokens, cost_micros, discarded,
           discard_reason, created_at)
        values (${docId}, 'de', ${callId}, 'mock/translate', 'translate.v1.standard', 1, 1, 1, true, 'lease lost',
                ${createdAt})`;
    }
    const all = await listProvenance(ctx, {});
    expect(all.map((r) => r.callId)).toEqual([low, high]);
    expect(all[0]!.id).toBeLessThan(all[1]!.id);
    expect(all[0]!.createdAt.getTime()).toBeGreaterThan(all[1]!.createdAt.getTime());

    const first = await listProvenance(ctx, { limit: 1 });
    const second = await listProvenance(ctx, { limit: 1, afterId: first[0]!.id });
    expect([...first, ...second].map((r) => r.callId)).toEqual([low, high]);
    expect((await listProvenance(ctx, { afterId: 0 })).map((r) => r.callId)).toEqual([low, high]);
  });
});
