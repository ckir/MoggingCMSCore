import { afterAll, beforeAll, expect, test } from "vitest";
import type { Sql } from "postgres";
import * as main from "@mogging/core";
import * as internal from "../src/internal.js";
import { beginWriteRun, publishWithinRun, saveDraftWithinTx } from "../src/internal.js";
import type { PublishInput, SaveDraftInput, Tx, WriteRun } from "../src/internal.js";
import { LicenceError, NotFoundError, ValidationError, createDocument, migrate, publish, saveDraft } from "../src/index.js";
import type { Ctx } from "../src/index.js";
import { withTestDb } from "./db.js";
import { ctxFor, md } from "./fixtures.js";

const DAY = 86_400_000;
const NAMES = ["beginWriteRun", "publishWithinRun", "saveDraftWithinTx"];

// An expired evaluation is only reachable with no licence key in the environment.
let savedKey: string | undefined;
beforeAll(() => { savedKey = process.env.MOGGING_LICENSE_KEY; delete process.env.MOGGING_LICENSE_KEY; });
afterAll(() => { if (savedKey !== undefined) process.env.MOGGING_LICENSE_KEY = savedKey; });

/** Moves the evaluation window's start (the technique of packages/cli/test/fixtures.ts). */
const setFirstMigration = (sql: Sql, at: Date) => sql`update migrations set applied_at = ${at}`;

test("the internal subpath exports exactly the write-run surface and the main entry has none of it", async () => {
  expect(Object.keys(internal).sort()).toEqual(NAMES);
  for (const name of NAMES) expect(typeof (internal as Record<string, unknown>)[name], name).toBe("function");
  const viaSubpath = await import("@mogging/core/internal");
  expect(Object.keys(viaSubpath).sort()).toEqual(NAMES);
  for (const name of NAMES) {
    expect(name in main, `main entry leaks ${name}`).toBe(false);
    expect((await import("../src/index.js")) as Record<string, unknown>).not.toHaveProperty(name);
  }
  // Type-level re-exports compile (erased at run time).
  const types: [WriteRun?, Tx?, SaveDraftInput?, PublishInput?] = [];
  expect(types).toHaveLength(0);
});

test("beginWriteRun: a licence refusal wins over a NUL actor; a NUL actor is refused once licensed", async () => withTestDb(async (sql) => {
  await migrate(sql);
  await setFirstMigration(sql, new Date(Date.now() - 31 * DAY));
  await expect(beginWriteRun(ctxFor(sql))).rejects.toBeInstanceOf(LicenceError);
  await expect(beginWriteRun(ctxFor(sql, "bad\u0000actor"))).rejects.toBeInstanceOf(LicenceError);

  await setFirstMigration(sql, new Date());
  await expect(beginWriteRun(ctxFor(sql, "bad\u0000actor"))).rejects.toBeInstanceOf(ValidationError);
  await expect(beginWriteRun(ctxFor(sql))).resolves.toBeDefined();
}));

test("beginWriteRun returns a frozen { config, actor } with no sql", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql, "importer");
  const run = await beginWriteRun(ctx);
  expect(run).not.toHaveProperty("sql");
  expect(Object.keys(run).sort()).toEqual(["actor", "config"]);
  expect(run.actor).toBe("importer");
  expect(run.config).toBe(ctx.config);
  expect(Object.isFrozen(run)).toBe(true);
}));

/** A document with published shared and `en` heads in `posts`, slug `slugText`. */
async function seed(ctx: Ctx, slugText: string): Promise<string> {
  const { id: docId } = await createDocument(ctx, { collection: "posts" });
  await saveDraft(ctx, { docId, locale: "shared", data: { slug: slugText } });
  await saveDraft(ctx, { docId, locale: "en", data: { title: "Intro", body: md("Hello") } });
  await publish(ctx, { docId, locale: "shared" });
  await publish(ctx, { docId, locale: "en" });
  return docId;
}

