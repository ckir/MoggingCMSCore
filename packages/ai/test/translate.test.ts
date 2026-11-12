import { afterEach, describe, expect, test, vi } from "vitest";
import { APICallError } from "ai";
import type { MockLanguageModelV3 } from "ai/test";
import type { Sql } from "postgres";
import { ValidationError, defineCollection, text, type Collection, type DocumentRecord, type Snapshot } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { defineAiConfig, type AiConfigInput, type AiCtx } from "../src/config.js";
import { actualCostMicros, charsPerToken, fieldTokens } from "../src/estimate.js";
import { buildPrompt, maxTemplateTokens } from "../src/prompt.js";
import { prepareField, type GlossaryEntry } from "../src/validate.js";
import { resolveModel } from "../src/providers.js";
import { translateJob, type TranslateOutcome } from "../src/translate.js";
import type { CallCost } from "../src/claim.js";
import type { JobRow } from "../src/jobs.js";
import { config, ctxFor, docFixture, jobFixture } from "./fixtures.js";
import { RawResult, dataOf, identity, messagesOf, mockModel, type MockCallOptions, type MockOutput } from "./mockModel.js";

// No test here touches the database: any use of `sql` fails loudly.
const noSql = new Proxy(() => undefined, {
  get(_t, p) { throw new Error(`translateJob touched ctx.sql (.${String(p)})`); },
  apply() { throw new Error("translateJob touched ctx.sql (called)"); },
}) as unknown as Sql;

const posts = config.collections.find((c) => c.name === "posts")! as Collection;

const head = (data: Record<string, unknown>, over: Partial<Snapshot> = {}): Snapshot => ({
  version: 1, state: "PUBLISHED", data, sourceHashes: {}, createdAt: new Date(0), createdBy: "seed",
  publishedAt: new Date(0), publishedBy: "seed", ...over,
});

const SOURCE = docFixture().locales.en!.published!.data;
const withSource = (data: Record<string, unknown>, rest: DocumentRecord["locales"] = {}): DocumentRecord =>
  docFixture({ locales: { en: { published: head(data), draft: null }, ...rest } });

const glossaryEntry = (over: Partial<GlossaryEntry> & { term: string }): GlossaryEntry => ({
  sourceLocale: "en", targetLocale: "de", translation: null, acceptedForms: [], doNotTranslate: false, note: null, ...over,
});

type Run = {
  outcome: TranslateOutcome; model: MockLanguageModelV3; ctx: AiCtx; onCall: CallCost[]; signals: number;
};

async function run(outputs: MockOutput[], opts: {
  ai?: Partial<AiConfigInput>; doc?: DocumentRecord; job?: JobRow; glossary?: GlossaryEntry[];
  beforeCall?: () => Promise<boolean>;
} = {}): Promise<Run> {
  const model = mockModel(outputs);
  const ctx = ctxFor(noSql, model, opts.ai);
  const onCall: CallCost[] = [];
  let signals = 0;
  const outcome = await translateJob(ctx, {
    job: opts.job ?? jobFixture(), collection: posts, doc: opts.doc ?? docFixture(), glossary: opts.glossary ?? [],
    model: resolveModel(ctx.ai, "posts"),
    signalFor: () => { signals += 1; return new AbortController().signal; },
    onCall: (c) => onCall.push(c),
    ...(opts.beforeCall ? { beforeCall: opts.beforeCall } : {}),
  });
  return { outcome, model, ctx, onCall, signals };
}

const PRICE = { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 8000 };
const prices = (contextTokens: number) => ({ "mock/translate": { ...PRICE, contextTokens } });

/** An identity translation with the first sentinel of `body` dropped. */
const dropSentinel = (o: MockCallOptions): unknown => {
  const t = dataOf(o).translate;
  return { fields: { ...t, body: String(t.body).replace("⟦MOGGING:0⟧", "") }, glossaryTermsUsed: [] };
};

const USAGE_UNDEFINED = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** Measured shape of the default docFixture request (no target heads, no glossary): the payload JSON overhead. */
const EMPTY_PAYLOAD_CHARS = JSON.stringify({ siblings: {}, shared: {}, glossary: [] }, null, 1).length;

const wireTokens = (name: string, value: unknown): number =>
  fieldTokens(prepareField(name, posts.fields[name]!, value).wire, "en", "de");

