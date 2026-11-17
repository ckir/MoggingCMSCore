import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDocument, getSyncState, migrate, publish, saveDraft } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { config, coreCtx, md, publishedDoc, testDeps } from "./fixtures.js";
import { starlightConfig, starlightDeps, starlightProject } from "./starlightFixtures.js";

/** A per-test schema with the migrations applied. */
const withDb = (fn: (sql: Sql) => Promise<void>) =>
  withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql);
  });

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mogging-cli-content-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * en and de imported while en is still a draft (so de records no source hashes), then published:
 * every de field is `untracked`.
 */
async function seedUntracked(sql: Sql): Promise<void> {
  const dir = tree({
    "en/docs/intro.md": "---\ntitle: Intro\n---\nHello\n",
    "de/docs/intro.md": "---\ntitle: Einleitung\n---\nHallo\n",
  });
  expect(await run(["import", dir], testDeps(sql))).toBe(0);
  expect(await run(["import", dir, "--publish"], testDeps(sql))).toBe(0);
}

async function states(sql: Sql): Promise<Record<string, string>> {
  const rows = await getSyncState({ sql, config, actor: "test" }, { collection: "docs", locale: "de" });
  return Object.fromEntries(rows.map((r) => [r.field, r.state]));
}

describe("mogging track", () => {
  test("tracks every untracked field and reports them; a second call says nothing is untracked", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      expect(await states(sql)).toEqual({ body: "untracked", title: "untracked" });

      const first = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de"], first)).toBe(0);
      expect(first.stdout()).toBe("tracked docs/intro de body\ntracked docs/intro de title\n");
      expect(await states(sql)).toEqual({ body: "current", title: "current" });

      const second = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de"], second)).toBe(0);
      expect(second.stdout()).toBe("nothing untracked for docs/intro (de)\n");
    });
  });

  test("--fields tracks only the named fields (split on commas and trimmed)", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      const t = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de", "--fields", " title "], t)).toBe(0);
      expect(t.stdout()).toBe("tracked docs/intro de title\n");
      expect(await states(sql)).toEqual({ body: "untracked", title: "current" });

      const rest = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de", "--fields", "body, title"], rest)).toBe(0);
      expect(rest.stdout()).toBe("tracked docs/intro de body\ntracked docs/intro de title\n");
      expect(await states(sql)).toEqual({ body: "current", title: "current" });
    });
  });

  test("--json data is null", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      const t = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de", "--json"], t)).toBe(0);
      const doc = JSON.parse(t.stdout()) as { ok: boolean; partial: boolean; data: unknown };
      expect(doc.ok).toBe(true);
      expect(doc.partial).toBe(false);
      expect(doc.data).toBeNull();

      const again = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de", "--json"], again)).toBe(0);
      expect((JSON.parse(again.stdout()) as { data: unknown }).data).toBeNull();
    });
  });

  test("an empty entry in --fields is a usage error and nothing is tracked", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      for (const fields of ["title,,body", "title,", ""]) {
        const t = testDeps(sql);
        expect(await run(["track", "docs/intro", "--locale", "de", "--fields", fields], t)).toBe(2);
        expect(t.stderr()).toContain("--fields");
      }
      expect(await states(sql)).toEqual({ body: "untracked", title: "untracked" });
    });
  });

  test("a missing --locale or target is a usage error", async () => {
    await withDb(async (sql) => {
      const noLocale = testDeps(sql);
      expect(await run(["track", "docs/intro"], noLocale)).toBe(2);
      expect(noLocale.stderr()).toContain("--locale");
      expect(await run(["track", "--locale", "de"], testDeps(sql))).toBe(2);
    });
  });

  test("an unknown document is exit 1 and the source locale is refused", async () => {
    await withDb(async (sql) => {
      await seedUntracked(sql);
      const missing = testDeps(sql);
      expect(await run(["track", "docs/nope", "--locale", "de"], missing)).toBe(1);
      expect(missing.stderr()).toContain("not found");
      expect(await run(["track", "docs/intro", "--locale", "en"], testDeps(sql))).toBe(1);
    });
  });
});

