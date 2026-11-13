import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { migrate } from "@mogging/core";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { aiConfigFor, config, testDeps } from "./fixtures.js";
import { dataOf, mockModel } from "./mockModel.js";
import type { MockCallOptions } from "./mockModel.js";

/**
 * Spec section 11, driven through `run()` in-process: the importer, the mock model and one database, nine steps,
 * each of which must exit 0. The assertions read the real outputs and rows, so a regression in any step fails here.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A content folder with one English document; `write` replaces its text. */
function contentFolder(): { dir: string; write(title: string, body: string): void } {
  const root = mkdtempSync(join(tmpdir(), "mogging-cli-acceptance-"));
  dirs.push(root);
  const dir = join(root, "content");
  mkdirSync(join(dir, "en", "docs"), { recursive: true });
  return {
    dir,
    write: (title, body) => writeFileSync(join(dir, "en", "docs", "intro.md"), `---\ntitle: ${title}\n---\n${body}\n`),
  };
}

/** The model's answer to one call: for every field of the request, the German text of that field. */
const german = (words: Record<string, string>) => (options: MockCallOptions) => ({
  fields: Object.fromEntries(Object.keys(dataOf(options).translate).map((key) => [key, words[key] ?? `no German text for ${key}`])),
  glossaryTermsUsed: [],
});

type Row = { locale: string; field: string; state: string };
type Doc = { ok: boolean; partial: boolean; data: Record<string, unknown> };

test("section 11: import, status, compile, review, release, query, edit, status, compile again", async () => {
  await withTestDb(async (sql: Sql) => {
    await migrate(sql);
    const model = mockModel([
      german({ title: "Einleitung", body: "Hallo" }),
      german({ body: "Hallo zusammen" }),
    ]);
    const cli = async (...args: string[]) => {
      const t = testDeps(sql, { loadModule: async () => ({ config, ai: aiConfigFor(model) }) });
      const code = await run(args, t);
      return { code, out: t.stdout(), err: t.stderr() };
    };
    const json = async (...args: string[]) => {
      const r = await cli(...args, "--json");
      expect(r.code, r.err).toBe(0);
      return JSON.parse(r.out) as Doc;
    };
    const rows = async (...args: string[]) => ((await json("status", ...args)).data.rows as Row[]).filter((r) => r.locale !== "shared");
    // The rows of the model's own calls: approval copies them forward with an approver and writes marker rows.
    const provenance = async () =>
      (await sql`select field_path from content_provenance where locale = 'de' and model_id = 'mock/translate' and approved_by is null order by id`) as unknown as Array<{
        field_path: string;
      }>;
    const deHead = async () =>
      (await sql`select state from document_localized where locale = 'de' and is_head_draft`) as unknown as Array<{ state: string }>;

    // (1) import --publish of content/en/docs/intro.md
    const content = contentFolder();
    content.write("Intro", "Hello");
    const imported = await cli("import", content.dir, "--publish");
    expect(imported.code, imported.err).toBe(0);
    expect(imported.out).toContain("created en/docs/intro.md");

    // (2) status: both de fields are missing
    const status = await cli("status");
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain("de: 2 missing");
    expect(status.out).toContain("docs/intro title missing");
    expect(status.out).toContain("docs/intro body missing");
    const missing = (await rows("--locale", "de")).map((r) => `${r.field} ${r.state}`).sort();
    expect(missing).toEqual(["body missing", "title missing"]);

    // (3) compile --locales de --budget 1: one DRAFT_AI head, two provenance rows, one request for both fields
    const first = await cli("compile", "--locales", "de", "--budget", "1");
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain("enqueued 1, duplicates 0, skipped 0");
    expect(first.out).toContain("completed 1, failed 0");
    expect(await deHead()).toEqual([{ state: "DRAFT_AI" }]);
    expect((await provenance()).map((p) => p.field_path).sort()).toEqual(["body", "title"]);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(Object.keys(dataOf(model.doGenerateCalls[0]!).translate).sort()).toEqual(["body", "title"]);

    // (4) review --approve-clean approves it
    const approved = await cli("review", "--approve-clean");
    expect(approved.code, approved.err).toBe(0);
    expect(approved.out).toContain("approved 1");
    expect(await deHead()).toEqual([{ state: "APPROVED" }]);

    // (5) a release with the approved head, published
    const created = await cli("release", "create", "r1");
    expect(created.code, created.err).toBe(0);
    expect(created.out).toContain("created release r1");
    const added = await cli("release", "add", "r1", "--all-approved");
    expect(added.code, added.err).toBe(0);
    expect(added.out).toMatch(/^added docs\/intro de v\d+$/m);
    const publishedRelease = await cli("release", "publish", "r1");
    expect(publishedRelease.code, publishedRelease.err).toBe(0);
    expect(publishedRelease.out).toContain("published release r1");

    // (6) query: German where it exists, English with `fellBack` where it was never compiled
    const de = (await json("query", "docs/intro", "--locale", "de")).data as {
      data: { title: string; body: unknown }; fellBack: Record<string, string>; missing: string[];
    };
    expect(de.data.title).toBe("Einleitung");
    expect(JSON.stringify(de.data.body)).toContain("Hallo");
    expect(de.fellBack).toEqual({});
    expect(de.missing).toEqual([]);
    const fr = (await json("query", "docs/intro", "--locale", "fr")).data as {
      data: { title: string; body: unknown }; fellBack: Record<string, string>;
    };
    expect(fr.data.title).toBe("Intro");
    expect(JSON.stringify(fr.data.body)).toContain("Hello");
    expect(fr.fellBack).toEqual({ title: "en", body: "en" });

    // (7) edit the English body and import again
    content.write("Intro", "Hello, world");
    const reimported = await cli("import", content.dir, "--publish");
    expect(reimported.code, reimported.err).toBe(0);
    expect(reimported.out).toContain("updated en/docs/intro.md");

    // (8) status: exactly one stale row for the translated locale, and it is the body
    const after = await cli("status");
    expect(after.code, after.err).toBe(0);
    expect(after.out).toContain("de: 1 stale");
    expect(after.out).toContain("docs/intro body stale");
    const all = await rows();
    expect(all.filter((r) => r.state === "stale").map((r) => `${r.locale} ${r.field}`)).toEqual(["de body"]);
    expect(all.filter((r) => r.locale === "de" && r.field === "title").map((r) => r.state)).toEqual(["current"]);
    expect(all.filter((r) => r.locale === "fr").map((r) => r.state)).toEqual(["missing", "missing"]);

    // (9) compile again buys only the stale field: one more de provenance row, for body, and a request for body alone
    const before = (await provenance()).length;
    expect(before).toBe(2);
    const second = await cli("compile", "--locales", "de", "--budget", "1");
    expect(second.code, second.err).toBe(0);
    expect(second.out).toContain("enqueued 1, duplicates 0, skipped 0");
    expect(second.out).toContain("completed 1, failed 0");
    const rowsAfter = await provenance();
    expect(rowsAfter).toHaveLength(3);
    expect(rowsAfter[2]!.field_path).toBe("body");
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(Object.keys(dataOf(model.doGenerateCalls[1]!).translate)).toEqual(["body"]);
    expect(await deHead()).toEqual([{ state: "DRAFT_AI" }]);
  });
});
