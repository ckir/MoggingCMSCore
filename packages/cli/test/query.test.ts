import { describe, expect, test } from "vitest";
import { createDocument, migrate, publish, saveDraft } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { aiDraft, coreCtx, DAY, publishedDoc, setFirstMigration, testDeps } from "./fixtures.js";

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

/** `docs/intro` with a published de head carrying only a title (so `body` falls back to en). */
async function introWithGerman(sql: Sql): Promise<string> {
  const docId = await publishedDoc(sql);
  await saveDraft(coreCtx(sql), { docId, locale: "de", data: { title: "Einleitung" } });
  await publish(coreCtx(sql), { docId, locale: "de" });
  return docId;
}

async function query(sql: Sql, ...args: string[]) {
  const t = testDeps(sql);
  const code = await run(["query", ...args], t);
  return { code, out: t.stdout(), err: t.stderr() };
}

describe("mogging query: a collection", () => {
  test("lists one line per published document: slug, two spaces, the first text field", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql, "intro");
      const second = await publishedDoc(sql, "other");
      await saveDraft(coreCtx(sql), { docId: second, locale: "en", data: { title: "Other title" } });
      await publish(coreCtx(sql), { docId: second, locale: "en" });
      const r = await query(sql, "docs");
      expect(r.code).toBe(0);
      expect(r.out).toBe("intro  Intro\nother  Other title\n");
    });
  });

  test("--limit caps the list; --json is the resolve result unchanged", async () => {
    await withDb(async (sql) => {
      const first = await publishedDoc(sql, "intro");
      await publishedDoc(sql, "other");
      const r = await query(sql, "docs", "--limit", "1", "--json");
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out) as { ok: boolean; data: unknown };
      expect(doc.ok).toBe(true);
      expect(doc.data).toEqual([{ id: first, data: { slug: "intro", title: "Intro", body: "Hello" }, fellBack: {}, missing: [] }]);
    });
  });

  test("the default locale is the source locale; --locale picks another and falls back per field", async () => {
    await withDb(async (sql) => {
      await introWithGerman(sql);
      expect((await query(sql, "docs")).out).toBe("intro  Intro\n");
      expect((await query(sql, "docs", "--locale", "de")).out).toBe("intro  Einleitung\n");
    });
  });

  test("a collection with no published document prints nothing and exits 0", async () => {
    await withDb(async (sql) => {
      const r = await query(sql, "docs");
      expect(r).toEqual({ code: 0, out: "", err: expect.any(String) });
    });
  });

  test("an unknown collection and an undeclared locale are exit 1", async () => {
    await withDb(async (sql) => {
      const unknown = await query(sql, "nope");
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain('Unknown collection "nope"');
      const locale = await query(sql, "docs", "--locale", "xx");
      expect(locale.code).toBe(1);
      expect(locale.err).toContain('Locale "xx" is not declared');
    });
  });

  test("--limit outside 1..200 or not a whole number is a usage error", async () => {
    await withDb(async (sql) => {
      for (const limit of ["0", "201", "1e1", "-1", ""]) {
        const r = await query(sql, "docs", "--limit", limit);
        expect(r.code).toBe(2);
        expect(r.err).toContain("--limit");
        expect(r.err).not.toContain("unknown command");
        expect(r.out).toBe("");
      }
    });
  });
});