/** A published `docs/<slug>` whose `de` head (title and body) is published with `untracked: true`. */
async function untrackedDoc(sql: Sql, slug: string): Promise<string> {
  const docId = await publishedDoc(sql, slug);
  await saveDraft(coreCtx(sql), { docId, locale: "de", data: { title: `T ${slug}`, body: md(`B ${slug}`) }, untracked: true });
  await publish(coreCtx(sql), { docId, locale: "de" });
  return docId;
}

/** A published `docs/<slug>` whose `de` head records the source hashes, so every field is `current`. */
async function currentDoc(sql: Sql, slug: string): Promise<string> {
  const docId = await publishedDoc(sql, slug);
  await saveDraft(coreCtx(sql), { docId, locale: "de", data: { title: `T ${slug}`, body: md(`B ${slug}`) } });
  await publish(coreCtx(sql), { docId, locale: "de" });
  return docId;
}

const deStates = async (sql: Sql) =>
  (await getSyncState(coreCtx(sql), { collection: "docs", locale: "de" })).map((r) => `${r.docId}:${r.field}:${r.state}`);

const trackedDocIds = async (sql: Sql) =>
  (await sql`select distinct doc_id from content_provenance where model_id = 'human:track' order by doc_id`).map(
    (r) => r.doc_id as string,
  );

describe("mogging track --collection", () => {
  test("--collection tracks every untracked field of every live document", async () => {
    await withDb(async (sql) => {
      // Created in this order so that slug order (alpha, beta) differs from creation order.
      const beta = await untrackedDoc(sql, "beta");
      const alpha = await untrackedDoc(sql, "alpha");
      const gamma = await currentDoc(sql, "gamma");
      expect((await deStates(sql)).filter((s) => s.endsWith(":untracked"))).toHaveLength(4);

      const t = testDeps(sql);
      expect(await run(["track", "--collection", "docs", "--locale", "de"], t)).toBe(0);
      expect(t.stdout()).toBe(
        [
          "tracked docs/alpha de body", "tracked docs/alpha de title",
          "tracked docs/beta de body", "tracked docs/beta de title", "",
        ].join("\n"),
      );
      expect((await deStates(sql)).some((s) => s.endsWith(":untracked"))).toBe(false);
      expect(await trackedDocIds(sql)).toEqual([alpha, beta].sort());
      expect(await trackedDocIds(sql)).not.toContain(gamma);
    });
  });

  test("--json data lists the tracked documents in slug order", async () => {
    await withDb(async (sql) => {
      const beta = await untrackedDoc(sql, "beta");
      const alpha = await untrackedDoc(sql, "alpha");
      const t = testDeps(sql);
      expect(await run(["track", "--collection", "docs", "--locale", "de", "--json"], t)).toBe(0);
      const doc = JSON.parse(t.stdout()) as { ok: boolean; data: unknown };
      expect(doc.ok).toBe(true);
      expect(doc.data).toEqual({
        tracked: [
          { docId: alpha, slug: "alpha", locale: "de", fields: ["body", "title"] },
          { docId: beta, slug: "beta", locale: "de", fields: ["body", "title"] },
        ],
      });
    });
  });

  test("--dry-run tracks nothing", async () => {
    await withDb(async (sql) => {
      await untrackedDoc(sql, "alpha");
      const before = await deStates(sql);
      const t = testDeps(sql);
      expect(await run(["track", "--collection", "docs", "--locale", "de", "--dry-run"], t)).toBe(0);
      expect(t.stdout()).toBe(
        "dry run: nothing was written\nwould track docs/alpha de body\nwould track docs/alpha de title\n",
      );
      expect(await deStates(sql)).toEqual(before);
      expect(await trackedDocIds(sql)).toEqual([]);
    });
  });

  test("nothing untracked prints the one line", async () => {
    await withDb(async (sql) => {
      await currentDoc(sql, "gamma");
      const t = testDeps(sql);
      expect(await run(["track", "--collection", "docs", "--locale", "de"], t)).toBe(0);
      expect(t.stdout()).toBe("nothing untracked in docs (de)\n");
      const json = testDeps(sql);
      expect(await run(["track", "--collection", "docs", "--locale", "de", "--json"], json)).toBe(0);
      expect((JSON.parse(json.stdout()) as { data: unknown }).data).toEqual({ tracked: [] });
    });
  });

  test("--collection with a positional, and neither, are exit 2", async () => {
    await withDb(async (sql) => {
      const both = testDeps(sql);
      expect(await run(["track", "docs/intro", "--collection", "docs", "--locale", "de"], both)).toBe(2);
      expect(both.stderr()).toContain("track: give <collection>/<slug> or --collection <c>, not both");
      const neither = testDeps(sql);
      expect(await run(["track", "--locale", "de"], neither)).toBe(2);
      expect(neither.stderr()).toContain("track: give <collection>/<slug> or --collection <c>");
      expect(neither.stderr()).not.toContain("not both");
    });
  });

  test("--fields with --collection and --dry-run with a positional are exit 2", async () => {
    await withDb(async (sql) => {
      const fields = testDeps(sql);
      expect(await run(["track", "--collection", "docs", "--locale", "de", "--fields", "title"], fields)).toBe(2);
      expect(fields.stderr()).toContain("track: --fields needs <collection>/<slug>");
      const dry = testDeps(sql);
      expect(await run(["track", "docs/intro", "--locale", "de", "--dry-run"], dry)).toBe(2);
      expect(dry.stderr()).toContain("track: --dry-run needs --collection");
    });
  });

  test("an undeclared collection is exit 2, naming the declared ones, before connecting", async () => {
    await withDb(async (sql) => {
      let connected = false;
      const t = testDeps(sql, { connect: () => { connected = true; throw new Error("connected"); } });
      expect(await run(["track", "--collection", "nope", "--locale", "de"], t)).toBe(2);
      expect(t.stderr()).toContain('unknown collection "nope" (declared: docs)');
      expect(connected).toBe(false);
    });
  });
});

