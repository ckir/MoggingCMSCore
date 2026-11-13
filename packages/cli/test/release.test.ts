import { describe, expect, test } from "vitest";
import { approve, migrate, publish, saveDraft } from "@mogging/core";
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

const review = (target: string, locale: string) =>
  `${target} ${locale} is an unapproved AI draft: run \`mogging review\` first`;

/** `locale` gets an APPROVED head (an AI draft, approved); returns its version. */
async function approved(sql: Sql, docId: string, locale: string): Promise<number> {
  await aiDraft(sql, docId, locale, `title ${locale}`);
  return (await approve(coreCtx(sql), { docId, locale })).version;
}

const humanDraft = async (sql: Sql, docId: string, locale: string): Promise<number> =>
  (await saveDraft(coreCtx(sql), { docId, locale, data: { title: `human ${locale}` } })).version;

const items = async (sql: Sql) =>
  (await sql`select doc_id, locale, draft_version from release_items order by doc_id, locale`) as unknown as Array<{
    doc_id: string; locale: string; draft_version: number;
  }>;

describe("mogging release: create, list, add, publish", () => {
  test("a round trip", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const version = await humanDraft(sql, docId, "de");

      const created = await cli(sql, "release", "create", "r1", "--actor", "tester");
      expect(created).toMatchObject({ code: 0, out: "created release r1 (id 1)\n" });

      const listed = await cli(sql, "release", "list");
      expect(listed.code).toBe(0);
      expect(listed.out.split("\n")[0]).toBe("id  name  items  published  created by");
      expect(listed.out.split("\n")[1]).toBe("1   r1    0      -          tester");

      const added = await cli(sql, "release", "add", "r1", "docs/intro", "--locale", "de");
      expect(added).toMatchObject({ code: 0, out: `added docs/intro de v${version}\n` });
      expect(await items(sql)).toEqual([{ doc_id: docId, locale: "de", draft_version: version }]);
      expect((await cli(sql, "release", "list")).out.split("\n")[1]).toMatch(/^1 {3}r1 {4}1 {6}-/);

      const published = await cli(sql, "release", "publish", "r1");
      expect(published).toMatchObject({ code: 0, out: "published release r1\n" });
      const [de] = await sql`select is_head_published from document_localized where doc_id = ${docId} and locale = 'de'`;
      expect(de!.is_head_published).toBe(true);
      expect((await cli(sql, "release", "list")).out.split("\n")[1]).toMatch(/^1 {3}r1 {4}1 {6}\d{4}-\d\d-\d\dT/);
    });
  });

  test("--json: create -> { id }, list -> the array, release publish -> null", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await humanDraft(sql, docId, "de");
      const created = JSON.parse((await cli(sql, "release", "create", "r1", "--json", "--actor", "tester")).out) as { data: unknown };
      expect(created.data).toEqual({ id: "1" });

      await cli(sql, "release", "add", "r1", "docs/intro");
      const listed = JSON.parse((await cli(sql, "release", "list", "--json")).out) as { data: unknown[] };
      expect(listed.data).toEqual([
        { id: "1", name: "r1", createdBy: "tester", createdAt: expect.any(String), publishedAt: null, allowStale: false, itemCount: 1 },
      ]);

      const published = JSON.parse((await cli(sql, "release", "publish", "r1", "--json")).out) as { ok: boolean; data: unknown };
      expect(published).toMatchObject({ ok: true, data: null });
    });
  });

  test("list with no release says so", async () => {
    await withDb(async (sql) => {
      expect(await cli(sql, "release", "list")).toMatchObject({ code: 0, out: "no releases\n" });
    });
  });

  test("a duplicate name is exit 1 with the conflict message", async () => {
    await withDb(async (sql) => {
      await cli(sql, "release", "create", "r1");
      const r = await cli(sql, "release", "create", "r1");
      expect(r.code).toBe(1);
      expect(r.err).toContain('Release "r1" already exists');
    });
  });

  test("an unknown release is exit 1 for add and publish; an empty or published release surfaces core's refusal", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await humanDraft(sql, docId, "de");
      const add = await cli(sql, "release", "add", "nope", "docs/intro");
      expect(add.code).toBe(1);
      expect(add.err).toContain('Release "nope" not found');
      expect((await cli(sql, "release", "publish", "nope")).err).toContain('Release "nope" not found');

      await cli(sql, "release", "create", "r1");
      const empty = await cli(sql, "release", "publish", "r1");
      expect(empty.code).toBe(1);
      expect(empty.err).toContain("release is empty");

      await cli(sql, "release", "add", "r1", "docs/intro");
      expect((await cli(sql, "release", "publish", "r1")).code).toBe(0);
      const again = await cli(sql, "release", "publish", "r1");
      expect(again.code).toBe(1);
      expect(again.err).toContain("release already published");
    });
  });
});

