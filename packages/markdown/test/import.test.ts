import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Sql } from "postgres";
import { LicenceError, ValidationError, defineCollection, defineConfig, richText, text, getDocument, listDocuments, migrate, recordAiDraft } from "@mogging/core";
import { importFolder } from "../src/import.js";
import { isSafeSlug } from "../src/slug.js";
import { withTestDb } from "./db.js";
import { ctxFor, docs, writeTree } from "./fixtures.js";

async function setup(fn: (sql: Sql, ctx: ReturnType<typeof ctxFor>) => Promise<void>) {
  await withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql, ctxFor(sql));
  });
}

const INTRO = "---\ntitle: Intro\nauthor: jane\n---\nHello **world**\n";
const JANE = "---\nname: Jane\n---\nBio\n";
const INTRO_DE = "---\ntitle: Einleitung\n---\nHallo\n";
const basic = () => ({
  "en/docs/guide/intro.md": INTRO,
  "en/people/jane.md": JANE,
  "de/docs/guide/intro.md": INTRO_DE,
});

const outcome = (r: { files: Array<{ file: string; outcome: string }> }, file: string) =>
  r.files.find((f) => f.file === file)?.outcome;

async function versions(sql: Sql): Promise<string> {
  const a = await sql`select doc_id, 'shared' as scope, max(version) as v from document_shared group by doc_id`;
  const b = await sql`select doc_id, locale as scope, max(version) as v from document_localized group by doc_id, locale`;
  return JSON.stringify([...a, ...b].map((r) => `${r.doc_id}/${r.scope}/${r.v}`).sort());
}

