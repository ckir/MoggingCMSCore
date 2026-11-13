import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { upsertGlossary } from "@mogging/ai";
import { approve, hashValue, migrate, publish, recordAiDraft, saveDraft } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { reviewSpec } from "../src/commands/review.js";
import { withTestDb } from "./db.js";
import { aiDraft, coreCtx, publishedDoc, testDeps } from "./fixtures.js";

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

async function cli(sql: Sql, ...args: string[]) {
  const t = testDeps(sql);
  const code = await run(args, t);
  return { code, out: t.stdout(), err: t.stderr() };
}

const dir = mkdtempSync(join(tmpdir(), "mogging-review-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let fileCount = 0;
function tempFile(name: string, content: string): string {
  const path = join(dir, `${(fileCount += 1)}-${name}`);
  writeFileSync(path, content);
  return path;
}

const W1 = 'glossary: "Intro", expected "Einführung"'; // commas and quotes: the option must not split on commas
const W2 = "tone: too formal";

const prov = (fieldPath: string, warnings: string[] = []) => ({
  fieldPath, modelId: "m1", promptVersion: "p1", promptTokens: 10, completionTokens: 20, costMicros: 300, warnings,
});

/** A DRAFT_AI head of `fields` with one provenance row per field (the fixture `aiDraft` has none); returns its version. */
async function draftWith(
  sql: Sql, docId: string, locale: string, fields: Record<string, unknown>, warned: Record<string, string[]> = {},
): Promise<number> {
  const hashes: Record<string, string> = { title: hashValue("Intro"), body: hashValue("Hello") };
  const result = await recordAiDraft(coreCtx(sql), {
    docId, locale, fields, sourceVersion: 1,
    sourceHashes: Object.fromEntries(Object.keys(fields).map((k) => [k, hashes[k]!])),
    provenance: Object.keys(fields).map((k) => prov(k, warned[k] ?? [])),
  });
  if (!("version" in result)) throw new Error(`setup: the AI draft was cancelled (${result.cancelled})`);
  return result.version;
}

/** Publishes a new source (en) title and body, so the drafts made before are behind it. */
async function moveSource(sql: Sql, docId: string): Promise<void> {
  await saveDraft(coreCtx(sql), { docId, locale: "en", data: { title: "Intro 2", body: "Hello 2" } });
  await publish(coreCtx(sql), { docId, locale: "en" });
}

const rows = (sql: Sql, docId: string, locale = "de") =>
  sql`select version, state, is_head_draft, is_head_published, data, source_hashes from document_localized
    where doc_id = ${docId} and locale = ${locale} order by version`;

const provenanceOf = (sql: Sql, docId: string, version: number) =>
  sql`select field_path, edited, acknowledged_warnings, model_id, discard_reason from content_provenance
    where doc_id = ${docId} and locale = 'de' and version = ${version} order by field_path nulls last, id`;

describe("review routing", () => {
  test("usesSignal is true exactly for the interactive forms", () => {
    const uses = reviewSpec.usesSignal as (flags: Record<string, unknown>, positionals: string[]) => boolean;
    expect(uses({}, [])).toBe(true);
    expect(uses({}, ["docs/intro"])).toBe(true);
    expect(uses({}, ["list"])).toBe(false);
    expect(uses({}, ["approve", "docs/intro"])).toBe(false);
    expect(uses({ "approve-clean": true }, [])).toBe(false);
  });

  test("a bad verb with no slash, and every form that does not take an option, exit 2 naming the problem", async () => {
    await withDb(async (sql) => {
      const bad = await cli(sql, "review", "frobnicate");
      expect(bad.code).toBe(2);
      expect(bad.err).toContain("list|show|approve|reject");

      const show = await cli(sql, "review", "show", "docs/intro", "--locale", "de", "--version", "3");
      expect(show.code).toBe(2);
      expect(show.err).toContain("--version");

      const list = await cli(sql, "review", "list", "--reason", "x");
      expect(list.code).toBe(2);
      expect(list.err).toContain("--reason");

      for (const [args, option] of [
        [["review", "reject", "docs/intro", "--locale", "de", "--version", "1", "--edit-file", "x"], "--edit-file"],
        [["review", "reject", "docs/intro", "--locale", "de", "--version", "1", "--ack-warning", "x"], "--ack-warning"],
        [["review", "approve", "docs/intro", "--locale", "de", "--version", "1", "--reason", "x"], "--reason"],
        [["review", "approve", "docs/intro", "--locale", "de", "--version", "1", "--state", "APPROVED"], "--state"],
        [["review", "list", "--version", "1"], "--version"],
        [["review", "--approve-clean", "--version", "1"], "--version"],
        [["review", "--approve-clean", "--state", "APPROVED"], "--state"],
        [["review", "docs/intro", "--version", "1"], "--version"],
      ] as const) {
        const r = await cli(sql, ...args);
        expect([r.code, args.join(" ")]).toEqual([2, args.join(" ")]);
        expect(r.err).toContain(option);
      }
    });
  });

  test("--approve-clean takes no positional and no verb", async () => {
    await withDb(async (sql) => {
      expect((await cli(sql, "review", "--approve-clean", "docs/intro")).code).toBe(2);
      const verb = await cli(sql, "review", "--approve-clean", "list");
      expect(verb.code).toBe(2);
      expect(verb.err).toContain("--approve-clean");
    });
  });

  test("show, approve and reject need a target and --locale; approve and reject need --version", async () => {
    await withDb(async (sql) => {
      expect((await cli(sql, "review", "show", "--locale", "de")).code).toBe(2);
      expect((await cli(sql, "review", "show", "docs/intro")).code).toBe(2);
      expect((await cli(sql, "review", "approve", "docs/intro", "--locale", "de")).code).toBe(2);
      expect((await cli(sql, "review", "reject", "docs/intro", "--locale", "de")).code).toBe(2);
    });
  });

  test("the interactive forms are routed but not implemented yet (Task 8): exit 1 with NotImplemented; --json is a usage error", async () => {
    await withDb(async (sql) => {
      for (const args of [["review"], ["review", "docs/intro"], ["review", "--locale", "de"]]) {
        const r = await cli(sql, ...args);
        expect([r.code, args.join(" ")]).toEqual([1, args.join(" ")]);
        expect(r.err).toContain("interactive review is implemented in the next task");
        expect(r.out).toBe("");
      }
      for (const args of [["review", "--json"], ["review", "docs/intro", "--json"]]) {
        const r = await cli(sql, ...args);
        expect([r.code, args.join(" ")]).toEqual([2, args.join(" ")]);
        expect(r.err).toContain("--json");
      }
    });
  });
});

describe("review list", () => {
  test("shows the pending DRAFT_AI head with the version --version takes, and --json gives { items, next: null }", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung" }, { title: [W1] });
      const r = await cli(sql, "review", "list");
      expect(r.code).toBe(0);
      expect(r.out).toMatch(new RegExp(`docs/intro\\s+de\\s+v${v}\\s+DRAFT_AI\\s+1\\n`));
      expect(r.out.split("\n")[0]).toMatch(/^target\s+locale\s+version\s+state\s+warnings$/);

      const json = JSON.parse((await cli(sql, "review", "list", "--json")).out) as {
        ok: boolean; data: { items: Array<Record<string, unknown>>; next: unknown };
      };
      expect(json.ok).toBe(true);
      expect(json.data.next).toBeNull();
      expect(json.data.items).toHaveLength(1);
      expect(json.data.items[0]).toMatchObject({
        docId, collection: "docs", slug: "intro", locale: "de", version: v, state: "DRAFT_AI", warningCount: 1,
      });
    });
  });

  test("--state is upper-cased and checked, filters and scopes apply, and an undeclared scope is a usage error", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung" });
      expect((await cli(sql, "review", "list", "--state", "approved")).out).toContain("no APPROVED drafts");
      expect((await cli(sql, "review", "list", "--state", "bogus")).code).toBe(2);
      expect((await cli(sql, "review", "list", "--locale", "fr")).out).toContain("no DRAFT_AI drafts");
      expect((await cli(sql, "review", "list", "--locale", "DE")).out).toContain(`v${v}`);
      expect((await cli(sql, "review", "list", "--collection", "docs")).out).toContain(`v${v}`);
      expect((await cli(sql, "review", "list", "--collection", "nope")).code).toBe(2);
      expect((await cli(sql, "review", "list", "--locale", "xx")).code).toBe(2);
      expect((await cli(sql, "review", "list", "--locale", "shared")).code).toBe(0);

      await approve(coreCtx(sql), { docId, locale: "de" });
      expect((await cli(sql, "review", "list", "--state", "APPROVED")).out).toContain("APPROVED");
    });
  });
});