describe("mogging release add --all-approved", () => {
  test("adds every APPROVED head and nothing else", async () => {
    await withDb(async (sql) => {
      const a = await publishedDoc(sql, "a");
      const b = await publishedDoc(sql, "b");
      const aDe = await approved(sql, a, "de");
      const bFr = await approved(sql, b, "fr");
      await humanDraft(sql, b, "de"); // DRAFT_HUMAN: not taken
      await aiDraft(sql, a, "fr", "Introduction"); // DRAFT_AI: not taken
      await cli(sql, "release", "create", "r1");

      const r = await cli(sql, "release", "add", "r1", "--all-approved");
      expect(r.code).toBe(0);
      // `listDraftHeads` orders by document id, which is random: compare as sets.
      expect(r.out.split("\n").sort()).toEqual(["", `added docs/a de v${aDe}`, `added docs/b fr v${bFr}`]);
      expect(await items(sql)).toHaveLength(2);
      expect(await items(sql)).toEqual(
        expect.arrayContaining([
          { doc_id: a, locale: "de", draft_version: aDe },
          { doc_id: b, locale: "fr", draft_version: bFr },
        ]),
      );
    });
  });

  test("--collection and --locale narrow it", async () => {
    await withDb(async (sql) => {
      const a = await publishedDoc(sql, "a");
      await approved(sql, a, "de");
      const frVersion = await approved(sql, a, "fr");
      await cli(sql, "release", "create", "r1");
      const r = await cli(sql, "release", "add", "r1", "--all-approved", "--collection", "docs", "--locale", "fr");
      expect(r.out).toBe(`added docs/a fr v${frVersion}\n`);
      expect(await items(sql)).toHaveLength(1);
    });
  });

  test("with no approved head prints nothing to add, items [], exit 0", async () => {
    await withDb(async (sql) => {
      const a = await publishedDoc(sql, "a");
      await humanDraft(sql, a, "de");
      await cli(sql, "release", "create", "r1");
      const r = await cli(sql, "release", "add", "r1", "--all-approved");
      expect(r).toMatchObject({ code: 0, out: "nothing to add\n" });
      const json = await cli(sql, "release", "add", "r1", "--all-approved", "--json");
      expect(JSON.parse(json.out)).toMatchObject({ ok: true, partial: false, data: { items: [] } });
    });
  });

  test("an undeclared --locale or an unknown --collection is exit 1", async () => {
    await withDb(async (sql) => {
      await cli(sql, "release", "create", "r1");
      const locale = await cli(sql, "release", "add", "r1", "--all-approved", "--locale", "xx");
      expect(locale.code).toBe(1);
      expect(locale.err).toContain('Locale "xx" is not declared');
      const collection = await cli(sql, "release", "add", "r1", "--all-approved", "--collection", "nope");
      expect(collection.code).toBe(1);
      expect(collection.err).toContain('Unknown collection "nope"');
    });
  });
});