/** Everything the two paths must agree on, with ids and clock-dependent stamps reduced to presence. */
async function endState(sql: Sql, docId: string) {
  const shared = await sql`select version, state, data - 'slug' as data, is_head_published, is_head_draft, created_by, published_by,
    published_at is not null as published, unpublished_by, unpublished_at is not null as unpublished
    from document_shared where doc_id = ${docId} order by version`;
  const localized = await sql`select locale, version, state, data, source_hashes, field_warnings, is_head_published, is_head_draft,
    created_by, published_by, published_at is not null as published, unpublished_by, unpublished_at is not null as unpublished
    from document_localized where doc_id = ${docId} order by locale, version`;
  return { shared: [...shared], localized: [...localized] };
}

for (const untracked of [true, false]) {
  test(`save + publish in one run transaction leaves the rows the public calls leave (${untracked ? "untracked" : "tracked"} save)`, async () => withTestDb(async (sql) => {
    await migrate(sql);
    const ctx = ctxFor(sql, "importer");
    const viaPublic = await seed(ctx, "twin-a");
    const viaRun = await seed(ctx, "twin-b");

    const de = { locale: "de", data: { title: "Einfuehrung", body: md("Hallo") }, ...(untracked ? { untracked: true } : {}) };
    const sharedAgain = { locale: "shared", data: { slug: "twin-next" } };

    for (const input of [de, { ...sharedAgain, data: { slug: "twin-next-a" } }]) {
      const { version } = await saveDraft(ctx, { docId: viaPublic, ...input });
      await publish(ctx, { docId: viaPublic, locale: input.locale, version });
    }

    const run = await beginWriteRun(ctx);
    await sql.begin(async (tx) => {
      await tx`select id from documents where id = ${viaRun} for update`;
      for (const input of [de, { ...sharedAgain, data: { slug: "twin-next-b" } }]) {
        const { version } = await saveDraftWithinTx(tx, run, { docId: viaRun, ...input }, "posts");
        await publishWithinRun(tx, run, { docId: viaRun, locale: input.locale, version }, { collection: "posts", alreadyLocked: true });
      }
    });

    const a = await endState(sql, viaPublic);
    const b = await endState(sql, viaRun);
    expect(b).toEqual(a);
    // The comparison is not vacuous: the new locale and the second shared version both exist and are published.
    expect(a.localized.filter((r) => r.locale === "de")).toHaveLength(1);
    expect(a.localized.find((r) => r.locale === "de")).toMatchObject({ state: "PUBLISHED", is_head_published: true, created_by: "importer", published_by: "importer" });
    expect(a.shared.filter((r) => r.is_head_published)).toHaveLength(1);
    expect(a.shared.find((r) => r.is_head_published)?.version).toBe(2);
    const hashes = a.localized.find((r) => r.locale === "de")!.source_hashes as Record<string, string>;
    expect(Object.keys(hashes).length > 0).toBe(!untracked);
  }));
}

test("publishWithinRun with alreadyLocked false refuses a missing document with the message public publish gives", async () => withTestDb(async (sql) => {
  await migrate(sql);
  const ctx = ctxFor(sql);
  const run = await beginWriteRun(ctx);
  const missing = "00000001-0000-4000-8000-0000000000aa";

  const expected = await publish(ctx, { docId: missing, locale: "en" }).catch((e: unknown) => e);
  expect(expected).toBeInstanceOf(NotFoundError);

  const err = await sql.begin((tx) => publishWithinRun(tx, run, { docId: missing, locale: "en" }, { collection: "posts", alreadyLocked: false }))
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NotFoundError);
  expect((err as Error).message).toBe((expected as Error).message);
  expect((err as Error).message).toBe(`Document "${missing}" not found`);

  const bad = await sql.begin((tx) => publishWithinRun(tx, run, { docId: "nope", locale: "en" }, { collection: "posts", alreadyLocked: false }))
    .catch((e: unknown) => e);
  expect(bad).toBeInstanceOf(NotFoundError);
  expect((bad as Error).message).toBe(`Document "nope" not found`);

  const loc = await sql.begin((tx) => publishWithinRun(tx, run, { docId: missing, locale: "xx" }, { collection: "posts", alreadyLocked: false }))
    .catch((e: unknown) => e);
  expect(loc).toBeInstanceOf(ValidationError);
}));