describe("importFolder", () => {
  test("first import creates documents, shared and localized drafts", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, basic());
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toEqual([]);
      expect(r.files).toHaveLength(3);
      expect(outcome(r, "en/docs/guide/intro.md")).toBe("created");
      expect(outcome(r, "en/people/jane.md")).toBe("created");
      expect(outcome(r, "de/docs/guide/intro.md")).toBe("updated");
      const intro = (await getDocument(ctx, { collection: "docs", slug: "guide/intro" }))!;
      const jane = (await getDocument(ctx, { collection: "people", slug: "jane" }))!;
      expect((intro.locales["en"]!.draft!.data["body"] as { type: string }).type).toBe("root");
      expect(intro.locales["de"]!.draft!.data["title"]).toBe("Einleitung");
      expect(intro.shared.draft!.data["author"]).toBe(jane.id);
      expect(intro.shared.draft!.data["slug"]).toBe("guide/intro");
    });
  });

  test("second identical import writes nothing", async () => {
    await setup(async (sql, ctx) => {
      const dir = writeTree(null, basic());
      await importFolder(ctx, { dir });
      const before = await versions(sql);
      const r = await importFolder(ctx, { dir });
      expect(r.files.map((f) => f.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
      expect(await versions(sql)).toBe(before);
    });
  });

  test("an AI draft survives a re-import of the old translation", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, basic());
      await importFolder(ctx, { dir, publish: true });
      const doc = (await getDocument(ctx, { collection: "docs", slug: "guide/intro" }))!;
      const res = await recordAiDraft(ctx, {
        docId: doc.id, locale: "de", fields: { title: "KI" },
        sourceVersion: doc.locales["en"]!.published!.version, sourceHashes: {},
        provenance: [{ fieldPath: "title", modelId: "m", promptVersion: "v1", promptTokens: 1, completionTokens: 1, costMicros: 1 }],
      });
      expect(res).toHaveProperty("version");
      const again = await importFolder(ctx, { dir, publish: true });
      expect(outcome(again, "de/docs/guide/intro.md")).toBe("unchanged");
      const mid = (await getDocument(ctx, { collection: "docs", docId: doc.id }))!;
      expect(mid.locales["de"]!.draft!.state).toBe("DRAFT_AI");

      fs.writeFileSync(path.join(dir, "de/docs/guide/intro.md"), "---\ntitle: Neu\n---\nHallo\n");
      const third = await importFolder(ctx, { dir });
      expect(outcome(third, "de/docs/guide/intro.md")).toBe("updated");
      expect(third.warnings.some((w) => w.message.includes("replaced pending DRAFT_AI draft"))).toBe(true);
      const end = (await getDocument(ctx, { collection: "docs", docId: doc.id }))!;
      expect(end.locales["de"]!.draft!.state).toBe("DRAFT_HUMAN");
    });
  });

  test("publish publishes human drafts equal to the file", async () => {
    await setup(async (sql, ctx) => {
      const dir = writeTree(null, basic());
      const r = await importFolder(ctx, { dir, publish: true });
      expect(r.files.every((f) => f.published)).toBe(true);
      const doc = (await getDocument(ctx, { collection: "docs", slug: "guide/intro" }))!;
      expect(doc.locales["en"]!.published).not.toBeNull();
      expect(doc.locales["de"]!.published).not.toBeNull();
      expect(doc.shared.published).not.toBeNull();
      const before = await versions(sql);
      const r2 = await importFolder(ctx, { dir, publish: true });
      expect(r2.files.every((f) => !f.published && f.outcome === "unchanged")).toBe(true);
      expect(await versions(sql)).toBe(before);
    });
  });

  test("a failing file rolls back alone", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, {
        "en/docs/good.md": "---\ntitle: G\n---\nx\n",
        "en/docs/bad.md": "---\norder: x\n---\ny\n",
      });
      const r = await importFolder(ctx, { dir });
      expect(outcome(r, "en/docs/good.md")).toBe("created");
      const bad = r.files.find((f) => f.file === "en/docs/bad.md")!;
      expect(bad.outcome).toBe("error");
      expect(bad.docId).toBeNull();
      expect(r.errors[0]!.file).toBe("en/docs/bad.md");
      expect((await listDocuments(ctx, { collection: "docs" })).items).toHaveLength(1);
    });
  });

  test("unresolved reference is a per-file error", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "---\nauthor: nobody\n---\nx\n" });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.message).toContain("author");
      expect((await listDocuments(ctx, { collection: "docs" })).items).toHaveLength(0);
    });
  });

  test("a dangling UUID reference is a per-file error", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": `---\nauthor: ${randomUUID()}\n---\nx\n` });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.message).toContain("author");
      expect((await listDocuments(ctx, { collection: "docs" })).items).toHaveLength(0);
    });
  });

  test("target file without source document is an error", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "x\n", "de/docs/b.md": "---\ntitle: B\n---\nx\n" });
      const r = await importFolder(ctx, { dir });
      expect(outcome(r, "en/docs/a.md")).toBe("created");
      expect(outcome(r, "de/docs/b.md")).toBe("error");
      expect(r.errors[0]).toEqual({ file: "de/docs/b.md", message: "no source document for docs/b" });
    });
  });

  test("undeclared locale directory warned", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "x\n", "fr/docs/a.md": "x\n", "zz-/docs/a.md": "x\n" });
      const r = await importFolder(ctx, { dir });
      expect(r.files.map((f) => f.file)).toEqual(["en/docs/a.md"]);
      expect(r.warnings.filter((w) => w.file === "fr" || w.file === "zz-")).toHaveLength(2);
      expect(r.errors).toEqual([]);
    });
  });

  test("unknown collection warned", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/widgets/a.md": "x\n", "en/docs/ok.md": "x\n", "en/docs/notes.txt": "x", "en/docs/.hidden.md": "x" });
      const r = await importFolder(ctx, { dir });
      expect(r.files.map((f) => f.file)).toEqual(["en/docs/ok.md"]);
      expect(r.warnings.map((w) => w.file).sort()).toEqual(["en/docs/notes.txt", "en/widgets"]);
    });
  });

  test("uppercase slug path is an error", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/Guide.md": "x\n" });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toEqual([{ file: "en/docs/Guide.md", message: "slug path must be lowercase" }]);
    });
  });

  test("slug path with a backslash in a file name is an error", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a\\b.md": "x\n" });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toEqual([{ file: "en/docs/a\\b.md", message: "unsafe slug path" }]);
      expect((await listDocuments(ctx, { collection: "docs" })).items).toHaveLength(0);
    });
  });

  test("md and mdx twins are both errors", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/t.md": "x\n", "en/docs/t.mdx": "x\n", "en/docs/u.md": "x\n" });
      const r = await importFolder(ctx, { dir });
      expect(r.errors.map((e) => e.file).sort()).toEqual(["en/docs/t.md", "en/docs/t.mdx"]);
      expect(outcome(r, "en/docs/u.md")).toBe("created");
    });
  });

  test("list of references resolves", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, {
        "en/docs/a.md": "---\nrelated: [guide/intro, other]\n---\nx\n",
        "en/docs/guide/intro.md": "x\n",
        "en/docs/other.md": "x\n",
      });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toEqual([]);
      const a = (await getDocument(ctx, { collection: "docs", slug: "a" }))!;
      const intro = (await getDocument(ctx, { collection: "docs", slug: "guide/intro" }))!;
      const other = (await getDocument(ctx, { collection: "docs", slug: "other" }))!;
      expect(a.shared.draft!.data["related"]).toEqual([intro.id, other.id]);

      const dir2 = writeTree(null, { "en/docs/b.md": "---\nrelated: [missing]\n---\nx\n" });
      const r2 = await importFolder(ctx, { dir: dir2 });
      expect(r2.errors).toHaveLength(1);
      expect(r2.errors[0]!.message).toContain("related");
    });
  });

  test("mdx extension parses in mdx mode", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/m.mdx": "Hello <Badge />\n" });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toEqual([]);
      const m = (await getDocument(ctx, { collection: "docs", slug: "m" }))!;
      expect((m.locales["en"]!.draft!.data["body"] as { mode: string }).mode).toBe("mdx");
    });
  });

  test("a key dropped from the file is dropped from the next draft, then settles", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "---\ntitle: T\ndescription: D\n---\nx\n" });
      await importFolder(ctx, { dir });
      fs.writeFileSync(path.join(dir, "en/docs/a.md"), "---\ntitle: T\n---\nx\n");
      const r2 = await importFolder(ctx, { dir });
      expect(outcome(r2, "en/docs/a.md")).toBe("updated");
      const doc = (await getDocument(ctx, { collection: "docs", slug: "a" }))!;
      expect(Object.keys(doc.locales["en"]!.draft!.data).sort()).toEqual(["body", "title"]);
      const r3 = await importFolder(ctx, { dir });
      expect(outcome(r3, "en/docs/a.md")).toBe("unchanged");
    });
  });

  test("an empty target file writes no empty snapshot", async () => {
    await setup(async (sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "x\n", "de/docs/a.md": "" });
      const r = await importFolder(ctx, { dir });
      expect(outcome(r, "de/docs/a.md")).toBe("unchanged");
      const rows = await sql`select 1 from document_localized where locale = 'de'`;
      expect(rows).toHaveLength(0);
    });
  });

  test("a YAML null nested in a list is stored as core stores it (measured: core accepts it)", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "---\ntags: [x, ~]\n---\nx\n" });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toEqual([]);
      const a = (await getDocument(ctx, { collection: "docs", slug: "a" }))!;
      expect(a.locales["en"]!.draft!.data["tags"]).toEqual(["x", null]);
      expect(outcome(await importFolder(ctx, { dir }), "en/docs/a.md")).toBe("unchanged");
    });
  });

  test("reference to a source file that failed pass 1 is an error, not a hang", async () => {
    await withTestDb(async (sql) => {
      await migrate(sql);
      // people has no slug field, so the pass-1 save of { slug } fails for every people file.
      const noSlug = defineCollection("people", { name: text(), body: richText({ localized: true, body: true }) });
      const cfg = defineConfig({ collections: [docs, noSlug], locales: { source: "en", chains: { de: ["en"] } } });
      const ctx = { sql, config: cfg, actor: "tester" };
      const dir = writeTree(null, { "en/docs/a.md": "---\nauthor: jane\n---\nx\n", "en/people/jane.md": "---\nname: J\n---\nx\n" });
      const r = await importFolder(ctx, { dir });
      expect(outcome(r, "en/people/jane.md")).toBe("error");
      expect(outcome(r, "en/docs/a.md")).toBe("error");
      expect(r.errors.find((e) => e.file === "en/docs/a.md")!.message).toContain("unresolved reference");
    });
  });

  test("null in a reference list is an error", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "---\nrelated: [~]\n---\nx\n", "en/docs/ok.md": "x\n" });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toEqual([{ file: "en/docs/a.md", message: "related: unresolved reference null in collection docs" }]);
      expect(outcome(r, "en/docs/ok.md")).toBe("created");
    });
  });

  test("reference slugs are case-insensitive", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "---\nauthor: Jane\n---\nx\n", "en/people/jane.md": JANE });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toEqual([]);
      const a = (await getDocument(ctx, { collection: "docs", slug: "a" }))!;
      const jane = (await getDocument(ctx, { collection: "people", slug: "jane" }))!;
      expect(a.shared.draft!.data["author"]).toBe(jane.id);
    });
  });

  test("target-file error keeps the docId", async () => {
    await setup(async (_sql, ctx) => {
      // A NUL character passes normalization but the database refuses it in jsonb: a pass-2 failure.
      const dir = writeTree(null, { "en/docs/a.md": "x\n", "de/docs/a.md": '---\ntitle: "a\\0b"\n---\nx\n' });
      const r = await importFolder(ctx, { dir });
      const a = (await getDocument(ctx, { collection: "docs", slug: "a" }))!;
      const de = r.files.find((f) => f.file === "de/docs/a.md")!;
      expect(de.outcome).toBe("error");
      expect(de.docId).toBe(a.id);
      const missing = await importFolder(ctx, { dir: writeTree(null, { "de/docs/zz.md": "x\n" }) });
      expect(missing.files[0]!.docId).toBeNull();
    });
  });

  test("overwriting an unpublished human draft warns", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "---\ntitle: One\nauthor: jane\n---\nx\n", "en/people/jane.md": JANE });
      const first = await importFolder(ctx, { dir });
      expect(first.warnings).toEqual([]);
      fs.writeFileSync(path.join(dir, "en/docs/a.md"), "---\ntitle: Two\nauthor: jane\n---\nx\n");
      const second = await importFolder(ctx, { dir });
      expect(second.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/^replaced unpublished DRAFT_HUMAN draft v\d+ for en$/)]);
    });
  });

  test("LicenceError is rethrown", async () => {
    await setup(async (sql, ctx) => {
      const saved = process.env.MOGGING_LICENSE_KEY;
      delete process.env.MOGGING_LICENSE_KEY;
      try {
        await sql`update migrations set applied_at = now() - interval '60 days'`;
        const dir = writeTree(null, { "en/docs/a.md": "x\n", "en/docs/b.md": "x\n" });
        await expect(importFolder(ctx, { dir })).rejects.toBeInstanceOf(LicenceError);
      } finally {
        if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
      }
    });
  });

  test("wrong-collection UUID is a dangling reference", async () => {
    await setup(async (_sql, ctx) => {
      await importFolder(ctx, { dir: writeTree(null, { "en/people/jane.md": JANE }) });
      const jane = (await getDocument(ctx, { collection: "people", slug: "jane" }))!;
      const r = await importFolder(ctx, { dir: writeTree(null, { "en/docs/b.md": `---\nrelated: ["${jane.id}"]\n---\nx\n` }) });
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.message).toContain("dangling reference");
    });
  });

  test("a leading BOM and CRLF line endings import", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/a.md": "﻿---\r\ntitle: T\r\n---\r\nx\r\n" });
      const r = await importFolder(ctx, { dir });
      expect(r.errors).toEqual([]);
      const a = (await getDocument(ctx, { collection: "docs", slug: "a" }))!;
      expect(a.locales["en"]!.draft!.data["title"]).toBe("T");
    });
  });

  test("a missing directory throws before any write", async () => {
    await setup(async (_sql, ctx) => {
      const missing = path.join(os.tmpdir(), "mog-does-not-exist-" + randomUUID());
      await expect(importFolder(ctx, { dir: missing })).rejects.toThrow(ValidationError);
      await expect(importFolder(ctx, { dir: missing })).rejects.toThrow(`import directory not found: ${missing}`);
    });
  });
});

describe("isSafeSlug", () => {
  test("accepts paths and rejects traversal, empties, backslash and NUL", () => {
    expect(isSafeSlug("a")).toBe(true);
    expect(isSafeSlug("a/b-c")).toBe(true);
    for (const bad of ["", "/a", "a/", "a//b", ".", "..", "a/../b", "a/./b", "a\\b", "a\0b"]) {
      expect(isSafeSlug(bad)).toBe(false);
    }
  });
});