describe("review show", () => {
  test("prints the previous published text and the draft side by side, and --json is the DraftReview", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      await approve(coreCtx(sql), { docId, locale: "de" });
      await publish(coreCtx(sql), { docId, locale: "de" });
      const v = await draftWith(sql, docId, "de", { title: "Einführung" }, { title: [W2] });

      const r = await cli(sql, "review", "show", "docs/intro", "--locale", "de");
      expect(r.code).toBe(0);
      expect(r.out.split("\n")[0]).toBe(`docs/intro de v${v} DRAFT_AI (source en v1)`);
      expect(r.out).toContain("previous (published)");
      expect(r.out).toMatch(/Einleitung\s+\| Einführung/);
      expect(r.out).toContain(`! ${W2}`);
      expect(r.out).not.toContain("\u001b");

      const json = JSON.parse((await cli(sql, "review", "show", "docs/intro", "--locale", "de", "--json")).out) as {
        data: { docId: string; version: number; fields: Array<{ path: string; draft: unknown }> };
      };
      expect(json.data).toMatchObject({ docId, version: v });
      expect(json.data.fields.find((f) => f.path === "title")?.draft).toBe("Einführung");
    });
  });

  test("a source changed after the draft shows the source-changed line, and a glossary match shows its line", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      await upsertGlossary(coreCtx(sql), [
        { sourceLocale: "en", targetLocale: "de", term: "intro", translation: "Einführung", acceptedForms: [], doNotTranslate: false, note: null },
      ]);
      const before = await cli(sql, "review", "show", "docs/intro", "--locale", "de");
      expect(before.out).not.toContain("! source changed");
      expect(before.out).toContain("glossary: intro -> Einführung");

      await moveSource(sql, docId);
      const after = await cli(sql, "review", "show", "docs/intro", "--locale", "de");
      expect(after.out).toContain("! source changed since this draft was translated");
    });
  });

  test("a pair with no draft exits 1 with 'no draft for <collection>/<slug> <locale>'", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      const r = await cli(sql, "review", "show", "docs/intro", "--locale", "de");
      expect(r.code).toBe(1);
      expect(r.err).toContain("error: no draft for docs/intro de");
      const json = JSON.parse((await cli(sql, "review", "show", "docs/intro", "--locale", "de", "--json")).out) as {
        ok: boolean; error: { code: string; message: string };
      };
      expect(json.ok).toBe(false);
      expect(json.error.message).toBe("no draft for docs/intro de");
    });
  });
});

