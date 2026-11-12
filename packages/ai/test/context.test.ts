import { expect, test, vi } from "vitest";
import { approve, getDocument, publish, recordAiDraft } from "@mogging/core";
import type { JobContext } from "../src/context.js";

// Every jobContext call is recorded with its arguments and result; the real helper still does the work.
const seen = vi.hoisted(() => [] as Array<{ locale: string; fields: string[]; result: JobContext }>);
vi.mock("../src/context.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/context.js")>();
  return {
    ...real,
    jobContext: (...args: Parameters<typeof real.jobContext>) => {
      const result = real.jobContext(...args);
      seen.push({ locale: args[3], fields: [...args[4]], result });
      return result;
    },
  };
});

const { enqueueStale } = await import("../src/jobs.js");
const { runWorker } = await import("../src/worker.js");
const { upsertGlossary } = await import("../src/glossary.js");
const { ctxFor, migrateAndSeed } = await import("./fixtures.js");
const { withTestDb } = await import("./db.js");
const { dataOf, identity, mockModel } = await import("./mockModel.js");

test("the enqueue estimate and the worker derive the same context for a multi-request job", async () => withTestDb(async (sql) => {
  const docId = await migrateAndSeed(sql);
  // perFieldTokenLimit 1: every field is its own request.
  const model = mockModel([identity, identity, identity]);
  const ctx = ctxFor(sql, model, { perFieldTokenLimit: 1 });
  // A current de title (a sibling of the job's fields) and a glossary entry, so the context is not empty.
  const src = (await getDocument(ctx, { collection: "posts", docId }))!.locales.en!.published!;
  await recordAiDraft(ctx, {
    docId, locale: "de", fields: { title: "Hallo" }, sourceVersion: src.version, sourceHashes: src.sourceHashes, provenance: [],
  });
  await approve(ctx, { docId, locale: "de" });
  await publish(ctx, { docId, locale: "de" });
  await upsertGlossary(ctx, [{
    sourceLocale: "en", targetLocale: "de", term: "Terms", translation: "AGB", acceptedForms: [], doNotTranslate: false, note: null,
  }]);

  seen.length = 0;
  expect((await enqueueStale(ctx, { locales: ["de"] })).enqueued).toBe(1);
  expect(seen).toHaveLength(1);
  const estimate = seen[0]!;
  expect(await runWorker(ctx, { once: true })).toMatchObject({ completed: 1, errors: 0 });
  expect(seen).toHaveLength(2);
  const worker = seen[1]!;

  expect(worker.locale).toBe(estimate.locale);
  expect(worker.fields).toEqual(estimate.fields);
  expect(estimate.fields).toEqual(["body", "legal", "tags"]);
  expect(worker.result).toEqual(estimate.result);
  expect(estimate.result.siblings).toEqual({ title: "Hallo" });
  expect(estimate.result.glossary).toEqual([{ term: "Terms", translation: "AGB", doNotTranslate: false }]);

  // Three requests, each carrying exactly that context.
  expect(model.doGenerateCalls).toHaveLength(3);
  for (const call of model.doGenerateCalls) {
    const data = dataOf(call);
    expect({ siblings: data.siblings, shared: data.shared, glossary: data.glossary })
      .toEqual({ siblings: estimate.result.siblings, shared: estimate.result.shared, glossary: estimate.result.glossary });
  }
}));
