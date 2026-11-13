import { describe, expect, test } from "vitest";
import { addToRelease, approve, createRelease, migrate, publish, saveDraft } from "@mogging/core";
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

async function cli(sql: Sql, ...args: string[]) {
  const t = testDeps(sql);
  const code = await run(args, t);
  return { code, out: t.stdout(), err: t.stderr() };
}

const expireWindow = (sql: Sql) => setFirstMigration(sql, new Date(Date.now() - 31 * DAY));

/** Every snapshot row's publication flag, so a refusal can be shown to have changed nothing. */
const publishedFlags = async (sql: Sql) =>
  (await sql`
    select 'localized' as kind, doc_id, locale, version, is_head_published, is_head_draft, state from document_localized
    union all
    select 'shared', doc_id, 'shared', version, is_head_published, is_head_draft, state from document_shared
    order by 1, 2, 3, 4`) as unknown as Array<Record<string, unknown>>;

const review = (target: string, locale: string) =>
  `${target} ${locale} is an unapproved AI draft: run \`mogging review\` first`;

/** de: an APPROVED head (version returned); fr: a DRAFT_AI head. */
async function approvedDeAndAiFr(sql: Sql): Promise<{ docId: string; deVersion: number }> {
  const docId = await publishedDoc(sql);
  await aiDraft(sql, docId, "de", "Einleitung");
  const { version } = await approve(coreCtx(sql), { docId, locale: "de" });
  await aiDraft(sql, docId, "fr", "Introduction");
  return { docId, deVersion: version };
}