describe("review approve", () => {
  test("creates an APPROVED head and prints its version; --json is { version }", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung" });
      const r = await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(v));
      expect(r.code).toBe(0);
      expect(r.out).toBe(`approved docs/intro de v${v + 1}\n`);
      expect((await rows(sql, docId)).map((x) => [x.version, x.state, x.is_head_draft])).toEqual([
        [v, "DRAFT_AI", false],
        [v + 1, "APPROVED", true],
      ]);

      const docB = await publishedDoc(sql, "second");
      const vb = await draftWith(sql, docB, "de", { title: "Zweite" });
      const json = JSON.parse(
        (await cli(sql, "review", "approve", "docs/second", "--locale", "de", "--version", String(vb), "--json")).out,
      ) as { ok: boolean; data: unknown };
      expect(json).toMatchObject({ ok: true, data: { version: vb + 1 } });
    });
  });

  test("--reject-fields title restores the published title", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await draftWith(sql, docId, "de", { title: "Einleitung" });
      await approve(coreCtx(sql), { docId, locale: "de" });
      await publish(coreCtx(sql), { docId, locale: "de" });
      const v = await draftWith(sql, docId, "de", { title: "Einführung" });
      const r = await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(v), "--reject-fields", "title");
      expect(r.code).toBe(0);
      const head = (await rows(sql, docId)).find((x) => x.is_head_draft);
      expect(head).toMatchObject({ state: "APPROVED", data: { title: "Einleitung" } });

      expect((await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", "1", "--reject-fields", "title,")).code).toBe(2);
    });
  });

  test.each([["text edit file", "txt"], ["json edit file", "json"]])(
    "Review Focus 9: a %s changes only the edited field; the unedited carried-over one keeps edited=false and its source hash",
    async (_name, kind) => {
      await withDb(async (sql) => {
        const docId = await publishedDoc(sql);
        const v = await draftWith(sql, docId, "de", { title: "Einleitung", body: "Hallo" });
        await moveSource(sql, docId); // both source fields moved: a re-pin of the body would show in its hash
        const file =
          kind === "txt"
            ? tempFile("edit.txt", "=== body ===\nHallo\n\n=== title ===\nNeuer Titel\n")
            : tempFile("edit.json", JSON.stringify({ body: "Hallo", title: "Neuer Titel" }));
        const r = await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(v), "--edit-file", file);
        expect(r.err).not.toContain("error:");
        expect(r.code).toBe(0);

        const head = (await rows(sql, docId)).find((x) => x.is_head_draft)!;
        expect(head.data).toEqual({ title: "Neuer Titel", body: "Hallo" });
        expect(head.source_hashes).toEqual({ title: hashValue("Intro 2"), body: hashValue("Hello") });
        expect((await provenanceOf(sql, docId, head.version as number)).map((p) => [p.field_path, p.edited])).toEqual([
          ["body", false],
          ["title", true],
        ]);
      });
    },
  );

  test("an edit file that changes nothing approves the draft as it is", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung" });
      const file = tempFile("same.txt", "=== title ===\nEinleitung\n");
      const r = await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(v), "--edit-file", file);
      expect(r.code).toBe(0);
      expect((await provenanceOf(sql, docId, v + 1)).map((p) => [p.field_path, p.edited])).toEqual([["title", false]]);
    });
  });

  test("a bad edit file is a usage error and changes nothing", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung" });
      const file = tempFile("bad.txt", "no header here\n");
      const r = await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(v), "--edit-file", file);
      expect(r.code).toBe(2);
      expect((await rows(sql, docId)).map((x) => [x.version, x.state, x.is_head_draft])).toEqual([[v, "DRAFT_AI", true]]);
    });
  });

  test("a pair with no draft exits 1", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      const r = await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", "1");
      expect(r.code).toBe(1);
      expect(r.err).toContain("no draft head");
    });
  });

  describe("D-warn (Review Focus 10)", () => {
    const setup = async (sql: Sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung", body: "Hallo" }, { title: [W1], body: [W2] });
      return { docId, v };
    };
    const unchanged = async (sql: Sql, docId: string, v: number) =>
      expect((await rows(sql, docId)).map((x) => [x.version, x.state, x.is_head_draft])).toEqual([[v, "DRAFT_AI", true]]);

    test("without --ack-warning: exit 1, nothing changes, every warning text is printed", async () => {
      await withDb(async (sql) => {
        const { docId, v } = await setup(sql);
        const r = await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(v));
        expect(r.code).toBe(1);
        expect(r.out).toBe("");
        expect(r.err).toContain(W1);
        expect(r.err).toContain(W2);
        await unchanged(sql, docId, v);
      });
    });

    test("with one of two warnings acknowledged: exit 1 naming the missing one, nothing changes", async () => {
      await withDb(async (sql) => {
        const { docId, v } = await setup(sql);
        const r = await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(v), "--ack-warning", W1);
        expect(r.code).toBe(1);
        expect(r.err).toContain(`not acknowledged: ${W2}`);
        expect(r.err).not.toContain(W1);
        await unchanged(sql, docId, v);
      });
    });

    test("with every distinct text acknowledged (commas inside the texts): approves and records them on every row", async () => {
      await withDb(async (sql) => {
        const { docId, v } = await setup(sql);
        const r = await cli(
          sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(v),
          "--ack-warning", W1, "--ack-warning", W2,
        );
        expect(r.code).toBe(0);
        expect((await provenanceOf(sql, docId, v + 1)).map((p) => [p.field_path, p.acknowledged_warnings])).toEqual([
          ["body", [W1, W2]],
          ["title", [W1, W2]],
        ]);
      });
    });
  });

  describe("D-stale", () => {
    test.each([["approve"], ["reject"]])("%s without --version, or with 0, 1e1 or 0x10, exits 2 before anything runs", async (verb) => {
      await withDb(async (sql) => {
        const docId = await publishedDoc(sql);
        const v = await draftWith(sql, docId, "de", { title: "Einleitung" });
        const base = ["review", verb, "docs/intro", "--locale", "de"];
        const missing = await cli(sql, ...base);
        expect(missing.code).toBe(2);
        expect(missing.err).toContain("--version");
        for (const bad of ["0", "1e1", "0x10", " 1", "-1", ""]) {
          expect([(await cli(sql, ...base, "--version", bad)).code, bad]).toEqual([2, bad]);
        }
        expect((await rows(sql, docId)).map((x) => [x.version, x.state, x.is_head_draft])).toEqual([[v, "DRAFT_AI", true]]);
      });
    });

    test("a draft replaced after it was seen: the old version is a conflict that changes nothing, the new one succeeds", async () => {
      await withDb(async (sql) => {
        const docId = await publishedDoc(sql);
        const old = await draftWith(sql, docId, "de", { title: "Einleitung" });
        const current = await draftWith(sql, docId, "de", { title: "Einführung" });
        expect(current).toBeGreaterThan(old);

        for (const verb of ["approve", "reject"]) {
          const r = await cli(sql, "review", verb, "docs/intro", "--locale", "de", "--version", String(old));
          expect([verb, r.code]).toEqual([verb, 1]);
          expect(r.out).toBe("");
          expect(r.err).toContain(`Expected draft version ${old} of ${docId}/de but the head is ${current}`);
          expect(r.err.trimEnd().endsWith("run `mogging review show` again")).toBe(true);
        }
        const json = JSON.parse(
          (await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(old), "--json")).out,
        ) as { ok: boolean; error: { code: string; message: string } };
        expect(json.ok).toBe(false);
        expect(json.error.code).toBe("conflict"); // the error's own string code, as for a throw
        expect((await rows(sql, docId)).map((x) => [x.version, x.state, x.is_head_draft])).toEqual([
          [old, "DRAFT_AI", false],
          [current, "DRAFT_AI", true],
        ]);

        const ok = await cli(sql, "review", "approve", "docs/intro", "--locale", "de", "--version", String(current));
        expect(ok.code).toBe(0);
        expect(ok.out).toBe(`approved docs/intro de v${current + 1}\n`);
      });
    });
  });
});

