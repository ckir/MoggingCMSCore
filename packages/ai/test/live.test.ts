import { expect, test } from "vitest";
import { compile } from "../src/compile.js";
import { defineAiConfig } from "../src/config.js";
import { listProvenance } from "../src/provenance.js";
import { config, migrateAndSeed } from "./fixtures.js";
import { withTestDb } from "./db.js";

// A smoke test against the real provider. It runs only when MOGGING_LIVE and OPENROUTER_API_KEY are both set.
// The key is read only by the provider (createOpenRouter via resolveModel), exactly as in production: this file
// never prints, logs, stores or passes it anywhere.
test.skipIf(!process.env.MOGGING_LIVE || !process.env.OPENROUTER_API_KEY)(
  "live: openai/gpt-4o-mini translates the seeded document, or validation rejects it",
  async () => withTestDb(async (sql) => {
    const docId = await migrateAndSeed(sql);
    const ai = defineAiConfig({
      provider: { kind: "openrouter" },
      models: { translate: "openai/gpt-4o-mini" },
      prices: { "openai/gpt-4o-mini": { inputUsdPerMtok: 0.15, outputUsdPerMtok: 0.6, contextTokens: 128000 } },
      budgets: { monthlyCapUsd: 1 },
    });
    const ctx = { sql, config, actor: "live", ai };
    const report = await compile(ctx, { locales: ["de"], budgetUsd: 0.05 });
    expect(report.enqueue.enqueued).toBe(1);

    const [job] = await sql`select state from ai_jobs where doc_id = ${docId} and locale = 'de'`;
    // The spike measured about 10 percent validation rejections for this model, so FAILED is an accepted outcome.
    expect(["COMPLETED", "FAILED"]).toContain(job!.state);
    const rows = await listProvenance(ctx, { docId, locale: "de" });
    expect(rows.length).toBeGreaterThan(0);
    if (job!.state === "COMPLETED") {
      expect(rows.some((r) => !r.discarded)).toBe(true);
    } else {
      expect(rows.every((r) => r.discarded && r.discardReason?.startsWith("validation:"))).toBe(true);
    }
    const micros = rows.reduce((n, r) => n + r.costMicros, 0);
    expect(micros).toBeGreaterThan(0);
    expect(micros).toBeLessThan(2000);
  }),
  120_000,
);
