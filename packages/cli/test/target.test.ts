import { describe, expect, test } from "vitest";
import type { Sql } from "postgres";
import { createDocument, deleteDocument, migrate, saveDraft } from "@mogging/core";
import type { Ctx } from "@mogging/core";
import { resolveTarget } from "../src/target.js";
import { UsageError } from "../src/types.js";
import { withTestDb } from "./db.js";
import { config } from "./fixtures.js";

async function setup(sql: Sql): Promise<Ctx> {
  await migrate(sql);
  return { sql, config, actor: "tester" };
}

async function docWithSlug(ctx: Ctx, slug: string): Promise<string> {
  const { id } = await createDocument(ctx, { collection: "docs" });
  await saveDraft(ctx, { docId: id, locale: "shared", data: { slug } });
  return id;
}

describe("resolveTarget", () => {
  test("collection/slug resolves to the document's id", async () => {
    await withTestDb(async (sql) => {
      const ctx = await setup(sql);
      const id = await docWithSlug(ctx, "intro");
      expect(await resolveTarget(ctx, "docs/intro")).toEqual({ collection: "docs", docId: id, slug: "intro" });
    });
  });

  test("collection/<uuid> resolves by id and reports the slug", async () => {
    await withTestDb(async (sql) => {
      const ctx = await setup(sql);
      const id = await docWithSlug(ctx, "intro");
      expect(await resolveTarget(ctx, `docs/${id}`)).toEqual({ collection: "docs", docId: id, slug: "intro" });
      const bare = (await createDocument(ctx, { collection: "docs" })).id;
      expect(await resolveTarget(ctx, `docs/${bare.toUpperCase()}`)).toEqual({
        collection: "docs", docId: bare, slug: null,
      });
    });
  });

  test("a nested slug splits at the FIRST slash only", async () => {
    await withTestDb(async (sql) => {
      const ctx = await setup(sql);
      const id = await docWithSlug(ctx, "guide/setup");
      expect(await resolveTarget(ctx, "docs/guide/setup")).toEqual({
        collection: "docs", docId: id, slug: "guide/setup",
      });
    });
  });

  test("an upper-case slug is lowercased before the lookup", async () => {
    await withTestDb(async (sql) => {
      const ctx = await setup(sql);
      const id = await docWithSlug(ctx, "intro");
      expect(await resolveTarget(ctx, "docs/Intro")).toEqual({ collection: "docs", docId: id, slug: "intro" });
    });
  });

  test("an unknown collection is a NotFoundError naming it", async () => {
    await withTestDb(async (sql) => {
      const ctx = await setup(sql);
      const err = await resolveTarget(ctx, "posts/intro").catch((e: unknown) => e);
      expect((err as Error).name).toBe("NotFoundError");
      expect((err as Error).message).toBe('Unknown collection "posts"');
    });
  });

  test("a soft-deleted document is a NotFoundError by slug and by id, the same text as an unknown one", async () => {
    await withTestDb(async (sql) => {
      const ctx = await setup(sql);
      const id = await docWithSlug(ctx, "gone");
      await deleteDocument(ctx, { docId: id });
      for (const rest of ["gone", id]) {
        const err = await resolveTarget(ctx, `docs/${rest}`).catch((e: unknown) => e);
        expect([rest, (err as Error).name]).toEqual([rest, "NotFoundError"]);
        expect((err as Error).message).toBe(`Document "docs/${rest}" not found`);
      }
    });
  });

  test("an unknown slug or an unknown id is a NotFoundError naming the target", async () => {
    await withTestDb(async (sql) => {
      const ctx = await setup(sql);
      await docWithSlug(ctx, "intro");
      const slugErr = await resolveTarget(ctx, "docs/missing").catch((e: unknown) => e);
      expect((slugErr as Error).name).toBe("NotFoundError");
      expect((slugErr as Error).message).toBe('Document "docs/missing" not found');
      const uuid = "00000000-0000-4000-8000-000000000000";
      const idErr = await resolveTarget(ctx, `docs/${uuid}`).catch((e: unknown) => e);
      expect((idErr as Error).name).toBe("NotFoundError");
      expect((idErr as Error).message).toBe(`Document "docs/${uuid}" not found`);
    });
  });

  test.each(["intro", "", "/intro", "docs/"])("%j (no collection/rest split) is a UsageError", async (text) => {
    await withTestDb(async (sql) => {
      const ctx = await setup(sql);
      const err = await resolveTarget(ctx, text).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toContain("<collection>/<slug or id>");
    });
  });
});