describe("mogging release add <targets>", () => {
  test("takes every DRAFT_HUMAN and APPROVED head of the target, restricted by --locale", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const de = await humanDraft(sql, docId, "de");
      const fr = await approved(sql, docId, "fr");
      await cli(sql, "release", "create", "r1");
      const only = await cli(sql, "release", "add", "r1", "docs/intro", "--locale", "fr");
      expect(only.out).toBe(`added docs/intro fr v${fr}\n`);
      const rest = await cli(sql, "release", "add", "r1", "docs/intro");
      expect(rest.code).toBe(0);
      expect(rest.out).toBe(`added docs/intro de v${de}\nalready in release docs/intro fr v${fr}\n`);
    });
  });

  test("a DRAFT_AI head is refused with the review message and nothing is added", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await aiDraft(sql, docId, "de", "Einleitung");
      await cli(sql, "release", "create", "r1");
      const r = await cli(sql, "release", "add", "r1", "docs/intro");
      expect(r.code).toBe(1);
      expect(r.out).toBe(`refused: ${review("docs/intro", "de")}\n`);
      expect(r.err).toContain(review("docs/intro", "de"));
      expect(await items(sql)).toEqual([]);

      const withLocale = await cli(sql, "release", "add", "r1", "docs/intro", "--locale", "de");
      expect(withLocale.code).toBe(1);
      expect(withLocale.out).toBe(`refused: ${review("docs/intro", "de")}\n`);
      expect(await items(sql)).toEqual([]);
    });
  });

  test("adding twice reports already in release and exits 0", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const version = await humanDraft(sql, docId, "de");
      await cli(sql, "release", "create", "r1");
      await cli(sql, "release", "add", "r1", "docs/intro");
      const again = await cli(sql, "release", "add", "r1", "docs/intro", "--json");
      expect(again.code).toBe(0);
      expect(JSON.parse(again.out)).toMatchObject({
        ok: true,
        partial: false,
        data: { items: [{ target: "docs/intro", locale: "de", outcome: "already in release", version }] },
      });
      expect((await cli(sql, "release", "add", "r1", "docs/intro")).out).toBe(`already in release docs/intro de v${version}\n`);
    });
  });

  test("one pair already in the release plus one DRAFT_AI pair is exit 4", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const de = await humanDraft(sql, docId, "de");
      await cli(sql, "release", "create", "r1");
      await cli(sql, "release", "add", "r1", "docs/intro", "--locale", "de");
      await aiDraft(sql, docId, "fr", "Introduction");
      const r = await cli(sql, "release", "add", "r1", "docs/intro");
      expect(r.code).toBe(4);
      expect(r.out).toBe(`already in release docs/intro de v${de}\nrefused: ${review("docs/intro", "fr")}\n`);
      const json = await cli(sql, "release", "add", "r1", "docs/intro", "--json");
      expect(JSON.parse(json.out)).toMatchObject({ ok: true, partial: true });
    });
  });

  test("a pair whose head moved to a newer version since it was added is refused with the conflict: exit 1", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      const v1 = await approved(sql, docId, "de");
      await cli(sql, "release", "create", "r1");
      expect((await cli(sql, "release", "add", "r1", "docs/intro")).code).toBe(0);
      const v2 = await approved(sql, docId, "de"); // a second AI draft, approved: the head is a newer version
      expect(v2).toBeGreaterThan(v1);

      const r = await cli(sql, "release", "add", "r1", "docs/intro");
      expect(r.code).toBe(1);
      expect(r.out).toBe(`refused: ${docId}/de is in release 1 at version ${v1}; the current head is version ${v2}\n`);
      expect(await items(sql)).toEqual([{ doc_id: docId, locale: "de", draft_version: v1 }]);
    });
  });

  test("a target published since its approval is refused (no draft head); the others are added: exit 4", async () => {
    await withDb(async (sql) => {
      const a = await publishedDoc(sql, "a");
      const b = await publishedDoc(sql, "b");
      await approved(sql, a, "de");
      await publish(coreCtx(sql), { docId: a, locale: "de" });
      const bDe = await approved(sql, b, "de");
      await cli(sql, "release", "create", "r1");

      const r = await cli(sql, "release", "add", "r1", "docs/a", "docs/b");
      expect(r.code).toBe(4);
      expect(r.out).toBe(`refused: docs/a has no draft head to add\nadded docs/b de v${bDe}\n`);
      expect(await items(sql)).toEqual([{ doc_id: b, locale: "de", draft_version: bDe }]);

      const json = await cli(sql, "release", "add", "r1", "docs/a", "--locale", "de", "--json");
      expect(json.code).toBe(1);
      expect(JSON.parse(json.out)).toMatchObject({
        ok: false,
        data: { items: [{ target: "docs/a", locale: "de", outcome: "refused", message: "docs/a de has no draft head to add" }] },
        error: { code: "ReleaseAddFailed" },
      });
    });
  });

  test("a refusal does not stop the run: the items after it are still added", async () => {
    await withDb(async (sql) => {
      const a = await publishedDoc(sql, "a");
      const b = await publishedDoc(sql, "b");
      await aiDraft(sql, a, "de", "Einleitung");
      const bDe = await humanDraft(sql, b, "de");
      await cli(sql, "release", "create", "r1");
      const r = await cli(sql, "release", "add", "r1", "docs/a", "docs/b");
      expect(r.code).toBe(4);
      expect(r.out).toBe(`refused: ${review("docs/a", "de")}\nadded docs/b de v${bDe}\n`);
    });
  });

  test("an unknown target adds nothing at all: exit 1", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await humanDraft(sql, docId, "de");
      await cli(sql, "release", "create", "r1");
      const r = await cli(sql, "release", "add", "r1", "docs/intro", "docs/nope");
      expect(r.code).toBe(1);
      expect(r.err).toContain("not found");
      expect(await items(sql)).toEqual([]);
    });
  });

  test("an undeclared --locale is exit 1", async () => {
    await withDb(async (sql) => {
      await publishedDoc(sql);
      await cli(sql, "release", "create", "r1");
      const r = await cli(sql, "release", "add", "r1", "docs/intro", "--locale", "xx");
      expect(r.code).toBe(1);
      expect(r.err).toContain('Locale "xx" is not declared in the config');
    });
  });

  test("is not licence-guarded, but release publish is", async () => {
    await withDb(async (sql) => {
      const docId = await publishedDoc(sql);
      await humanDraft(sql, docId, "de");
      await cli(sql, "release", "create", "r1");
      await setFirstMigration(sql, new Date(Date.now() - 31 * DAY));
      expect((await cli(sql, "release", "add", "r1", "docs/intro")).code).toBe(0);
      expect((await cli(sql, "release", "publish", "r1")).code).toBe(3);
    });
  });
});

describe("mogging release: usage", () => {
  const cases: Array<[string, string[], string]> = [
    ["no verb", ["release"], "missing argument"],
    ["an unknown verb", ["release", "frobnicate"], "frobnicate"],
    ["create without a name", ["release", "create"], "release create"],
    ["create with two names", ["release", "create", "a", "b"], "release create"],
    ["list with an argument", ["release", "list", "a"], "release list"],
    ["add without a release name", ["release", "add"], "release add"],
    ["add r1 with no target and no --all-approved", ["release", "add", "r1"], "--all-approved"],
    ["add with targets and --all-approved", ["release", "add", "r1", "docs/intro", "--all-approved"], "--all-approved"],
    ["add --collection without --all-approved", ["release", "add", "r1", "docs/intro", "--collection", "docs"], "--collection"],
    ["publish without a name", ["release", "publish"], "release publish"],
    ["publish with two names", ["release", "publish", "a", "b"], "release publish"],
    ["--locale on create", ["release", "create", "r1", "--locale", "de"], "--locale"],
    ["--allow-stale on add", ["release", "add", "r1", "docs/intro", "--allow-stale"], "--allow-stale"],
    ["--all-approved on publish", ["release", "publish", "r1", "--all-approved"], "--all-approved"],
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