function expectOk(o: TranslateOutcome): asserts o is Extract<TranslateOutcome, { ok: true }> {
  if (!o.ok) throw new Error(`expected ok, got ${JSON.stringify(o)}`);
}
function expectNotOk<K extends "failed" | "retry" | "cancel">(o: TranslateOutcome, kind: K): asserts o is Extract<TranslateOutcome, { kind: K }> {
  if (o.ok || o.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(o)}`);
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("translateJob", () => {
  test("an identity translation returns ok with every field, one kept call and per-field rows sharing its call id", async () => {
    const { outcome, ctx, onCall, signals } = await run([identity]);
    expectOk(outcome);
    expect(outcome.fields).toEqual({ title: SOURCE.title, body: SOURCE.body, legal: SOURCE.legal, tags: SOURCE.tags });
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls).toMatchObject([{ kept: true, promptTokens: 100, completionTokens: 50 }]);
    const call = outcome.calls[0]!;
    const price = ctx.ai.prices["mock/translate"]!;
    expect(call.costMicros).toBe(actualCostMicros({ inputTokens: 100, outputTokens: 50 }, price));
    expect(call).toMatchObject({ modelId: "mock/translate", promptVersion: "translate.v1.standard" });
    expect(call.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.perField.map((p) => p.fieldPath)).toEqual(["title", "body", "legal", "tags"]);
    for (const p of outcome.perField) {
      expect(p).toMatchObject({ callId: call.callId, modelId: "mock/translate", promptVersion: "translate.v1.standard", jobId: 1 });
    }
    // Apportioned by translate characters: the per-field rows sum to the call's totals.
    const sum = (k: "promptTokens" | "completionTokens" | "costMicros") => outcome.perField.reduce((n, p) => n + p[k], 0);
    expect([sum("promptTokens"), sum("completionTokens"), sum("costMicros")]).toEqual([100, 50, call.costMicros]);
    const body = outcome.perField.find((p) => p.fieldPath === "body")!;
    const title = outcome.perField.find((p) => p.fieldPath === "title")!;
    expect(body.promptTokens).toBeGreaterThan(title.promptTokens);
    expect(onCall).toEqual(outcome.calls);
    expect(signals).toBe(1);
  });

  test("content never enters the system prompt, the user message is delimited and carries the glossary", async () => {
    const doc = withSource({
      title: "UNIQUE-TITLE-1101", body: markdownToTree("UNIQUE-BODY-2202 `x`\n"), legal: "UNIQUE-LEGAL-3303",
      tags: ["UNIQUE-TAG-4404"], price: 5,
    });
    const { outcome, model, ctx } = await run([identity], {
      doc, glossary: [glossaryEntry({ term: "UNIQUE-TERM-5505", translation: "Begriff" })],
    });
    expectOk(outcome);
    const { system, user } = messagesOf(model.doGenerateCalls[0]!);
    for (const s of ["UNIQUE-TITLE-1101", "UNIQUE-BODY-2202", "UNIQUE-LEGAL-3303", "UNIQUE-TAG-4404", "UNIQUE-TERM-5505"]) {
      expect(system).not.toContain(s);
    }
    expect(user.startsWith("<<<DATA")).toBe(true);
    expect(user.endsWith("DATA>>>")).toBe(true);
    expect(user).toContain("UNIQUE-TERM-5505");
    expect(dataOf(model.doGenerateCalls[0]!).glossary).toEqual([{ term: "UNIQUE-TERM-5505", translation: "Begriff", doNotTranslate: false }]);
    // The call settings: temperature from config, the request's output ceiling.
    expect(model.doGenerateCalls[0]!.temperature).toBe(ctx.ai.temperature);
  });

  test("siblings are the target's other translatable fields, shared the translatable shared values", async () => {
    const withBrand = defineCollection("posts", { ...posts.fields, brand: text() }) as Collection;
    const doc = docFixture({
      shared: { published: head({ slug: "hello", brand: "Acme" }), draft: null },
      locales: {
        ...docFixture().locales,
        de: { published: head({ title: "Hallo", legal: "Es gelten Bedingungen", price: 6 }), draft: head({ title: "Hallo!", legal: "AGB", price: 7 }, { state: "DRAFT_AI" }) },
      },
    });
    const model = mockModel([identity]);
    const ctx = ctxFor(noSql, model);
    const outcome = await translateJob(ctx, {
      job: jobFixture({ fieldPaths: ["title", "body"] }), collection: withBrand, doc, glossary: [],
      model: resolveModel(ctx.ai, "posts"), signalFor: () => new AbortController().signal,
    });
    expectOk(outcome);
    const data = dataOf(model.doGenerateCalls[0]!);
    expect(Object.keys(data.translate)).toEqual(["title", "body"]);
    // From the draft head (draft ?? published), job fields and non-text kinds left out.
    expect(data.siblings).toEqual({ legal: "AGB" });
    expect(data.shared).toEqual({ brand: "Acme" });
  });

  test("a rejected draft is retried with the strict variant, then fails", async () => {
    const { outcome, model } = await run([dropSentinel, dropSentinel]);
    expectNotOk(outcome, "failed");
    expect(outcome.calls).toHaveLength(2);
    expect(outcome.calls.map((c) => c.kept)).toEqual([false, false]);
    expect(outcome.calls.map((c) => c.promptVersion)).toEqual(["translate.v1.standard", "translate.v1.strict"]);
    expect(outcome.calls[0]!.discardReason).toMatch(/^validation: body: restore SENTINEL_MISSING/);
    expect(outcome.reason).toMatch(/^body: restore SENTINEL_MISSING/);
    const strict = buildPrompt("strict", { sourceLocale: "en", targetLocale: "de", collection: "posts", translate: {}, siblings: {}, shared: {}, glossary: [] });
    expect(messagesOf(model.doGenerateCalls[1]!).system).toBe(strict.system);
    // The strict retry covers the SAME request.
    expect(Object.keys(dataOf(model.doGenerateCalls[1]!).translate)).toEqual(["title", "body", "legal", "tags"]);
  });

  test("a strict retry that passes is kept", async () => {
    const { outcome } = await run([dropSentinel, identity]);
    expectOk(outcome);
    expect(outcome.calls.map((c) => c.kept)).toEqual([false, true]);
    expect(outcome.calls[1]!.promptVersion).toBe("translate.v1.strict");
    for (const p of outcome.perField) {
      expect(p.callId).toBe(outcome.calls[1]!.callId);
      expect(p.promptVersion).toBe("translate.v1.strict");
    }
    expect(outcome.fields.body).toEqual(SOURCE.body);
  });

  const hello = [glossaryEntry({ term: "Hello", translation: "Hallo" })];

  test("glossary warnings land on the field's provenance input", async () => {
    const { outcome } = await run([identity], { glossary: hello });
    expectOk(outcome);
    const w = Object.fromEntries(outcome.perField.map((p) => [p.fieldPath, p.warnings]));
    expect(w.title).toEqual(['glossary: "Hello" expected "Hallo"']);
    expect(w.body).toEqual(['glossary: "Hello" expected "Hallo"']);
    expect(w.legal).toEqual([]);
    expect(w.tags).toEqual([]);
  });

  test("strict glossary rejects", async () => {
    const { outcome } = await run([identity, identity], { glossary: hello, ai: { glossary: "strict" } });
    expectNotOk(outcome, "failed");
    expect(outcome.calls).toHaveLength(2);
    expect(outcome.reason).toContain('title: glossary: "Hello" expected "Hallo"');
  });

  test("a per-collection glossary override wins", async () => {
    const strict = await run([identity, identity], {
      glossary: hello, ai: { glossary: "warn", collections: { posts: { glossary: "strict" } } },
    });
    expectNotOk(strict.outcome, "failed");
    const warn = await run([identity], {
      glossary: hello, ai: { glossary: "strict", collections: { posts: { glossary: "warn" } } },
    });
    expectOk(warn.outcome);
    expect(warn.outcome.perField.find((p) => p.fieldPath === "title")!.warnings).toEqual(['glossary: "Hello" expected "Hallo"']);
  });

  test("an output that does not match the schema is a recorded rejection, then retried", async () => {
    const { outcome } = await run([{ nope: 1 }, identity]);
    expectOk(outcome);
    expect(outcome.calls).toHaveLength(2);
    // Measured: generateText rejects with NoObjectGeneratedError carrying the call's usage.
    expect(outcome.calls[0]).toMatchObject({ kept: false, promptTokens: 100, completionTokens: 50 });
    expect(outcome.calls[0]!.discardReason).toMatch(/^output: NoObjectGeneratedError: /);
    expect(outcome.calls[1]).toMatchObject({ kept: true, promptVersion: "translate.v1.strict" });
  });

  test("a length-truncated empty output is a recorded rejection", async () => {
    const truncated = new RawResult({ content: [], finishReason: { unified: "length", raw: "length" } });
    const { outcome } = await run([truncated, truncated]);
    expectNotOk(outcome, "failed");
    expect(outcome.calls).toHaveLength(2);
    for (const c of outcome.calls) {
      expect(c).toMatchObject({ kept: false, promptTokens: 100, completionTokens: 50 });
      expect(c.discardReason).toMatch(/^output:/);
    }
    expect(outcome.reason).toBe("output: NoOutputGeneratedError");
  });

  test("undefined usage counts as zero and warns", async () => {
    const { outcome } = await run([
      (o: MockCallOptions) => new RawResult({ content: [{ type: "text", text: JSON.stringify(identity(o)) }], usage: USAGE_UNDEFINED }),
    ]);
    expectOk(outcome);
    expect(outcome.calls[0]).toMatchObject({ costMicros: 0, promptTokens: 0, completionTokens: 0 });
    expect(outcome.warnings).toContain("usage: inputTokens not reported");
    for (const p of outcome.perField) {
      expect(p.costMicros).toBe(0);
      expect(p.warnings).toContain("usage: inputTokens not reported");
    }
  });

  test("a provider-reported cost wins over tokens x price", async () => {
    const { outcome } = await run([
      (o: MockCallOptions) => new RawResult({
        content: [{ type: "text", text: JSON.stringify(identity(o)) }],
        providerMetadata: { openrouter: { usage: { cost: 0.001234 } } },
      }),
    ]);
    expectOk(outcome);
    expect(outcome.calls[0]!.costMicros).toBe(1234);
    expect(outcome.perField.reduce((n, p) => n + p.costMicros, 0)).toBe(1234);
  });

  test("an oversized field is split into its own request", async () => {
    const body = wireTokens("body", SOURCE.body);
    const others = Math.max(...(["title", "legal", "tags"] as const).map((f) => wireTokens(f, SOURCE[f])));
    expect(body).toBeGreaterThan(others + 1); // precondition: a limit fits between them
    const { outcome, model } = await run([identity, identity], { ai: { perFieldTokenLimit: others } });
    expectOk(outcome);
    expect(outcome.calls).toHaveLength(2);
    expect(outcome.calls.map((c) => c.kept)).toEqual([true, true]);
    const sent = model.doGenerateCalls.map((c) => Object.keys(dataOf(c).translate));
    expect(sent).toEqual([["title", "legal", "tags"], ["body"]]);
    for (const p of outcome.perField) {
      const i = sent.findIndex((fields) => fields.includes(p.fieldPath));
      expect(p.callId).toBe(outcome.calls[i]!.callId);
    }
    // Each call's per-field rows sum to that call's totals.
    for (const c of outcome.calls) {
      expect(outcome.perField.filter((p) => p.callId === c.callId).reduce((n, p) => n + p.promptTokens, 0)).toBe(c.promptTokens);
    }
  });

  test("a field that fits only without context gets a noContext request", async () => {
    // Brief numbers adjusted to the real template: maxTemplateTokens() is 1520, so with contextTokens 4096 a 3000
    // character body (T 1001, reserve 1814) does not fit even alone (1001 + 1814 + 1520 > 4096). contextTokens 5000
    // keeps the brief's intent: T + reserve + template + glossary fits, the ~1350 context tokens beside them do not.
    const bodyMd = "a".repeat(2999); // serializes with a trailing newline: 3003 wire characters, T 1001
    const doc = withSource({ ...SOURCE, body: markdownToTree(bodyMd) }, {
      de: { published: head({ title: "t".repeat(2000), legal: "l".repeat(2000) }), draft: null },
    });
    const job = jobFixture({ fieldPaths: ["body"] });
    const glossary = [glossaryEntry({ term: "Hello", translation: "Hallo" })];
    const t = wireTokens("body", markdownToTree(bodyMd));
    expect(t).toBe(1001);
    const reserve = Math.ceil((t * 13) / 10) + 512;
    expect(reserve).toBe(1814);
    const glossaryTokens = Math.ceil(JSON.stringify({ siblings: {}, shared: {}, glossary: [{ term: "Hello", translation: "Hallo", doNotTranslate: false }] }, null, 1).length / charsPerToken("en", "de"));
    expect(t + reserve + maxTemplateTokens() + glossaryTokens).toBeLessThanOrEqual(5000);
    expect(t + reserve + maxTemplateTokens() + 1300).toBeGreaterThan(5000);

    const { outcome, model } = await run([identity], { doc, job, glossary, ai: { prices: prices(5000) } });
    expectOk(outcome);
    const data = dataOf(model.doGenerateCalls[0]!);
    expect(data.siblings).toEqual({});
    expect(data.shared).toEqual({});
    expect(data.glossary).toEqual([{ term: "Hello", translation: "Hallo", doNotTranslate: false }]);

    // Control: with room for the context, the same job sends the siblings.
    const roomy = await run([identity], { doc, job, glossary, ai: { prices: prices(8000) } });
    expectOk(roomy.outcome);
    expect(Object.keys(dataOf(roomy.model.doGenerateCalls[0]!).siblings)).toEqual(["title", "legal"]);
  });

  test("a field larger than the context window fails naming the field before any call", async () => {
    const doc = withSource({ ...SOURCE, body: markdownToTree("b".repeat(30000)) });
    const { outcome, model } = await run([identity], { doc, ai: { prices: prices(4096) } });
    expectNotOk(outcome, "failed");
    expect(outcome.reason).toBe('field "body" exceeds the model context window');
    expect(outcome.calls).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("a source that already contains a sentinel token fails without a call", async () => {
    const doc = withSource({ ...SOURCE, body: markdownToTree("Hello ⟦MOGGING:0⟧\n") });
    const { outcome, model } = await run([identity], { doc });
    expectNotOk(outcome, "failed");
    expect(outcome.reason).toMatch(/^source: source already contains a sentinel token/);
    expect(outcome.calls).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("a deleted document fails without a call", async () => {
    const { outcome, model } = await run([identity], { doc: docFixture({ deletedAt: new Date() }) });
    expect(outcome).toEqual({ ok: false, kind: "failed", reason: "document deleted", calls: [] });
    expect(model.doGenerateCalls).toHaveLength(0);
    // Order: deleted is checked before the source version.
    const both = await run([identity], { doc: docFixture({ deletedAt: new Date() }), job: jobFixture({ sourceVersion: 2 }) });
    expect(both.outcome).toMatchObject({ kind: "failed", reason: "document deleted" });
  });

  test("a moved source cancels without a call", async () => {
    const { outcome, model } = await run([identity], { job: jobFixture({ sourceVersion: 2 }) });
    expect(outcome).toEqual({ ok: false, kind: "cancel", code: "SOURCE_MOVED", calls: [] });
    expect(model.doGenerateCalls).toHaveLength(0);
    const unpublished = await run([identity], { doc: docFixture({ locales: { en: { published: null, draft: null } } }) });
    expect(unpublished.outcome).toEqual({ ok: false, kind: "cancel", code: "SOURCE_MOVED", calls: [] });
  });

  test("a human draft head cancels without a call", async () => {
    const human = { de: { published: null, draft: head({ title: "Hallo" }, { state: "DRAFT_HUMAN", publishedAt: null, publishedBy: null }) } };
    const { outcome, model } = await run([identity], { doc: withSource(SOURCE, human) });
    expect(outcome).toEqual({ ok: false, kind: "cancel", code: "DRAFT_HUMAN", calls: [] });
    expect(model.doGenerateCalls).toHaveLength(0);
    // Order: the source version first, then the human draft, then the source fields.
    const moved = await run([identity], { doc: withSource(SOURCE, human), job: jobFixture({ sourceVersion: 2 }) });
    expect(moved.outcome).toMatchObject({ kind: "cancel", code: "SOURCE_MOVED" });
    const sentinel = await run([identity], { doc: withSource({ ...SOURCE, body: markdownToTree("x ⟦MOGGING:0⟧\n") }, human) });
    expect(sentinel.outcome).toMatchObject({ kind: "cancel", code: "DRAFT_HUMAN" });
  });

  test("maxOutputTokens sent is the configured ceiling bounded by the window", async () => {
    const capped = await run([identity], { ai: { maxOutputTokens: 4000, prices: prices(8000) } });
    expectOk(capped.outcome);
    expect(capped.model.doGenerateCalls[0]!.maxOutputTokens).toBe(4000);

    // Brief said contextTokens 2048, but with the 1520-token template the fixture's request does not fit in 2048
    // (the planner reports the title too large); 2400 keeps the window, not the 12000 default, as the bound.
    const inputTokens = (["title", "body", "legal", "tags"] as const).reduce((n, f) => n + wireTokens(f, SOURCE[f]), 0)
      + Math.ceil(EMPTY_PAYLOAD_CHARS / 3) + maxTemplateTokens();
    const windowed = await run([identity], { ai: { prices: prices(2400) } });
    expectOk(windowed.outcome);
    expect(2400 - inputTokens).toBeLessThan(12000);
    expect(windowed.model.doGenerateCalls[0]!.maxOutputTokens).toBe(2400 - inputTokens);
  });

  test("a false beforeCall result stops before the call", async () => {
    const { outcome, model } = await run([identity], { beforeCall: async () => false });
    expectNotOk(outcome, "retry");
    expect(outcome.reason).toBe("lease check failed: lease lost before call");
    expect(outcome.calls).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("a throwing beforeCall is the same retry, not a throw", async () => {
    const { outcome, model } = await run([identity], { beforeCall: async () => { throw new Error("db down"); } });
    expectNotOk(outcome, "retry");
    expect(outcome.reason).toBe("lease check failed: db down");
    expect(outcome.calls).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("beforeCall runs before every call and a later false keeps the calls so far", async () => {
    const answers = [true, false];
    const { outcome, model } = await run([identity, identity], {
      ai: { perFieldTokenLimit: 1 }, beforeCall: async () => answers.shift() ?? false,
    });
    expectNotOk(outcome, "retry");
    expect(outcome.reason).toBe("lease check failed: lease lost before call");
    expect(outcome.calls).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("an aborted signal yields retry with the calls so far", async () => {
    const abort = new DOMException("This operation was aborted", "AbortError");
    const { outcome, model, signals } = await run([identity, abort, identity, identity], { ai: { perFieldTokenLimit: 1 } });
    expectNotOk(outcome, "retry");
    expect(outcome.reason).toContain("aborted");
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.kept).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(signals).toBe(2);
  });

  test("an unexpected throw after a paid call yields retry with that call", async () => {
    const { outcome } = await run([identity, new TypeError("boom")], { ai: { perFieldTokenLimit: 1 } });
    expectNotOk(outcome, "retry");
    expect(outcome.reason).toBe("boom");
    expect(outcome.calls).toHaveLength(1);
  });

  test("a retryable provider error is not retried by the SDK (maxRetries 0)", async () => {
    const err = new APICallError({ message: "overloaded", url: "http://x", requestBodyValues: {}, isRetryable: true, statusCode: 529 });
    const { outcome, model } = await run([err, identity, identity]);
    expectNotOk(outcome, "retry");
    expect(outcome.calls).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe("resolveModel", () => {
  test("custom: the collection override, else the default model, with its price", () => {
    const a = mockModel([]);
    const b = mockModel([]);
    const ai = defineAiConfig({
      provider: { kind: "custom", models: { "m/a": a, "m/b": b } },
      models: { translate: "m/a" },
      prices: { "m/a": PRICE, "m/b": { ...PRICE, inputUsdPerMtok: 7 } },
      budgets: { monthlyCapUsd: 1 },
      collections: { docs: { translate: "m/b" } },
    });
    expect(resolveModel(ai, "posts")).toEqual({ model: a, modelId: "m/a", price: PRICE });
    expect(resolveModel(ai, "docs")).toEqual({ model: b, modelId: "m/b", price: { ...PRICE, inputUsdPerMtok: 7 } });
  });

  const openrouter = (apiKeyEnv: string) => defineAiConfig({
    provider: { kind: "openrouter", apiKeyEnv },
    models: { translate: "vendor/model" },
    prices: { "vendor/model": PRICE },
    budgets: { monthlyCapUsd: 1 },
  });

  test("openrouter provider without the key variable throws ValidationError naming the variable", () => {
    vi.stubEnv("MOGGING_TEST_UNSET_KEY", undefined);
    expect(() => resolveModel(openrouter("MOGGING_TEST_UNSET_KEY"), "posts")).toThrow(ValidationError);
    expect(() => resolveModel(openrouter("MOGGING_TEST_UNSET_KEY"), "posts")).toThrow("MOGGING_TEST_UNSET_KEY is not set");
  });

  test("openrouter provider with the key variable builds the model without a call", () => {
    vi.stubEnv("MOGGING_TEST_DUMMY_KEY", "dummy-not-a-key");
    const r = resolveModel(openrouter("MOGGING_TEST_DUMMY_KEY"), "posts");
    expect(r.modelId).toBe("vendor/model");
    expect(r.price).toEqual(PRICE);
    expect((r.model as { modelId: string }).modelId).toBe("vendor/model");
  });
});