describe("mogging query: one document", () => {
  test("docs/intro --locale de prints the German field and the English fallback with where it came from", async () => {
    await withDb(async (sql) => {
      const docId = await introWithGerman(sql);
      const r = await query(sql, "docs/intro", "--locale", "de");
      expect(r.code).toBe(0);
      expect(r.out).toBe(
        ["slug [shared]: intro", "title [de]: Einleitung", "body [en (fell back from de)]: Hello", ""].join("\n"),
      );

      const json = await query(sql, "docs/intro", "--locale", "de", "--json");
      expect((JSON.parse(json.out) as { data: unknown }).data).toEqual({
        id: docId,
        data: { slug: "intro", title: "Einleitung", body: "Hello" },
        fellBack: { body: "en" },
        missing: [],
      });
    });
  });

  test("a localized field no locale supplies is listed as missing", async () => {
    await withDb(async (sql) => {
      const ctx = coreCtx(sql);
      const { id: docId } = await createDocument(ctx, { collection: "docs" });
      await saveDraft(ctx, { docId, locale: "shared", data: { slug: "thin" } });
      await saveDraft(ctx, { docId, locale: "en", data: { title: "Only a title" } });
      await publish(ctx, { docId, locale: "shared" });
      await publish(ctx, { docId, locale: "en" });
      const r = await query(sql, "docs/thin");
      expect(r.out).toBe("slug [shared]: thin\ntitle [en]: Only a title\nmissing: body\n");
    });
  });

  test("--raw prints the published and the draft head of each locale with their versions", async () => {
    await withDb(async (sql) => {
      const docId = await introWithGerman(sql);
      await aiDraft(sql, docId, "fr", "Introduction"); // fr: a draft only
      await saveDraft(coreCtx(sql), { docId, locale: "de", data: { title: "Einleitung 2" } }); // de: published v1, draft v2
      const r = await query(sql, "docs/intro", "--raw");
      expect(r.code).toBe(0);
      expect(r.out).toBe(
        [
          "shared published v1",
          "de published v1",
          "de draft v2 DRAFT_HUMAN",
          "en published v1",
          "fr draft v1 DRAFT_AI",
          "",
        ].join("\n"),
      );

      const json = JSON.parse((await query(sql, "docs/intro", "--raw", "--json")).out) as {
        data: { id: string; locales: Record<string, { published: { version: number } | null; draft: { state: string } | null }> };
      };
      expect(json.data.id).toBe(docId);
      expect(json.data.locales.de!.published!.version).toBe(1);
      expect(json.data.locales.de!.draft!.state).toBe("DRAFT_HUMAN");
      expect(json.data.locales.fr!.published).toBeNull();
    });
  });

  test("--raw --locale shows only that locale", async () => {
    await withDb(async (sql) => {
      await introWithGerman(sql);
      const r = await query(sql, "docs/intro", "--raw", "--locale", "de");
      expect(r.out).toBe("de published v1\n");
    });
  });

  test("an unknown slug is exit 1; a document with nothing published says so", async () => {
    await withDb(async (sql) => {
      const missing = await query(sql, "docs/nope");
      expect(missing.code).toBe(1);
      expect(missing.err).toContain('Document "docs/nope" not found');

      const ctx = coreCtx(sql);
      const { id: docId } = await createDocument(ctx, { collection: "docs" });
      await saveDraft(ctx, { docId, locale: "shared", data: { slug: "unpublished" } });
      const draftOnly = await query(sql, "docs/unpublished");
      expect(draftOnly.code).toBe(1);
      expect(draftOnly.err).toContain("docs/unpublished has no published content in en");
    });
  });

  test("a malformed target, --raw without a document and a missing collection are usage errors", async () => {
    await withDb(async (sql) => {
      const empty = await query(sql, "docs/");
      expect(empty.code).toBe(2);
      expect(empty.err).toContain("invalid target");
      const raw = await query(sql, "docs", "--raw");
      expect(raw.code).toBe(2);
      expect(raw.err).toContain("--raw");
      const none = await query(sql);
      expect(none.code).toBe(2);
      expect(none.err).not.toContain("unknown command");
    });
  });
});

test("query is a read: it still works after the evaluation window", async () => {
  await withDb(async (sql) => {
    await publishedDoc(sql);
    await setFirstMigration(sql, new Date(Date.now() - 31 * DAY));
    const r = await query(sql, "docs");
    expect(r.code).toBe(0);
    expect(r.out).toBe("intro  Intro\n");
  });
});
