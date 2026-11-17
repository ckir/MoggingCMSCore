import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Sql } from "postgres";
import {
  approve, getDocument, getSyncState, migrate, publish, recordAiDraft, rejectDraft, saveDraft, unpublish,
} from "@mogging/core";
import type { Ctx } from "@mogging/core";
import { importFolder } from "../../src/import.js";
import type { ImportReport } from "../../src/import.js";
import { withTestDb } from "../db.js";
import { countingSql, ctxFor, layout, layoutOwn, project } from "./fixtures.js";

const D = "src/content/docs";

async function setup(fn: (sql: Sql, ctx: Ctx) => Promise<void>): Promise<void> {
  await withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql, ctxFor(sql));
  });
}

/** A page file: `title`, extra front-matter lines (each ending in a newline) and a body. */
const page = (title: string, extra = "", body = "Hello"): string => `---\ntitle: ${title}\n${extra}---\n${body}\n`;

const docsProject = (files: Record<string, string>): string =>
  project(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${D}/${k}`, v])));

function put(root: string, rel: string, text: string): void {
  const full = path.join(root, D, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

const run = (ctx: Ctx, root: string, opts: Record<string, unknown> = {}, publishFlag = false): Promise<ImportReport> =>
  importFolder(ctx, { dir: root, publish: publishFlag, starlight: { layout, ...opts } });

const fileOf = (r: ImportReport, rel: string) => r.files.find((f) => f.file === `${D}/${rel}`)!;
const warningsOf = (r: ImportReport, rel: string): string[] =>
  r.warnings.filter((w) => w.file === `${D}/${rel}`).map((w) => w.message);

const bySlug = (ctx: Ctx, slug: string) => getDocument(ctx, { collection: "docs", slug });

async function counts(sql: Sql): Promise<string> {
  const [a] = await sql`select count(*)::int as n from document_shared`;
  const [c] = await sql`select count(*)::int as n from document_localized`;
  return `${a!.n}/${c!.n}`;
}

async function sourceHashes(sql: Sql, docId: string, locale: string): Promise<unknown[]> {
  const rows = await sql`select source_hashes from document_localized where doc_id = ${docId} and locale = ${locale} order by version`;
  return rows.map((r) => r.source_hashes);
}

describe("importFolder, Starlight mode, locale files", () => {
  test("day one: a German file with no German row is saved untracked and published without publish", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt") });
      const r = await run(ctx, root);
      expect(r.errors).toEqual([]);
      expect(fileOf(r, "de/a.md")).toEqual({ file: `${D}/de/a.md`, docId: expect.any(String), outcome: "updated", published: true });
      const doc = (await bySlug(ctx, "a"))!;
      expect(fileOf(r, "de/a.md").docId).toBe(doc.id);
      expect(doc.locales["de"]!.published!.data["title"]).toBe("Hallo");
      expect(doc.locales["de"]!.draft).toBeNull();
      expect(await sourceHashes(sql, doc.id, "de")).toEqual([{}]);
      const sync = await getSyncState(ctx, { collection: "docs", docId: doc.id, locale: "de" });
      expect(sync.filter((s) => s.field === "title" || s.field === "body").map((s) => s.state)).toEqual(["untracked", "untracked"]);

      const before = await counts(sql);
      const again = await run(ctx, root);
      expect(fileOf(again, "de/a.md")).toEqual({ file: `${D}/de/a.md`, docId: doc.id, outcome: "unchanged", published: false });
      expect(await counts(sql)).toBe(before);
    });
  });

  test("a German row in DRAFT_AI makes the next German file take the normal path", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A") });
      await run(ctx, root);
      const doc = (await bySlug(ctx, "a"))!;
      const src = doc.locales["en"]!.published!;
      await recordAiDraft(ctx, {
        docId: doc.id, locale: "de", fields: { title: "KI-Titel" }, sourceVersion: src.version, sourceHashes: src.sourceHashes, provenance: [],
      });
      put(root, "de/a.md", page("Hallo"));
      const r1 = await run(ctx, root);
      expect(fileOf(r1, "de/a.md")).toMatchObject({ outcome: "updated", published: false });
      expect(warningsOf(r1, "de/a.md")).toEqual(["replaced pending DRAFT_AI draft v1 for de"]);
      const d1 = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(d1.published).toBeNull();
      expect(d1.draft).toMatchObject({ state: "DRAFT_HUMAN", version: 2, data: { title: "Hallo" } });
      expect((await sourceHashes(sql, doc.id, "de"))[1]).not.toEqual({});

      // equal to the draft head now: pending, nothing written without publish
      const before = await counts(sql);
      const r2 = await run(ctx, root);
      expect(fileOf(r2, "de/a.md")).toMatchObject({ outcome: "unchanged", published: false });
      expect(await counts(sql)).toBe(before);
      // with publish the pending human draft is published
      const r3 = await run(ctx, root, {}, true);
      expect(fileOf(r3, "de/a.md")).toMatchObject({ outcome: "updated", published: true });
      expect(await counts(sql)).toBe(before);
      expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["title"]).toBe("Hallo");
    });
  });

  test("an APPROVED draft that a hand edit replaces keeps the pending warning", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A") });
      await run(ctx, root);
      const doc = (await bySlug(ctx, "a"))!;
      const src = doc.locales["en"]!.published!;
      await recordAiDraft(ctx, {
        docId: doc.id, locale: "de", fields: { title: "KI" }, sourceVersion: src.version, sourceHashes: src.sourceHashes, provenance: [],
      });
      await approve(ctx, { docId: doc.id, locale: "de" });
      put(root, "de/a.md", page("Hand"));
      const r = await run(ctx, root);
      expect(warningsOf(r, "de/a.md")).toEqual(["replaced pending APPROVED draft v2 for de"]);
    });
  });

  test("classes: published, pending and behind write nothing; hand work is a human draft", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Eins") });
      await run(ctx, root);
      const doc = (await bySlug(ctx, "a"))!;
      const path_ = `${D}/de/a.md`;

      // hand work: saved as a human draft, not published
      put(root, "de/a.md", page("Zwei"));
      const r1 = await run(ctx, root);
      expect(fileOf(r1, "de/a.md")).toEqual({ file: path_, docId: doc.id, outcome: "updated", published: false });
      let de = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(de.published!.data["title"]).toBe("Eins");
      expect(de.draft).toMatchObject({ state: "DRAFT_HUMAN", data: { title: "Zwei" } });
      expect(warningsOf(r1, "de/a.md")).toEqual([]);

      // pending: nothing written
      const rowsPending = await counts(sql);
      const r2 = await run(ctx, root);
      expect(fileOf(r2, "de/a.md")).toMatchObject({ outcome: "unchanged", published: false });
      expect(await counts(sql)).toBe(rowsPending);

      // publish: the pending draft goes live
      const r3 = await run(ctx, root, {}, true);
      expect(fileOf(r3, "de/a.md")).toMatchObject({ outcome: "updated", published: true });
      de = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(de.published!.data["title"]).toBe("Zwei");
      expect(de.draft).toBeNull();

      // published: unchanged
      const rows = await counts(sql);
      const r4 = await run(ctx, root, {}, true);
      expect(fileOf(r4, "de/a.md")).toMatchObject({ outcome: "unchanged", published: false });
      expect(r4.starlight!.behind).toEqual([]);

      // behind: an old exported file never reverts the newer translation
      put(root, "de/a.md", page("Eins"));
      const r5 = await run(ctx, root, {}, true);
      expect(fileOf(r5, "de/a.md")).toMatchObject({ outcome: "unchanged", published: false });
      expect(r5.starlight!.behind).toEqual([path_]);
      expect(await counts(sql)).toBe(rows);
      expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["title"]).toBe("Zwei");

      // restore: the behind file is saved as a human draft (published only with publish)
      const r6 = await run(ctx, root, { restore: [path_] });
      expect(fileOf(r6, "de/a.md")).toMatchObject({ outcome: "updated", published: false });
      expect(r6.starlight!.behind).toEqual([]);
      de = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(de.published!.data["title"]).toBe("Zwei");
      expect(de.draft).toMatchObject({ state: "DRAFT_HUMAN", data: { title: "Eins" } });
    });
  });

  test("restore on a published file reports already current and writes nothing", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Eins") });
      await run(ctx, root);
      const rows = await counts(sql);
      const r = await run(ctx, root, { restore: [`${D}/de/a.md`] }, true);
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "unchanged", published: false });
      expect(warningsOf(r, "de/a.md").join("\n")).toMatch(/already current/);
      expect(await counts(sql)).toBe(rows);
    });
  });

  test("R10-1: a hand-work file without prev keeps the head's prev", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A", "prev: false\n"), "de/a.md": page("Eins", "prev:\n  label: Zurück\n") });
      await run(ctx, root);
      expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["prev"]).toEqual({ label: "Zurück" });
      put(root, "de/a.md", page("Zwei"));
      const r = await run(ctx, root);
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "updated", published: false });
      const de = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(de.draft!.data).toMatchObject({ title: "Zwei", prev: { label: "Zurück" } });
      // the file without prev was never classified as hand work against the published head
      put(root, "de/a.md", page("Eins"));
      const same = await run(ctx, root);
      expect(fileOf(same, "de/a.md")).toMatchObject({ outcome: "unchanged" });
    });
  });

  test("carry-forward never copies a prev from a DRAFT_AI head into a human draft", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A", "prev: false\n"), "de/a.md": page("Eins") });
      await run(ctx, root);
      const doc = (await bySlug(ctx, "a"))!;
      const src = doc.locales["en"]!.published!;
      await recordAiDraft(ctx, {
        docId: doc.id, locale: "de", fields: { prev: { label: "KI-Zurück" } }, sourceVersion: src.version,
        sourceHashes: src.sourceHashes, provenance: [],
      });
      expect((await bySlug(ctx, "a"))!.locales["de"]!.draft).toMatchObject({ state: "DRAFT_AI" });
      put(root, "de/a.md", page("Zwei"));
      const r = await run(ctx, root, {}, true);
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "updated", published: true });
      const de = (await bySlug(ctx, "a"))!.locales["de"]!.published!;
      expect(de.state).toBe("PUBLISHED");
      expect(de.data["title"]).toBe("Zwei");
      expect(Object.hasOwn(de.data, "prev")).toBe(false);
    });
  });

  test("carry-forward takes the prev from the newer human draft head, not the older published head", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A", "prev: false\n"), "de/a.md": page("Eins", "prev: Alt\n") });
      await run(ctx, root);
      const doc = (await bySlug(ctx, "a"))!;
      expect(doc.locales["de"]!.published!.data["prev"]).toEqual({ label: "Alt" });
      await saveDraft(ctx, { docId: doc.id, locale: "de", data: { title: "Zwei", prev: { label: "Neu" } } });
      put(root, "de/a.md", page("Drei"));
      const r = await run(ctx, root);
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "updated", published: false });
      const de = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(de.published!.data["prev"]).toEqual({ label: "Alt" });
      expect(de.draft).toMatchObject({ state: "DRAFT_HUMAN", data: { title: "Drei", prev: { label: "Neu" } } });
    });
  });

  test("pending: a file equal to a DRAFT_AI or an APPROVED draft head stays unpublished even with publish", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A") });
      await run(ctx, root);
      const doc = (await bySlug(ctx, "a"))!;
      const src = doc.locales["en"]!.published!;
      await recordAiDraft(ctx, {
        docId: doc.id, locale: "de", fields: { title: "KI" }, sourceVersion: src.version, sourceHashes: src.sourceHashes, provenance: [],
      });
      put(root, "de/a.md", "---\ntitle: KI\n---\n");
      const published = async (): Promise<number> =>
        (await sql`select count(*)::int as n from document_localized where doc_id = ${doc.id} and locale = 'de' and is_head_published`)[0]!.n as number;
      for (const state of ["DRAFT_AI", "APPROVED"]) {
        if (state === "APPROVED") await approve(ctx, { docId: doc.id, locale: "de" });
        expect((await bySlug(ctx, "a"))!.locales["de"]!.draft).toMatchObject({ state, data: { title: "KI" } });
        const rows = await counts(sql);
        const r = await run(ctx, root, {}, true);
        expect(r.errors).toEqual([]);
        expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "unchanged", published: false });
        expect(await published()).toBe(0);
        expect(await counts(sql)).toBe(rows);
      }
    });
  });

  test("ED6-3: a locale file whose English file is gone is made canonical against the English path it would have", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "b.md": page("B") });
      await run(ctx, root);
      fs.rmSync(path.join(root, D, "a.md"));
      put(root, "de/a.md", page("Hallo", "hero:\n  image:\n    file: ../../../assets/h.webp\n    alt: H\n", "![x](pic.png)"));
      const r = await run(ctx, root);
      expect(r.errors).toEqual([]);
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "updated", published: true });
      const de = (await bySlug(ctx, "a"))!.locales["de"]!.published!.data;
      // English path is src/content/docs/a.md: one folder up from de/ for the hero, `./de/pic.png` for the body
      expect((de["hero"] as { image: { file: string } }).image.file).toBe("../../assets/h.webp");
      expect(JSON.stringify(de["body"])).toContain('"./de/pic.png"');
    });
  });

  test("ED6-3, own-folder layout: the missing English file's place is under the source folder", async () => {
    await setup(async (_sql, ctx) => {
      const root = project({ [`${D}/en/a.md`]: page("A"), [`${D}/en/b.md`]: page("B") });
      const own = () => importFolder(ctx, { dir: root, starlight: { layout: layoutOwn } });
      await own();
      fs.rmSync(path.join(root, D, "en", "a.md"));
      fs.mkdirSync(path.join(root, D, "de"), { recursive: true });
      fs.writeFileSync(
        path.join(root, D, "de", "a.md"),
        page("Hallo", "hero:\n  image:\n    file: ../../../assets/h.webp\n    alt: H\n", "![x](pic.png)"),
      );
      const r = await own();
      expect(r.errors).toEqual([]);
      expect(r.files.find((f) => f.file === `${D}/de/a.md`)).toMatchObject({ outcome: "updated", published: true });
      const de = (await bySlug(ctx, "a"))!.locales["de"]!.published!.data;
      // English path is src/content/docs/en/a.md: same depth as de/a.md (the hero is unchanged), but a sibling folder
      // (the body image sits next to de/a.md, which is `../de/pic.png` from en/a.md)
      expect((de["hero"] as { image: { file: string } }).image.file).toBe("../../../assets/h.webp");
      expect(JSON.stringify(de["body"])).toContain('"../de/pic.png"');
    });
  });

  test("not day one: a hand-work file is saved and published in one run with publish", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Eins") });
      await run(ctx, root);
      put(root, "de/a.md", page("Zwei"));
      const before = await counts(sql);
      const r = await run(ctx, root, {}, true);
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "updated", published: true });
      const de = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(de.published!.data["title"]).toBe("Zwei");
      expect(de.published!.version).toBe(2);
      expect(de.draft).toBeNull();
      expect(before).not.toBe(await counts(sql));
    });
  });

  describe("the locale-draft rule", () => {
    test("day one: a German draft: true file is saved untracked and not published, even with publish", async () => {
      await setup(async (sql, ctx) => {
        const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "draft: true\n") });
        for (const flag of [false, true]) {
          const r = await run(ctx, root, {}, flag);
          expect(r.errors).toEqual([]);
          expect(fileOf(r, "de/a.md").published).toBe(false);
          expect(warningsOf(r, "de/a.md").join("\n")).toMatch(/draft: .*unpublished/);
        }
        const doc = (await bySlug(ctx, "a"))!;
        expect(doc.locales["de"]!.published).toBeNull();
        expect(doc.locales["de"]!.draft).toMatchObject({ state: "DRAFT_HUMAN", data: { title: "Hallo" } });
        expect(await sourceHashes(sql, doc.id, "de")).toEqual([{}]);

        // the flag removed: the file is still pending, and import with publish publishes it
        put(root, "de/a.md", page("Hallo"));
        const noPublish = await run(ctx, root);
        expect(fileOf(noPublish, "de/a.md")).toMatchObject({ outcome: "unchanged", published: false });
        const done = await run(ctx, root, {}, true);
        expect(fileOf(done, "de/a.md")).toMatchObject({ outcome: "updated", published: true });
        expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["title"]).toBe("Hallo");
      });
    });

    test("a file that only carries English's own draft: true is not a locale draft", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "a.md": page("A") });
        await run(ctx, root);
        put(root, "a.md", page("A", "draft: true\n"));
        put(root, "de/a.md", page("Hallo", "draft: true\n"));
        const r = await run(ctx, root);
        expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "updated", published: true });
        expect(warningsOf(r, "de/a.md")).toEqual([]);
        expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["title"]).toBe("Hallo");
      });
    });

    test("a published file with a locale draft: true is reported with the unpublish hint", async () => {
      await setup(async (sql, ctx) => {
        const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo") });
        await run(ctx, root);
        put(root, "de/a.md", page("Hallo", "draft: true\n"));
        const rows = await counts(sql);
        const r = await run(ctx, root, {}, true);
        expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "unchanged", published: false });
        expect(warningsOf(r, "de/a.md").join("\n")).toContain("run `mogging unpublish --locale` to withdraw it");
        expect(await counts(sql)).toBe(rows);
        expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["title"]).toBe("Hallo");
      });
    });

    test("not day one: a hand-work draft: true file is saved unpublished even with publish", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "a.md": page("A"), "de/a.md": page("Eins") });
        await run(ctx, root);
        put(root, "de/a.md", page("Zwei", "draft: true\n"));
        const r = await run(ctx, root, {}, true);
        expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "updated", published: false });
        const de = (await bySlug(ctx, "a"))!.locales["de"]!;
        expect(de.published!.data["title"]).toBe("Eins");
        expect(de.draft!.data["title"]).toBe("Zwei");
        // still pending while the flag stays: publish does not publish it
        const again = await run(ctx, root, {}, true);
        expect(fileOf(again, "de/a.md")).toMatchObject({ outcome: "unchanged", published: false });
        expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["title"]).toBe("Eins");
      });
    });
  });

  describe("the follows-English report", () => {
    test("a differing follows-English key is reported once; equal values are silent", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({
          "a.md": page("A", "template: doc\npagefind: false\n"),
          "de/a.md": page("Hallo", "template: splash\npagefind: false\n"),
        });
        const r = await run(ctx, root);
        expect(warningsOf(r, "de/a.md")).toEqual(["template: export will write the English value the next time it writes this file"]);
        const again = await run(ctx, root);
        expect(warningsOf(again, "de/a.md")).toEqual(["template: export will write the English value the next time it writes this file"]);
        // a locale file that agrees with English says nothing
        put(root, "de/a.md", page("Hallo", "template: doc\npagefind: false\n"));
        expect(warningsOf(await run(ctx, root), "de/a.md")).toEqual([]);
      });
    });

    test("a German-only unmapped key warns that export drops it; a differing shared unmapped key follows English", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({
          "a.md": page("A", "custom: one\nsame: x\n"),
          "de/a.md": page("Hallo", "only-de: eins\ncustom: zwei\nsame: x\n"),
        });
        const r = await run(ctx, root);
        expect(warningsOf(r, "de/a.md").sort()).toEqual([
          "custom: export will write the English value the next time it writes this file",
          "only-de: not mapped by the layout; export drops it when it rewrites this file",
        ]);
        // nothing of the shared record is imported from the locale file
        expect((await bySlug(ctx, "a"))!.shared.published!.data["extra"]).toEqual({ custom: "one", same: "x" });
      });
    });

    test("union toggles: English prev false with a German label stores the label and reports prev once", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "a.md": page("A", "prev: false\n"), "de/a.md": page("Hallo", "prev: Zurück\n") });
        const r = await run(ctx, root);
        expect(warningsOf(r, "de/a.md")).toEqual(["prev: export will write the English value the next time it writes this file"]);
        expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["prev"]).toEqual({ label: "Zurück" });
      });
    });

    test("union toggles: English prev Back with a German false reports prev once", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "a.md": page("A", "prev: Back\n"), "de/a.md": page("Hallo", "prev: false\n") });
        const r = await run(ctx, root);
        expect(warningsOf(r, "de/a.md")).toEqual(["prev: export will write the English value the next time it writes this file"]);
        const de = (await bySlug(ctx, "a"))!.locales["de"]!.published!.data;
        expect(Object.hasOwn(de, "prev")).toBe(false);
        // matching toggles are silent
        put(root, "a.md", page("A", "prev: false\n"));
        const same = await run(ctx, root);
        expect(warningsOf(same, "de/a.md")).toEqual([]);
      });
    });
  });

  test("first run: English, de/ and zh-cn/ files of new pages import in one call; the dry run reports the same", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({
        "a.md": page("A"), "guides/b.md": page("B"),
        "de/a.md": page("Hallo"), "zh-cn/a.md": page("你好"), "de/guides/b.md": page("Bee"),
      });
      const dry = await run(ctx, root, { dryRun: true });
      expect(await counts(sql)).toBe("0/0");
      const real = await run(ctx, root);
      expect(real.errors).toEqual([]);
      const view = (r: ImportReport) => r.files.map((f) => [f.file, f.outcome, f.published]);
      expect(view(real)).toEqual([
        [`${D}/a.md`, "created", true], [`${D}/de/a.md`, "updated", true], [`${D}/de/guides/b.md`, "updated", true],
        [`${D}/guides/b.md`, "created", true], [`${D}/zh-cn/a.md`, "updated", true],
      ]);
      expect(view(dry)).toEqual(view(real));
      expect(dry.warnings).toEqual(real.warnings);
      const a = (await bySlug(ctx, "a"))!;
      expect(a.locales["de"]!.published!.data["title"]).toBe("Hallo");
      expect(a.locales["zh-CN"]!.published!.data["title"]).toBe("你好");
      const sync = await getSyncState(ctx, { collection: "docs", docId: a.id });
      expect(sync.filter((s) => s.field === "title").map((s) => `${s.locale}:${s.state}`).sort()).toEqual(["de:untracked", "zh-CN:untracked"]);
      expect(await sourceHashes(sql, a.id, "zh-CN")).toEqual([{}]);
    });
  });

  test("a dry run writes nothing and reports the day-one and hand-work outcomes of existing pages", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "b.md": page("B"), "de/a.md": page("Eins") });
      await run(ctx, root);
      put(root, "de/a.md", page("Zwei"));
      put(root, "de/b.md", page("Bee"));
      const rows = await counts(sql);
      const dry = await run(ctx, root, { dryRun: true });
      expect(await counts(sql)).toBe(rows);
      expect(dry.files.map((f) => [f.file, f.outcome, f.published])).toEqual([
        [`${D}/a.md`, "unchanged", false], [`${D}/b.md`, "unchanged", false],
        [`${D}/de/a.md`, "updated", false], [`${D}/de/b.md`, "updated", true],
      ]);
      const real = await run(ctx, root);
      expect(real.files.map((f) => [f.file, f.outcome, f.published])).toEqual(dry.files.map((f) => [f.file, f.outcome, f.published]));
    });
  });

  test("orphans: a locale file with no live document is a warning, not an error", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "new.md": page("New", "draft: true\n"), "de/zzz.md": page("Z"), "de/new.md": page("Neu") });
      const r = await run(ctx, root);
      expect(r.errors).toEqual([]);
      expect(fileOf(r, "de/zzz.md")).toEqual({ file: `${D}/de/zzz.md`, docId: null, outcome: "skipped", published: false });
      expect(fileOf(r, "de/new.md")).toMatchObject({ outcome: "skipped" });
      expect(warningsOf(r, "de/zzz.md")).toHaveLength(1);
      expect(warningsOf(r, "de/zzz.md")[0]).toMatch(/no live document/);
      expect(warningsOf(r, "de/new.md")[0]).toMatch(/no live document/);
      expect(await bySlug(ctx, "zzz")).toBeNull();
    });
  });

  test("a locale file whose page was pruned in the same run is an orphan warning", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "g.md": page("G"), "de/g.md": page("Ge") });
      await run(ctx, root);
      fs.rmSync(path.join(root, D, "g.md"));
      const r = await run(ctx, root, { prune: true });
      expect(r.starlight!.pruned).toEqual(["g"]);
      expect(r.errors).toEqual([]);
      expect(fileOf(r, "de/g.md")).toMatchObject({ outcome: "skipped" });
      expect(warningsOf(r, "de/g.md")[0]).toMatch(/no live document/);
    });
  });

  test("de/getting-started.md next to English Getting-Started.md is the same page", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "Getting-Started.md": page("Start"), "de/getting-started.md": page("Los") });
      const r = await run(ctx, root);
      expect(r.errors).toEqual([]);
      expect(fileOf(r, "de/getting-started.md")).toMatchObject({ outcome: "updated", published: true });
      expect((await bySlug(ctx, "getting-started"))!.locales["de"]!.published!.data["title"]).toBe("Los");
    });
  });

  test("a German hero image is stored canonical, relative to the English file", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({
        "a.md": page("A", "hero:\n  image:\n    file: ../../assets/h.webp\n    alt: H\n"),
        "de/a.md": page("Hallo", "hero:\n  image:\n    file: ../../../assets/h.webp\n    alt: Ha\n", "![x](pic.png)"),
      });
      const r = await run(ctx, root);
      expect(r.errors).toEqual([]);
      const de = (await bySlug(ctx, "a"))!.locales["de"]!.published!.data;
      expect(de["hero"]).toEqual({ image: { file: "../../assets/h.webp", alt: "Ha" } });
      // a bare body image source is stored relative to the English file, which is one folder up from de/
      expect(JSON.stringify(de["body"])).toContain("./de/pic.png");
      // equal canonical content classifies as published on the next run
      const again = await run(ctx, root);
      expect(fileOf(again, "de/a.md")).toMatchObject({ outcome: "unchanged" });
    });
  });

  test("not day one: after a rejected AI draft or an unpublish, a hand-written file is an unpublished human draft", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "b.md": page("B") });
      await run(ctx, root);
      const a = (await bySlug(ctx, "a"))!;
      const src = a.locales["en"]!.published!;
      await recordAiDraft(ctx, {
        docId: a.id, locale: "de", fields: { title: "KI" }, sourceVersion: src.version, sourceHashes: src.sourceHashes, provenance: [],
      });
      await rejectDraft(ctx, { docId: a.id, locale: "de" });
      expect((await bySlug(ctx, "a"))!.locales["de"]?.draft ?? null).toBeNull();

      const b = (await bySlug(ctx, "b"))!;
      await saveDraft(ctx, { docId: b.id, locale: "de", data: { title: "Bee" } });
      await publish(ctx, { docId: b.id, locale: "de" });
      await unpublish(ctx, { docId: b.id, locale: "de" });
      expect((await bySlug(ctx, "b"))!.locales["de"]?.published ?? null).toBeNull();

      put(root, "de/a.md", page("Hand A"));
      put(root, "de/b.md", page("Hand B"));
      const r = await run(ctx, root);
      expect(r.errors).toEqual([]);
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "updated", published: false });
      expect(fileOf(r, "de/b.md")).toMatchObject({ outcome: "updated", published: false });
      expect((await bySlug(ctx, "a"))!.locales["de"]!.published).toBeNull();
      expect((await bySlug(ctx, "a"))!.locales["de"]!.draft).toMatchObject({ state: "DRAFT_HUMAN", data: { title: "Hand A" } });
      expect((await bySlug(ctx, "b"))!.locales["de"]!.published).toBeNull();
      expect((await bySlug(ctx, "b"))!.locales["de"]!.draft).toMatchObject({ state: "DRAFT_HUMAN", data: { title: "Hand B" } });
      const pub = await run(ctx, root, {}, true);
      expect(fileOf(pub, "de/a.md")).toMatchObject({ outcome: "updated", published: true });
      expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["title"]).toBe("Hand A");
    });
  });

  test("a locale file with a bad front matter is a per-file error and the others go on", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "b.md": page("B"), "de/a.md": "---\ntitle: [\n---\n", "de/b.md": page("Bee") });
      const r = await run(ctx, root);
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "error" });
      expect(r.errors.map((e) => e.file)).toEqual([`${D}/de/a.md`]);
      expect(fileOf(r, "de/b.md")).toMatchObject({ outcome: "updated", published: true });
    });
  });

  test("an unreadable English page leaves its locale file an orphan warning, not an error", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": "---\ntitle: [\n---\n", "de/a.md": page("Hallo") });
      const r = await run(ctx, root);
      expect(fileOf(r, "a.md")).toMatchObject({ outcome: "error" });
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "skipped" });
      expect(r.errors.map((e) => e.file)).toEqual([`${D}/a.md`]);
    });
  });

  test("classification is batched: the query count does not grow with the number of diverging files", async () => {
    await setup(async (sql, ctx) => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 12; i++) { files[`p${i}.md`] = page(`P${i}`); files[`de/p${i}.md`] = page(`D${i}`); }
      const root = docsProject(files);
      await run(ctx, root);
      const counting = await countingSql(sql);
      try {
        const cctx = { ...ctx, sql: counting.sql };
        for (let i = 0; i < 3; i++) put(root, `de/p${i}.md`, page(`X${i}`));
        counting.reset();
        const few = await run(cctx, root, { dryRun: true });
        const nFew = counting.count();
        expect(few.files.filter((f) => f.outcome === "updated")).toHaveLength(3);
        for (let i = 0; i < 12; i++) put(root, `de/p${i}.md`, page(`Y${i}`));
        counting.reset();
        const many = await run(cctx, root, { dryRun: true });
        const nMany = counting.count();
        expect(many.files.filter((f) => f.outcome === "updated")).toHaveLength(12);
        expect(nFew).toBeGreaterThan(0);
        expect(nMany).toBe(nFew);
      } finally {
        await counting.sql.end();
      }
    });
  });

  test("a zero-byte translation after a published day one is a draft, never published, with or without publish", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt") });
      await run(ctx, root);
      fs.writeFileSync(path.join(root, D, "de", "a.md"), "");
      for (const publishFlag of [true, false]) {
        const r = await run(ctx, root, {}, publishFlag);
        expect(r.errors).toEqual([]);
        expect(fileOf(r, "de/a.md").published).toBe(false);
        // The first run saves the empty file as a draft and says so; the second finds it equal to that draft.
        if (publishFlag) {
          expect(warningsOf(r, "de/a.md")).toContain(
            "incomplete translation (missing title, body); saved as an unpublished draft",
          );
        } else {
          expect(warningsOf(r, "de/a.md")).toEqual([]);
        }
        const de = (await bySlug(ctx, "a"))!.locales["de"]!;
        expect(de.published!.data["title"]).toBe("Hallo");
        expect(de.published!.version).toBe(1);
      }
      const third = await run(ctx, root, {}, true);
      expect(fileOf(third, "de/a.md").published).toBe(false);
      expect(warningsOf(third, "de/a.md")).toEqual([
        "incomplete translation (missing title, body); the pending draft is not published",
      ]);
      expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.version).toBe(1);
    });
  });

  test("an incomplete hand edit (no title, no body) is saved as an unpublished draft and warned about", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": page("Hallo", "", "Welt") });
      await run(ctx, root);
      fs.writeFileSync(path.join(root, D, "de", "a.md"), "---\ndescription: nur Beschreibung\n---\n");
      const r = await run(ctx, root, {}, true);
      expect(warningsOf(r, "de/a.md")).toContain(
        "incomplete translation (missing title, body); saved as an unpublished draft",
      );
      expect(fileOf(r, "de/a.md")).toMatchObject({ outcome: "updated", published: false });
      const de = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(de.published!.data["title"]).toBe("Hallo");
      expect(de.draft!.state).toBe("DRAFT_HUMAN");
      expect(de.draft!.data).toEqual({ description: "nur Beschreibung" });

      // The next run finds the file equal to the pending draft: `--publish` must not publish it either.
      const again = await run(ctx, root, {}, true);
      expect(fileOf(again, "de/a.md")).toMatchObject({ published: false });
      const after = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(after.published!.data["title"]).toBe("Hallo");
      expect(after.published!.version).toBe(de.published!.version);
    });
  });

  test("day one: an incomplete translation (title only, English has a body) is saved untracked but not published", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "de/a.md": "---\ntitle: Hallo\n---\n" });
      const r = await run(ctx, root, {}, true);
      expect(warningsOf(r, "de/a.md")).toContain("incomplete translation (missing body); saved as an unpublished draft");
      expect(fileOf(r, "de/a.md")).toMatchObject({ published: false });
      const de = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(de.published).toBeNull();
      expect(de.draft!.data["title"]).toBe("Hallo");
    });
  });

  test("the own-folder layout: day one, then a hand edit", async () => {
    await setup(async (_sql, ctx) => {
      const root = project({
        [`${D}/en/a.md`]: page("A"), [`${D}/de/a.md`]: page("Hallo"),
      });
      const own = () => importFolder(ctx, { dir: root, starlight: { layout: layoutOwn } });
      const r1 = await own();
      expect(r1.errors).toEqual([]);
      expect(r1.files).toEqual([
        { file: `${D}/de/a.md`, docId: expect.any(String), outcome: "updated", published: true },
        { file: `${D}/en/a.md`, docId: expect.any(String), outcome: "created", published: true },
      ]);
      expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["title"]).toBe("Hallo");
      fs.writeFileSync(path.join(root, D, "de", "a.md"), page("Hallo Welt"));
      const r2 = await own();
      expect(r2.files.find((f) => f.file === `${D}/de/a.md`)).toMatchObject({ outcome: "updated", published: false });
      const de = (await bySlug(ctx, "a"))!.locales["de"]!;
      expect(de.published!.data["title"]).toBe("Hallo");
      expect(de.draft!.data["title"]).toBe("Hallo Welt");
    });
  });
});
