import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Sql } from "postgres";
import { createDocument, deleteDocument, getDocument, listDocuments, migrate, publish, saveDraft } from "@mogging/core";
import type { Ctx } from "@mogging/core";
import { importFolder } from "../../src/import.js";
import type { ImportReport } from "../../src/import.js";
import { withTestDb } from "../db.js";
import { countingSql, ctxFor, layout, layoutOwn, project, readTree } from "./fixtures.js";

const D = "src/content/docs";

async function setup(fn: (sql: Sql, ctx: Ctx) => Promise<void>): Promise<void> {
  await withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql, ctxFor(sql));
  });
}

/** A page file: `title`, extra front-matter lines (each ending in a newline) and a body. */
const page = (title: string, extra = "", body = "Hello"): string => `---\ntitle: ${title}\n${extra}---\n${body}\n`;

/** A project whose docs folder holds `files` (paths relative to the docs folder). */
const docsProject = (files: Record<string, string>): string =>
  project(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${D}/${k}`, v])));

/** Writes (or overwrites) one file under the docs folder of `root`. */
function put(root: string, rel: string, text: string): void {
  const full = path.join(root, D, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

const drop = (root: string, rel: string): void => fs.rmSync(path.join(root, D, rel), { recursive: true });

const run = (ctx: Ctx, root: string, opts: Record<string, unknown> = {}): Promise<ImportReport> =>
  importFolder(ctx, { dir: root, starlight: { layout, ...opts } });

const outcome = (r: ImportReport, rel: string): string | undefined => r.files.find((f) => f.file === `${D}/${rel}`)?.outcome;
const fileOf = (r: ImportReport, rel: string) => r.files.find((f) => f.file === `${D}/${rel}`)!;

async function bySlug(ctx: Ctx, slug: string) {
  return getDocument(ctx, { collection: "docs", slug });
}

/** Row counts of the three content tables, as one comparable string. */
async function counts(sql: Sql): Promise<string> {
  const [a] = await sql`select count(*)::int as n from documents`;
  const [b] = await sql`select count(*)::int as n from document_shared`;
  const [c] = await sql`select count(*)::int as n from document_localized`;
  return `${a!.n}/${b!.n}/${c!.n}`;
}

async function maxVersion(sql: Sql, docId: string, scope: string): Promise<number> {
  const rows = scope === "shared"
    ? await sql`select max(version)::int as v from document_shared where doc_id = ${docId}`
    : await sql`select max(version)::int as v from document_localized where doc_id = ${docId} and locale = ${scope}`;
  return rows[0]!.v as number;
}

const rejectsValidation = (p: Promise<unknown>, re: RegExp) =>
  expect(p).rejects.toMatchObject({ name: "ValidationError", message: expect.stringMatching(re) });

describe("importFolder, Starlight mode, source pages", () => {
  test("no source file at all", async () => {
    await setup(async (_sql, ctx) => {
      const empty = project({ [`${D}/de/a.md`]: page("Hallo") });
      await rejectsValidation(run(ctx, empty), /no source file/);
      await rejectsValidation(run(ctx, empty, { prune: true }), /no source file/);

      const root = docsProject({ "a.md": page("A") });
      await run(ctx, root);
      const bare = project({ [`${D}/note.txt`]: "x" });
      await rejectsValidation(run(ctx, bare, { prune: true }), /no source file/);
      // other Starlight extensions are not source files either: a checkout of them alone prunes nothing
      const other = project({ [`${D}/a.markdown`]: "x" });
      await rejectsValidation(run(ctx, other, { prune: true }), /no source file/);
      expect((await bySlug(ctx, "a"))!.deletedAt).toBeNull();
    });
  });

  test("English is always published, without publish", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A", "", "Body one") });
      const r1 = await run(ctx, root);
      expect(r1.errors).toEqual([]);
      expect(r1.files).toEqual([{ file: `${D}/a.md`, docId: expect.any(String), outcome: "created", published: true }]);
      const doc = (await bySlug(ctx, "a"))!;
      expect(doc.shared.published!.data).toEqual({ slug: "a" });
      expect(doc.shared.draft).toBeNull();
      expect(doc.locales.en!.published!.data["title"]).toBe("A");
      expect(doc.locales.en!.draft).toBeNull();
      const before = await counts(sql);

      // unchanged: its PUBLISHED head equals the file, no new row
      const r2 = await run(ctx, root);
      expect(fileOf(r2, "a.md")).toEqual({ file: `${D}/a.md`, docId: doc.id, outcome: "unchanged", published: false });
      expect(await counts(sql)).toBe(before);

      // changed: saved and published
      put(root, "a.md", page("A2", "", "Body two"));
      const r3 = await run(ctx, root);
      expect(fileOf(r3, "a.md")).toMatchObject({ docId: doc.id, outcome: "updated", published: true });
      const after = (await bySlug(ctx, "a"))!;
      expect(after.locales.en!.published!.data["title"]).toBe("A2");
      expect(after.locales.en!.published!.version).toBe(2);
      expect(after.locales.en!.draft).toBeNull();

      // a draft head equal to the file but not published is published (no new row)
      put(root, "a.md", "---\ntitle: A3\n---\n");
      await saveDraft(ctx, { docId: doc.id, locale: "en", data: { title: "A3" } });
      expect(await maxVersion(sql, doc.id, "en")).toBe(3);
      const r4 = await run(ctx, root);
      expect(fileOf(r4, "a.md")).toMatchObject({ outcome: "updated", published: true });
      const done = (await bySlug(ctx, "a"))!;
      expect(done.locales.en!.published!.data).toEqual({ title: "A3" });
      expect(done.locales.en!.published!.version).toBe(3);
      expect(await maxVersion(sql, doc.id, "en")).toBe(3);
    });
  });

  test("a new draft: true page is skipped; an existing one is imported", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "new.md": page("New", "draft: true\n"), "old.md": page("Old") });
      const r1 = await run(ctx, root);
      expect(fileOf(r1, "new.md")).toEqual({ file: `${D}/new.md`, docId: null, outcome: "skipped", published: false });
      expect(outcome(r1, "old.md")).toBe("created");
      expect(await bySlug(ctx, "new")).toBeNull();
      expect(r1.errors).toEqual([]);

      put(root, "old.md", page("Old", "draft: true\n"));
      const r2 = await run(ctx, root);
      expect(fileOf(r2, "old.md")).toMatchObject({ outcome: "updated", published: true });
      expect((await bySlug(ctx, "old"))!.shared.published!.data["draft"]).toBe(true);
      expect(await bySlug(ctx, "new")).toBeNull();
    });
  });

  test("the canonical form is stored; the English file is not touched", async () => {
    await setup(async (_sql, ctx) => {
      const text = "---\ntitle: T\nhero:\n  title: H\n  image:\n    file: img.png\n---\n![alt](img.png)\n";
      const root = docsProject({ "guides/a.md": text });
      const before = readTree(root);
      const r = await run(ctx, root);
      expect(r.errors).toEqual([]);
      const doc = (await bySlug(ctx, "guides/a"))!;
      const en = doc.locales.en!.published!.data;
      expect((en["hero"] as { image: { file: string } }).image.file).toBe("./img.png");
      expect(JSON.stringify(en["body"])).toContain('"url":"./img.png"');
      expect(readTree(root)).toEqual(before);
      expect(outcome(await run(ctx, root), "guides/a.md")).toBe("unchanged");
    });
  });

  test("Getting Started.md creates getting-started, and a second run is unchanged", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "Getting Started.md": page("GS") });
      expect(outcome(await run(ctx, root), "Getting Started.md")).toBe("created");
      expect(await bySlug(ctx, "getting-started")).not.toBeNull();
      expect(outcome(await run(ctx, root), "Getting Started.md")).toBe("unchanged");
    });
  });

  describe("the rename safety stop", () => {
    /** Pages a ("Alpha") and c ("Carol") imported, then `a.md` renamed to `b.md` and `c` edited. */
    async function renamed(ctx: Ctx): Promise<string> {
      const root = docsProject({ "a.md": page("Alpha"), "c.md": page("Carol") });
      await run(ctx, root);
      fs.renameSync(path.join(root, D, "a.md"), path.join(root, D, "b.md"));
      put(root, "c.md", page("Carol 2"));
      return root;
    }

    test("one gone, one new: neither created nor pruned, the rename command, the rest imported", async () => {
      await setup(async (_sql, ctx) => {
        const root = await renamed(ctx);
        for (const prune of [false, true]) {
          const r = await run(ctx, root, { prune });
          expect(r.starlight!.stop).toEqual({
            gone: [{ slug: "a", title: "Alpha" }],
            added: [{ file: `${D}/b.md`, slug: "b", title: "Alpha" }],
            command: "mogging rename a b",
          });
          expect(r.starlight!.pruned).toEqual([]);
          expect(fileOf(r, "b.md")).toEqual({ file: `${D}/b.md`, docId: null, outcome: "skipped", published: false });
          expect(outcome(r, "c.md")).toBe(prune ? "unchanged" : "updated");
          expect(await bySlug(ctx, "b")).toBeNull();
          expect((await bySlug(ctx, "a"))!.deletedAt).toBeNull();
        }
        expect((await bySlug(ctx, "c"))!.locales.en!.published!.data["title"]).toBe("Carol 2");
      });
    });

    test("two gone and one new gives command null", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "a.md": page("Alpha"), "c.md": page("Carol"), "z.md": page("Zed") });
        await run(ctx, root);
        drop(root, "a.md");
        drop(root, "c.md");
        put(root, "b.md", page("Bee"));
        const r = await run(ctx, root);
        expect(r.starlight!.stop!.command).toBeNull();
        expect(r.starlight!.stop!.gone.map((g) => g.slug)).toEqual(["a", "c"]);
        expect(r.starlight!.stop!.added.map((g) => g.slug)).toEqual(["b"]);
      });
    });

    test("acceptNewAndGone creates the new page and keeps the gone one live", async () => {
      await setup(async (_sql, ctx) => {
        const root = await renamed(ctx);
        const r1 = await run(ctx, root, { acceptNewAndGone: true });
        expect(r1.starlight!.stop).toBeNull();
        expect(outcome(r1, "b.md")).toBe("created");
        expect((await bySlug(ctx, "b"))!.locales.en!.published!.data["title"]).toBe("Alpha");
        expect((await bySlug(ctx, "a"))!.deletedAt).toBeNull();
        expect(r1.starlight!.pruned).toEqual([]);
      });
    });

    test("acceptNewAndGone with prune also soft-deletes the gone page", async () => {
      await setup(async (_sql, ctx) => {
        const root = await renamed(ctx);
        const r = await run(ctx, root, { acceptNewAndGone: true, prune: true });
        expect(r.starlight!.stop).toBeNull();
        expect(r.starlight!.pruned).toEqual(["a"]);
        expect(outcome(r, "b.md")).toBe("created");
        expect((await bySlug(ctx, "a"))!.deletedAt).not.toBeNull();
        expect((await bySlug(ctx, "b"))!.deletedAt).toBeNull();
      });
    });

    test("a gone page whose new name is a draft: true file still stops", async () => {
      await setup(async (_sql, ctx) => {
        const root = await renamed(ctx);
        put(root, "b.md", page("Alpha", "draft: true\n"));
        const r = await run(ctx, root, { prune: true });
        expect(r.starlight!.stop).toMatchObject({ command: "mogging rename a b" });
        expect(fileOf(r, "b.md")).toMatchObject({ outcome: "skipped", docId: null });
        expect((await bySlug(ctx, "a"))!.deletedAt).toBeNull();
        expect(await bySlug(ctx, "b")).toBeNull();
      });
    });
  });

  test("gone uses published and draft slugs", async () => {
    await setup(async (_sql, ctx) => {
      const { id } = await createDocument(ctx, { collection: "docs" });
      await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "a" } });
      await publish(ctx, { docId: id, locale: "shared" });
      await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "b" } });
      const root = docsProject({ "b.md": page("B"), "other.md": page("Other") });
      const r = await run(ctx, root, { prune: true });
      expect(r.starlight!.stop).toBeNull();
      expect(r.starlight!.pruned).toEqual([]);
      expect(fileOf(r, "b.md")).toMatchObject({ docId: id, outcome: "updated" });
      expect((await bySlug(ctx, "b"))!.id).toBe(id);
      expect((await bySlug(ctx, "b"))!.deletedAt).toBeNull();
      expect((await bySlug(ctx, "b"))!.shared.published!.data["slug"]).toBe("b");
    });
  });

  test("a crash between save and publish is completed", async () => {
    await setup(async (sql, ctx) => {
      const { id } = await createDocument(ctx, { collection: "docs" });
      await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "a" } });
      await saveDraft(ctx, { docId: id, locale: "en", data: { title: "A" } });
      const root = docsProject({ "a.md": "---\ntitle: A\n---\n" });
      const r = await run(ctx, root);
      expect(fileOf(r, "a.md")).toEqual({ file: `${D}/a.md`, docId: id, outcome: "updated", published: true });
      const doc = (await bySlug(ctx, "a"))!;
      expect(doc.shared.published!.data).toEqual({ slug: "a" });
      expect(doc.locales.en!.published!.data).toEqual({ title: "A" });
      expect(await maxVersion(sql, id, "en")).toBe(1);
      expect(await maxVersion(sql, id, "shared")).toBe(1);
    });
  });

  test("prune without a stop deletes every live document whose source file is gone", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "b.md": page("B"), "c.md": page("C") });
      await run(ctx, root);
      drop(root, "b.md");
      drop(root, "c.md");
      const r0 = await run(ctx, root);
      expect(r0.starlight!.pruned).toEqual([]);
      expect(r0.starlight!.stop).toBeNull();
      expect((await bySlug(ctx, "b"))!.deletedAt).toBeNull();
      const r = await run(ctx, root, { prune: true });
      expect(r.starlight!.pruned).toEqual(["b", "c"]);
      expect((await bySlug(ctx, "b"))!.deletedAt).not.toBeNull();
      expect((await bySlug(ctx, "c"))!.deletedAt).not.toBeNull();
      expect((await bySlug(ctx, "a"))!.deletedAt).toBeNull();
      // a second prune finds nothing live to delete
      expect((await run(ctx, root, { prune: true })).starlight!.pruned).toEqual([]);
    });
  });

  test("a document deleted by a concurrent prune is not an error", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "g.md": page("G") });
      await run(ctx, root);
      const goneId = (await bySlug(ctx, "g"))!.id;
      drop(root, "g.md");
      // The first transaction of the run (the prune's) finds the document already deleted by someone else.
      let raced = false;
      const racing = new Proxy(sql, {
        get(target, prop, receiver) {
          if (prop === "begin") {
            return async (...args: unknown[]) => {
              if (!raced) { raced = true; await deleteDocument(ctx, { docId: goneId }); }
              return (target.begin as (...a: unknown[]) => unknown)(...args);
            };
          }
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const r = await run({ ...ctx, sql: racing }, root, { prune: true });
      expect(raced).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.starlight!.pruned).toEqual(["g"]);
      expect((await bySlug(ctx, "g"))!.deletedAt).not.toBeNull();
    });
  });

  test("a dry run writes nothing and reports what the real run does", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({ "a.md": page("A"), "b.md": page("B"), "c.md": page("C"), "d.markdown": "x" });
      await run(ctx, root);
      put(root, "b.md", page("B2"));
      put(root, "n.md", page("New"));
      put(root, "draft.md", page("Draft", "draft: true\n"));
      put(root, "bad.md", "---\ntitle: [\n---\n");

      const before = await counts(sql);
      const dry = await run(ctx, root, { dryRun: true });
      expect(await counts(sql)).toBe(before);
      expect(dry.starlight!.dryRun).toBe(true);
      expect(fileOf(dry, "n.md")).toEqual({ file: `${D}/n.md`, docId: null, outcome: "created", published: true });
      expect(outcome(dry, "b.md")).toBe("updated");
      expect(outcome(dry, "draft.md")).toBe("skipped");
      expect(outcome(dry, "bad.md")).toBe("error");

      const real = await run(ctx, root);
      expect(real.starlight!.dryRun).toBe(false);
      const nullNew = (r: ImportReport) => r.files.map((f) => (f.outcome === "created" ? { ...f, docId: null } : f));
      expect(nullNew(real)).toEqual(dry.files);
      expect(real.warnings).toEqual(dry.warnings);
      expect(real.errors).toEqual(dry.errors);
      expect({ ...real.starlight!, dryRun: true }).toEqual(dry.starlight);
      expect(fileOf(real, "n.md").docId).toEqual(expect.any(String));

      // prune and the safety stop in a dry run
      drop(root, "c.md");
      drop(root, "bad.md");
      drop(root, "draft.md");
      const mid = await counts(sql);
      const dryPrune = await run(ctx, root, { dryRun: true, prune: true });
      expect(dryPrune.starlight!.pruned).toEqual(["c"]);
      expect(await counts(sql)).toBe(mid);
      expect((await bySlug(ctx, "c"))!.deletedAt).toBeNull();
      const realPrune = await run(ctx, root, { prune: true });
      expect(realPrune.starlight!.pruned).toEqual(["c"]);
      expect((await bySlug(ctx, "c"))!.deletedAt).not.toBeNull();

      put(root, "z.md", page("Z"));
      drop(root, "a.md");
      const before2 = await counts(sql);
      const dryStop = await run(ctx, root, { dryRun: true });
      expect(dryStop.starlight!.stop).toMatchObject({ command: "mogging rename a z" });
      expect(await counts(sql)).toBe(before2);
    });
  });

  test("other Starlight extensions are listed once", async () => {
    await setup(async (_sql, ctx) => {
      const root = docsProject({ "a.markdown": "x", "b.mdoc": "y", "p.md": page("P") });
      const r = await run(ctx, root);
      const hits = r.warnings.filter((w) => /a\.markdown/.test(w.message));
      expect(hits).toHaveLength(1);
      expect(hits[0]!.message).toContain(`${D}/b.mdoc`);
      expect(hits[0]!.file).toBe(D);
      expect(r.starlight!.unsupported).toEqual([`${D}/a.markdown`, `${D}/b.mdoc`]);
      expect(r.files.map((f) => f.file)).toEqual([`${D}/p.md`]);
      expect(await bySlug(ctx, "a")).toBeNull();
      expect(await bySlug(ctx, "b")).toBeNull();
    });
  });

  describe("a source file that cannot be read is never gone", () => {
    test("front-matter error, collision and symlinked folder", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({
          "bad.md": page("Bad"), "x.md": page("X"), "guides/a.md": page("GA"), "guides/b.md": page("GB"),
          "keep.md": page("Keep"),
        });
        await run(ctx, root);
        put(root, "bad.md", "---\ntitle: [\n---\n");
        put(root, "x.mdx", page("X mdx"));
        const real = path.join(root, "elsewhere");
        fs.mkdirSync(real);
        fs.renameSync(path.join(root, D, "guides"), path.join(real, "guides"));
        fs.symlinkSync(path.join(real, "guides"), path.join(root, D, "guides"));
        put(root, "n.md", page("Newcomer"));

        const r = await run(ctx, root);
        expect(r.starlight!.stop).toBeNull();
        expect(r.starlight!.pruned).toEqual([]);
        expect(outcome(r, "bad.md")).toBe("error");
        expect(outcome(r, "x.md")).toBe("error");
        expect(outcome(r, "x.mdx")).toBe("error");
        expect(outcome(r, "n.md")).toBe("created");
        for (const s of ["bad", "x", "guides/a", "guides/b"]) expect((await bySlug(ctx, s))!.deletedAt).toBeNull();

        const refused = run(ctx, root, { prune: true });
        await rejectsValidation(refused, /could not be read/);
        await rejectsValidation(run(ctx, root, { prune: true }), /bad\.md/);
        await rejectsValidation(run(ctx, root, { prune: true }), /x\.mdx/);
        await rejectsValidation(run(ctx, root, { prune: true }), /guides/);
        for (const s of ["bad", "x", "guides/a", "guides/b", "keep"]) expect((await bySlug(ctx, s))!.deletedAt).toBeNull();
      });
    });

    test("a gone page is not paired with an unreadable file", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "a.md": page("A"), "b.md": page("B") });
        await run(ctx, root);
        drop(root, "a.md");
        put(root, "b.md", "---\ntitle: [\n---\n");
        put(root, "c.md", "---\ntitle: [\n---\n");
        const r = await run(ctx, root);
        // a is gone, c is unreadable and cannot be created: nothing to pair, nothing to stop
        expect(r.starlight!.stop).toBeNull();
        await rejectsValidation(run(ctx, root, { prune: true }), /could not be read/);
        expect((await bySlug(ctx, "a"))!.deletedAt).toBeNull();
      });
    });

    test("a new draft: true page does not block prune", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "a.md": page("A"), "g.md": page("G") });
        await run(ctx, root);
        drop(root, "g.md");
        put(root, "d.md", page("D", "draft: true\n"));
        const r = await run(ctx, root, { prune: true, acceptNewAndGone: true });
        expect(r.starlight!.pruned).toEqual(["g"]);
        expect(outcome(r, "d.md")).toBe("skipped");
      });
    });

    test("a page whose English file is now a.markdown is not gone and does not block prune", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "a.md": page("A"), "p.md": page("P"), "g.md": page("G") });
        await run(ctx, root);
        drop(root, "a.md");
        drop(root, "g.md");
        put(root, "a.markdown", "x");
        const r = await run(ctx, root, { prune: true });
        expect(r.starlight!.pruned).toEqual(["g"]);
        expect(r.starlight!.unsupported).toEqual([`${D}/a.markdown`]);
        expect((await bySlug(ctx, "a"))!.deletedAt).toBeNull();
      });
    });

    test("a symlinked English FILE keeps its document found (and blocks prune)", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "b.md": page("B"), "p.md": page("P") });
        await run(ctx, root);
        const target = path.join(root, "elsewhere.md");
        fs.renameSync(path.join(root, D, "b.md"), target);
        fs.symlinkSync(target, path.join(root, D, "b.md"));
        put(root, "n.md", page("N"));
        const r = await run(ctx, root);
        expect(r.starlight!.stop).toBeNull();
        expect(outcome(r, "n.md")).toBe("created");
        expect((await bySlug(ctx, "b"))!.deletedAt).toBeNull();
        await rejectsValidation(run(ctx, root, { prune: true }), /b\.md/);
      });
    });

    test("a symlink under de/ does not block prune", async () => {
      await setup(async (_sql, ctx) => {
        const root = docsProject({ "a.md": page("A"), "g.md": page("G") });
        await run(ctx, root);
        drop(root, "g.md");
        const target = path.join(root, "elsewhere.md");
        fs.writeFileSync(target, "x");
        fs.mkdirSync(path.join(root, D, "de"));
        fs.symlinkSync(target, path.join(root, D, "de", "x.md"));
        const r = await run(ctx, root, { prune: true });
        expect(r.starlight!.pruned).toEqual(["g"]);
      });
    });
  });

  test("first run: a fresh database imports new pages in one call; the dry run reports the same", async () => {
    await setup(async (sql, ctx) => {
      const root = docsProject({
        "index.mdx": page("Home", "", "Welcome"), "guides/one.md": page("One"), "guides/two.md": page("Two"),
        "de/one.md": page("Eins"),
      });
      const dry = await run(ctx, root, { dryRun: true });
      expect(await counts(sql)).toBe("0/0/0");
      const real = await run(ctx, root);
      expect(real.errors).toEqual([]);
      // `de/one.md` has no page `one` (the English page is `guides/one`): a locale file with no live document is skipped
      expect(real.files.map((f) => [f.file, f.outcome, f.published])).toEqual([
        [`${D}/de/one.md`, "skipped", false],
        [`${D}/guides/one.md`, "created", true], [`${D}/guides/two.md`, "created", true], [`${D}/index.mdx`, "created", true],
      ]);
      expect(real.warnings.map((w) => w.file)).toEqual([`${D}/de/one.md`]);
      expect(dry.files.map((f) => [f.file, f.outcome, f.published])).toEqual(real.files.map((f) => [f.file, f.outcome, f.published]));
      expect(dry.files.every((f) => f.docId === null)).toBe(true);
      expect(real.warnings).toEqual(dry.warnings);
      expect((await bySlug(ctx, "index"))!.locales.en!.published!.data["body"]).toMatchObject({ mode: "mdx" });
    });
  });

  test("heads are read per page of documents: no per-file read", async () => {
    await setup(async (sql, ctx) => {
      const files = (from: number, to: number): Record<string, string> => {
        const out: Record<string, string> = {};
        for (let i = from; i < to; i++) out[`p${i}.md`] = page(`P${i}`);
        return out;
      };
      const root = docsProject(files(0, 10));
      await run(ctx, root);
      const counting = await countingSql(sql);
      try {
        const cctx = { ...ctx, sql: counting.sql };
        counting.reset();
        const r10 = await run(cctx, root);
        const n10 = counting.count();
        expect(r10.files.filter((f) => f.outcome === "unchanged")).toHaveLength(10);
        for (const [rel, text] of Object.entries(files(10, 40))) put(root, rel, text);
        await run(ctx, root);
        counting.reset();
        const r40 = await run(cctx, root);
        const n40 = counting.count();
        expect(r40.files.filter((f) => f.outcome === "unchanged")).toHaveLength(40);
        expect(n10).toBeGreaterThan(0);
        expect(n40).toBe(n10);
      } finally {
        await counting.sql.end();
      }
    });
  });

  test("more than one page of documents is read and matched", async () => {
    await setup(async (_sql, ctx) => {
      const out: Record<string, string> = {};
      for (let i = 0; i < 205; i++) out[`p${i}.md`] = page(`P${i}`);
      const root = docsProject(out);
      await run(ctx, root);
      expect((await listDocuments(ctx, { collection: "docs", limit: 200 })).next).not.toBeNull();
      const r = await run(ctx, root, { prune: true });
      expect(r.files).toHaveLength(205);
      expect(r.files.every((f) => f.outcome === "unchanged")).toBe(true);
      expect(r.starlight!.pruned).toEqual([]);
    });
  }, 120_000);

  test("the own-folder layout: a new page and a changed page; the locale file is imported day one", async () => {
    await setup(async (_sql, ctx) => {
      const root = project({
        [`${D}/en/a.md`]: page("A"), [`${D}/en/b.md`]: page("B"), [`${D}/de/a.md`]: page("Hallo"),
      });
      const own = (opts: Record<string, unknown> = {}) => importFolder(ctx, { dir: root, starlight: { layout: layoutOwn, ...opts } });
      const r1 = await own();
      expect(r1.files).toEqual([
        { file: `${D}/de/a.md`, docId: expect.any(String), outcome: "updated", published: true },
        { file: `${D}/en/a.md`, docId: expect.any(String), outcome: "created", published: true },
        { file: `${D}/en/b.md`, docId: expect.any(String), outcome: "created", published: true },
      ]);
      expect(r1.warnings).toEqual([]);
      put(root, "en/b.md", page("B2"));
      put(root, "en/c.md", page("C"));
      const r2 = await own();
      expect(r2.files.map((f) => f.outcome)).toEqual(["unchanged", "unchanged", "updated", "created"]);
      expect((await bySlug(ctx, "b"))!.locales.en!.published!.data["title"]).toBe("B2");
      expect((await bySlug(ctx, "a"))!.locales["de"]!.published!.data["title"]).toBe("Hallo");
    });
  });
});