describe("mogging track --collection --locale", () => {
  test("a Starlight folder spelling (zh-cn) is normalized to the declared tag zh-CN in the lines and in --json", async () => {
    await withDb(async (sql) => {
      const root = starlightProject({});
      const ctx = { sql, config: starlightConfig, actor: "test" };
      const { id: docId } = await createDocument(ctx, { collection: "docs" });
      await saveDraft(ctx, { docId, locale: "shared", data: { slug: "intro" } });
      await saveDraft(ctx, { docId, locale: "en", data: { title: "Intro" } });
      await publish(ctx, { docId, locale: "shared" });
      await publish(ctx, { docId, locale: "en" });
      await saveDraft(ctx, { docId, locale: "zh-CN", data: { title: "介绍" }, untracked: true });
      await publish(ctx, { docId, locale: "zh-CN" });

      const text = starlightDeps(sql, root);
      expect(await run(["track", "--collection", "docs", "--locale", "zh-cn", "--dry-run"], text)).toBe(0);
      expect(text.stdout()).toBe("dry run: nothing was written\nwould track docs/intro zh-CN title\n");

      const json = starlightDeps(sql, root);
      expect(await run(["track", "--collection", "docs", "--locale", "zh-cn", "--json"], json)).toBe(0);
      const doc = JSON.parse(json.stdout()) as { data: { tracked: Array<{ locale: string; fields: string[] }> } };
      expect(doc.data.tracked.map((d) => d.locale)).toEqual(["zh-CN"]);
      expect(doc.data.tracked[0]!.fields).toEqual(["title"]);
    });
  });

  test("an undeclared, a source and a malformed locale are exit 2 before connecting", async () => {
    await withDb(async (sql) => {
      for (const [locale, reason] of [
        ["it", "is not declared in the config"],
        ["en", "is the source locale"],
        ["not a locale", ""],
      ] as const) {
        let connected = false;
        const t = testDeps(sql, { connect: () => { connected = true; throw new Error("connected"); } });
        expect(await run(["track", "--collection", "docs", "--locale", locale], t)).toBe(2);
        expect(t.stderr()).toContain(`track: --locale ${locale}: `);
        expect(t.stderr()).toContain(reason);
        expect(connected).toBe(false);
      }
    });
  });
});