describe("mogging publish <target>", () => {
  test("with the evaluation window over and two publishable heads, exit is 3 (not 1) and nothing is published", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await saveDraft(coreCtx(sql), { docId, locale: "de", data: { title: "Einleitung" } });
      await saveDraft(coreCtx(sql), { docId, locale: "fr", data: { title: "Introduction" } });
      await expireWindow(sql);
      const before = await publishedFlags(sql);
      const r = await cli(sql, "publish", "docs/intro");
      expect(r.code).toBe(3);
      expect(r.out).toBe("");
      expect(r.err).not.toContain("refused");
      expect(await publishedFlags(sql)).toEqual(before);

      const json = await cli(sql, "publish", "docs/intro", "--json");
      expect(json.code).toBe(3);
      expect((JSON.parse(json.out) as { ok: boolean; data?: unknown }).data).toBeUndefined();
    });
  });

  test("a DRAFT_AI head with --locale is refused with the review message: exit 1, published state unchanged", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await aiDraft(sql, docId, "de", "Einleitung");
      const before = await publishedFlags(sql);
      const r = await cli(sql, "publish", "docs/intro", "--locale", "de");
      expect(r.code).toBe(1);
      expect(r.out).toBe(`refused: ${review("docs/intro", "de")}\n`);
      expect(r.err).toContain(review("docs/intro", "de"));
      expect(await publishedFlags(sql)).toEqual(before);
    });
  });

  test("without --locale an APPROVED de head is published and a DRAFT_AI fr head is refused: exit 4", async () => {
    await withDb(async (sql) => {
      const { deVersion } = await approvedDeAndAiFr(sql);
      const r = await cli(sql, "publish", "docs/intro");
      expect(r.code).toBe(4);
      expect(r.out).toBe(`published docs/intro de v${deVersion}\nrefused: ${review("docs/intro", "fr")}\n`);
      const rows = (await sql`select locale, state, is_head_published, is_head_draft from document_localized
        where locale in ('de', 'fr') and (is_head_published or is_head_draft) order by locale`) as unknown as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        { locale: "de", state: "PUBLISHED", is_head_published: true, is_head_draft: false },
        { locale: "fr", state: "DRAFT_AI", is_head_published: false, is_head_draft: true },
      ]);
    });
  });

  test("--json of that run: partial, items with the outcome words", async () => {
    await withDb(async (sql) => {
      const { deVersion } = await approvedDeAndAiFr(sql);
      const r = await cli(sql, "publish", "docs/intro", "--json");
      expect(r.code).toBe(4);
      expect(JSON.parse(r.out)).toMatchObject({
        ok: true,
        partial: true,
        data: {
          items: [
            { target: "docs/intro", locale: "de", outcome: "published", version: deVersion },
            { target: "docs/intro", locale: "fr", outcome: "refused", message: review("docs/intro", "fr") },
          ],
        },
      });
    });
  });

  test("a document whose only draft is a DRAFT_AI head, published without --locale, exits 1 and publishes nothing", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await aiDraft(sql, docId, "de", "Einleitung");
      const before = await publishedFlags(sql);
      const r = await cli(sql, "publish", "docs/intro");
      expect(r.code).toBe(1);
      expect(r.out).toBe(`refused: ${review("docs/intro", "de")}\n`);
      expect(await publishedFlags(sql)).toEqual(before);
    });
  });

  test("publishes the shared snapshot together with the locales when it has a draft head", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await saveDraft(coreCtx(sql), { docId, locale: "shared", data: { slug: "intro" } });
      await saveDraft(coreCtx(sql), { docId, locale: "de", data: { title: "Einleitung" } });
      const r = await cli(sql, "publish", "docs/intro");
      expect(r.code).toBe(0);
      expect(r.out).toBe("published docs/intro shared v2\npublished docs/intro de v1\n");
    });
  });

  test("--locale publishes only that locale; shared is allowed", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await saveDraft(coreCtx(sql), { docId, locale: "de", data: { title: "Einleitung" } });
      await saveDraft(coreCtx(sql), { docId, locale: "fr", data: { title: "Introduction" } });
      await saveDraft(coreCtx(sql), { docId, locale: "shared", data: { slug: "intro" } });
      expect((await cli(sql, "publish", "docs/intro", "--locale", "de")).out).toBe("published docs/intro de v1\n");
      expect((await cli(sql, "publish", "docs/intro", "--locale", "shared")).out).toBe("published docs/intro shared v2\n");
      const left = await sql`select locale from document_localized where is_head_draft`;
      expect(left.map((l) => l.locale)).toEqual(["fr"]);
    });
  });

  test("a document with no draft head prints nothing to publish and exits 0", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      const r = await cli(sql, "publish", "docs/intro");
      expect(r).toMatchObject({ code: 0, out: "docs/intro nothing to publish\n" });
      const shared = await cli(sql, "publish", "docs/intro", "--locale", "shared");
      expect(shared).toMatchObject({ code: 0, out: "docs/intro nothing to publish\n" });
      const json = await cli(sql, "publish", "docs/intro", "--json");
      expect(JSON.parse(json.out)).toMatchObject({ ok: true, partial: false, data: { items: [] } });
    });
  });

  test("an undeclared --locale is exit 1 even when there is no draft head for it", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      const r = await cli(sql, "publish", "docs/intro", "--locale", "xx");
      expect(r.code).toBe(1);
      expect(r.err).toContain('Locale "xx" is not declared in the config');
    });
  });

  test("an unknown document is exit 1", async () => {
    await withDb(async (sql) => {
      const r = await cli(sql, "publish", "docs/nope");
      expect(r.code).toBe(1);
      expect(r.err).toContain("not found");
    });
  });
});

describe("mogging publish: usage", () => {
  const cases: Array<[string, string[], string]> = [
    ["no target and no --release", ["publish"], "--release"],
    ["a target and --release", ["publish", "docs/intro", "--release", "r1"], "--release"],
    ["--allow-stale without --release", ["publish", "docs/intro", "--allow-stale"], "--allow-stale"],
    ["--locale with --release", ["publish", "--release", "r1", "--locale", "de"], "--locale"],
    ["two targets", ["publish", "docs/a", "docs/b"], "unexpected argument"],
  ];
  for (const [name, args, mention] of cases) {
    test(`${name} exits 2`, async () => {
      await withDb(async (sql) => {
        const r = await cli(sql, ...args);
        expect(r.code).toBe(2);
        expect(r.err).toContain(mention);
        expect(r.err).not.toContain("unknown command");
        expect(r.out).toBe("");
      });
    });
  }
});

/**
 * de is approved and in release r1, then the en source is republished with a new title: the de title's recorded
 * source hash no longer matches, so r1 is stale. Returns the document id.
 */