describe("review reject", () => {
  test("clears the draft head and records the reason; a second reject exits 1", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await draftWith(sql, docId, "de", { title: "Einleitung" });
      const r = await cli(sql, "review", "reject", "docs/intro", "--locale", "de", "--version", String(v), "--reason", "mistranslated");
      expect(r.code).toBe(0);
      expect(r.out).toBe(`rejected docs/intro de v${v}\n`);
      expect((await rows(sql, docId)).map((x) => [x.version, x.state, x.is_head_draft])).toEqual([[v, "DRAFT_AI", false]]);
      expect((await provenanceOf(sql, docId, v)).find((p) => p.model_id === "human:reject")?.discard_reason).toBe("mistranslated");

      const again = await cli(sql, "review", "reject", "docs/intro", "--locale", "de", "--version", String(v));
      expect(again.code).toBe(1);
      expect(again.err).toContain("no draft head");
    });
  });

  test("--json is { version }", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v = await aiDraft(sql, docId, "de", "Einleitung");
      const json = JSON.parse(
        (await cli(sql, "review", "reject", "docs/intro", "--locale", "de", "--version", String(v), "--json")).out,
      ) as { ok: boolean; data: unknown };
      expect(json).toMatchObject({ ok: true, data: { version: v } });
    });
  });
});

