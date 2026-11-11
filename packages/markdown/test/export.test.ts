import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Sql } from "postgres";
import { createDocument, deleteDocument, getDocument, migrate, publish, saveDraft } from "@mogging/core";
import { exportFolder } from "../src/export.js";
import { importFolder } from "../src/import.js";
import { withTestDb } from "./db.js";
import { ctxFor, writeTree } from "./fixtures.js";

async function setup(fn: (sql: Sql, ctx: ReturnType<typeof ctxFor>) => Promise<void>) {
  await withTestDb(async (sql) => {
    await migrate(sql);
    await fn(sql, ctxFor(sql));
  });
}

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), "mog-exp-"));
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8");

const INTRO = "---\ntitle: Intro\nauthor: jane\nrelated: [other]\n---\nHello **world**\n";
const OTHER = "---\ntitle: Other\n---\nSecond\n";
const JANE = "---\nname: Jane\n---\nBio\n";
const INTRO_DE = "---\ntitle: Einleitung\n---\nHallo\n";

describe("exportFolder", () => {
  test("exports published heads only", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/intro.md": "---\ntitle: Published title\n---\nBody\n" });
      await importFolder(ctx, { dir, publish: true });
      const doc = (await getDocument(ctx, { collection: "docs", slug: "intro" }))!;
      await saveDraft(ctx, { docId: doc.id, locale: "en", data: { title: "Draft title" } });
      const out = fresh();
      const r = await exportFolder(ctx, { dir: out });
      expect(r.files).toEqual(["en/docs/intro.md"]);
      const text = read(out, "en/docs/intro.md");
      expect(text).toContain("Published title");
      expect(text).not.toContain("Draft title");
    });
  });

  test("export then import is unchanged", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, {
        "en/docs/guide/intro.md": INTRO,
        "en/docs/other.md": OTHER,
        "en/people/jane.md": JANE,
        "de/docs/guide/intro.md": INTRO_DE,
      });
      await importFolder(ctx, { dir, publish: true });
      const out = fresh();
      const r = await exportFolder(ctx, { dir: out });
      expect(r.warnings).toEqual([]);
      expect(r.files).toEqual([...r.files].sort());
      expect(r.files).toHaveLength(4);
      const again = await importFolder(ctx, { dir: out });
      expect(again.errors).toEqual([]);
      expect(again.files).toHaveLength(4);
      expect(again.files.map((f) => f.outcome)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    });
  });

  test("suppression survives the round trip", async () => {
    await setup(async (_sql, ctx) => {
      const { id } = await createDocument(ctx, { collection: "docs" });
      await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "supp" } });
      await saveDraft(ctx, { docId: id, locale: "en", data: { title: "T", banner: "", tags: [] } });
      await publish(ctx, { docId: id, locale: "shared" });
      await publish(ctx, { docId: id, locale: "en" });
      const out = fresh();
      await exportFolder(ctx, { dir: out });
      const text = read(out, "en/docs/supp.md");
      expect(text).toContain('banner: ""');
      expect(text).toContain("tags: []");
      const before = (await getDocument(ctx, { collection: "docs", docId: id }))!.locales["en"]!.published!.data;
      const r = await importFolder(ctx, { dir: out });
      expect(r.files.map((f) => f.outcome)).toEqual(["unchanged"]);
      const after = (await getDocument(ctx, { collection: "docs", docId: id }))!.locales["en"]!.published!.data;
      expect(after).toEqual(before);
    });
  });

  test("unsafe slug is skipped", async () => {
    await setup(async (_sql, ctx) => {
      const { id } = await createDocument(ctx, { collection: "docs" });
      await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "../escape" } });
      await saveDraft(ctx, { docId: id, locale: "en", data: { title: "T" } });
      await publish(ctx, { docId: id, locale: "shared" });
      await publish(ctx, { docId: id, locale: "en" });
      const parent = fresh();
      const out = path.join(parent, "out");
      fs.mkdirSync(out);
      const r = await exportFolder(ctx, { dir: out });
      expect(r.files).toEqual([]);
      expect(r.warnings).toEqual([{ file: `docs/${id}`, message: 'unsafe slug "../escape"; skipped' }]);
      expect(fs.readdirSync(parent)).toEqual(["out"]);
      expect(fs.readdirSync(out)).toEqual([]);
    });
  });

  test("references exported as slugs", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/intro.md": INTRO, "en/docs/other.md": OTHER, "en/people/jane.md": JANE });
      await importFolder(ctx, { dir, publish: true });
      const out = fresh();
      await exportFolder(ctx, { dir: out });
      const text = read(out, "en/docs/intro.md");
      expect(text).toContain("author: jane");
      expect(text).toContain("related: [ other ]");
    });
  });

  test("mdx body exported with .mdx extension", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/page.mdx": "---\ntitle: P\n---\nHello\n" });
      await importFolder(ctx, { dir, publish: true });
      const out = fresh();
      const r = await exportFolder(ctx, { dir: out });
      expect(r.files).toEqual(["en/docs/page.mdx"]);
      expect(read(out, "en/docs/page.mdx")).toContain("Hello");
    });
  });

  test("mdx file with escaped braces: export then import is unchanged", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/page.mdx": "---\ntitle: P\n---\nUse \\{name\\} and <Badge text=\"x\" /> here\n" });
      await importFolder(ctx, { dir, publish: true });
      const out = fresh();
      const r = await exportFolder(ctx, { dir: out });
      expect(r.files).toEqual(["en/docs/page.mdx"]);
      expect(r.warnings).toEqual([]);
      const again = await importFolder(ctx, { dir: out });
      expect(again.errors).toEqual([]);
      expect(again.files.map((f) => f.outcome)).toEqual(["unchanged"]);
    });
  });

  test("mdx rich-text front matter without a body exports as .mdx", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/page.mdx": "---\ntitle: P\nsummary: \"Hi \\\\{x\\\\}\"\n---\n" });
      await importFolder(ctx, { dir, publish: true });
      const out = fresh();
      const r = await exportFolder(ctx, { dir: out });
      expect(r.files).toEqual(["en/docs/page.mdx"]);
      const again = await importFolder(ctx, { dir: out });
      expect(again.files.map((f) => f.outcome)).toEqual(["unchanged"]);
    });
  });

  test("a reference to a deleted target is warned", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/intro.md": INTRO, "en/docs/other.md": OTHER, "en/people/jane.md": JANE });
      await importFolder(ctx, { dir, publish: true });
      const jane = (await getDocument(ctx, { collection: "people", slug: "jane" }))!;
      await deleteDocument(ctx, { docId: jane.id });
      const out = fresh();
      const r = await exportFolder(ctx, { dir: out });
      expect(r.warnings).toEqual([
        { file: "en/docs/intro.md", message: `author: reference ${jane.id} has no published target; it will not re-import` },
      ]);
      expect(read(out, "en/docs/intro.md")).toContain(`author: ${jane.id}`);
    });
  });

  test("document without published shared head is warned and skipped", async () => {
    await setup(async (_sql, ctx) => {
      const dir = writeTree(null, { "en/docs/intro.md": "---\ntitle: T\n---\nBody\n" });
      await importFolder(ctx, { dir });
      const doc = (await getDocument(ctx, { collection: "docs", slug: "intro" }))!;
      const out = fresh();
      const r = await exportFolder(ctx, { dir: out });
      expect(r.files).toEqual([]);
      expect(r.warnings).toEqual([{ file: `docs/${doc.id}`, message: "no published slug; skipped" }]);
    });
  });
});