async function staleRelease(sql: Sql): Promise<string> {
  const docId = await publishedDoc(sql);
  await aiDraft(sql, docId, "de", "Einleitung");
  const { version } = await approve(coreCtx(sql), { docId, locale: "de" });
  const { id: releaseId } = await createRelease(coreCtx(sql), { name: "r1" });
  await addToRelease(coreCtx(sql), { releaseId, docId, locale: "de", version });
  await saveDraft(coreCtx(sql), { docId, locale: "en", data: { title: "Intro, revised" } });
  await publish(coreCtx(sql), { docId, locale: "en" });
  return docId;
}

describe("mogging publish --release", () => {
  test("publishes the release: exit 0, data null, every item live, published_at set", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await aiDraft(sql, docId, "de", "Einleitung");
      const { version } = await approve(coreCtx(sql), { docId, locale: "de" });
      const { id: releaseId } = await createRelease(coreCtx(sql), { name: "r1" });
      await addToRelease(coreCtx(sql), { releaseId, docId, locale: "de", version });

      const r = await cli(sql, "publish", "--release", "r1", "--json");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ ok: true, partial: false, data: null });
      const [de] = await sql`select is_head_published from document_localized where doc_id = ${docId} and locale = 'de' and version = ${version}`;
      expect(de!.is_head_published).toBe(true);
      const [rel] = await sql`select published_at, allow_stale from releases where id = ${releaseId}`;
      expect(rel!.published_at).not.toBeNull();
      expect(rel!.allow_stale).toBe(false);
    });
  });

  test("an unknown release is exit 1", async () => {
    await withDb(async (sql) => {
      const missing = await cli(sql, "publish", "--release", "nope");
      expect(missing.code).toBe(1);
      expect(missing.err).toContain('Release "nope" not found');
    });
  });

  test("the evaluation window over: exit 3", async () => {
    await withDb(async (sql) => {
      await staleRelease(sql);
      await expireWindow(sql);
      expect((await cli(sql, "publish", "--release", "r1", "--allow-stale")).code).toBe(3);
    });
  });

  test("a stale release without --allow-stale is exit 1 listing the item; with --json ok false and data.stale", async () => {
    await withDb(async (sql) => {
      const docId = await staleRelease(sql);
      const before = await publishedFlags(sql);

      const human = await cli(sql, "publish", "--release", "r1");
      expect(human.code).toBe(1);
      expect(human.out).toBe(`${docId} de title\n`);
      expect(human.err).toContain("stale items");

      const json = await cli(sql, "publish", "--release", "r1", "--json");
      expect(json.code).toBe(1);
      expect(JSON.parse(json.out)).toMatchObject({
        ok: false,
        partial: false,
        data: { stale: [{ docId, locale: "de", fields: ["title"] }] },
        error: { code: "stale_release" },
      });
      expect(await publishedFlags(sql)).toEqual(before);
    });
  });

  test("--allow-stale publishes it and records the flag in releases.allow_stale", async () => {
    await withDb(async (sql) => {
      await staleRelease(sql);
      const r = await cli(sql, "publish", "--release", "r1", "--allow-stale");
      expect(r.code).toBe(0);
      const [rel] = await sql`select published_at, allow_stale from releases where name = 'r1'`;
      expect(rel!.published_at).not.toBeNull();
      expect(rel!.allow_stale).toBe(true);
    });
  });

  test("release publish handles a stale release exactly the same way", async () => {
    await withDb(async (sql) => {
      const docId = await staleRelease(sql);
      const human = await cli(sql, "release", "publish", "r1");
      expect(human.code).toBe(1);
      expect(human.out).toBe(`${docId} de title\n`);

      const json = await cli(sql, "release", "publish", "r1", "--json");
      expect(json.code).toBe(1);
      expect(JSON.parse(json.out)).toMatchObject({
        ok: false,
        data: { stale: [{ docId, locale: "de", fields: ["title"] }] },
        error: { code: "stale_release" },
      });

      const forced = await cli(sql, "release", "publish", "r1", "--allow-stale");
      expect(forced.code).toBe(0);
      const [rel] = await sql`select allow_stale from releases where name = 'r1'`;
      expect(rel!.allow_stale).toBe(true);
    });
  });
});