describe("review --approve-clean", () => {
  test("approves the warning-free draft, skips the warned one with its reason and writes the bulk marker", async () => {
    await withDb(async (sql) => {
      const clean = await publishedDoc(sql, "intro");
      const warned = await publishedDoc(sql, "other");
      const vc = await draftWith(sql, clean, "de", { title: "Einleitung" });
      const vw = await draftWith(sql, warned, "de", { title: "Andere" }, { title: [W1] });

      const r = await cli(sql, "review", "--approve-clean");
      expect(r.code).toBe(0);
      expect(r.out.split("\n")[0]).toBe("approved 1");
      expect(r.out).toContain(`skipped ${warned} de: has warnings`);

      expect((await rows(sql, clean)).map((x) => [x.version, x.state, x.is_head_draft])).toEqual([
        [vc, "DRAFT_AI", false],
        [vc + 1, "APPROVED", true],
      ]);
      expect((await rows(sql, warned)).map((x) => [x.version, x.state, x.is_head_draft])).toEqual([[vw, "DRAFT_AI", true]]);
      const markers = await sql`select doc_id from content_provenance where model_id = 'human:bulk-approve'`;
      expect(markers.map((m) => m.doc_id)).toEqual([clean]);

      const json = JSON.parse((await cli(sql, "review", "--approve-clean", "--locale", "de", "--collection", "docs", "--json")).out) as {
        ok: boolean; data: { approved: number; skipped: Array<{ docId: string; locale: string; reason: string }> };
      };
      expect(json.data).toEqual({ approved: 0, skipped: [{ docId: warned, locale: "de", reason: "has warnings" }] });
    });
  });

  test("an undeclared --collection or --locale is a usage error", async () => {
    await withDb(async (sql) => {
      expect((await cli(sql, "review", "--approve-clean", "--collection", "nope")).code).toBe(2);
      expect((await cli(sql, "review", "--approve-clean", "--locale", "xx")).code).toBe(2);
    });
  });
});
