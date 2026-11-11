import { describe, expect, test } from "vitest";
import {
  ValidationError, defineCollection, slug, text, richText, list, reference, number,
} from "@mogging/core";
import { markdownToTree } from "../src/parse.js";
import { splitFrontMatter, mapFile, renderFile } from "../src/contentFile.js";

const docs = defineCollection("docs", {
  slug: slug(),
  title: text({ localized: true }),
  description: text({ localized: true }),
  banner: text({ localized: true }),
  summary: richText({ localized: true }),
  tags: list(text(), { localized: true }),
  author: reference("people"),
  related: list(reference("docs")),
  order: number(),
  body: richText({ localized: true, body: true }),
});

const SRC = { isSourceLocale: true, mode: "md" as const };
const TGT = { isSourceLocale: false, mode: "md" as const };
const emptyTree = { type: "root", version: 1, mode: "md", children: [] };

const map = (text: string, o = SRC) => mapFile(docs, splitFrontMatter(text), o);

describe("content files", () => {
  test("bare key, empty string and missing key", () => {
    expect("banner" in map("---\nbanner:\n---\nHi\n").localized).toBe(false);
    expect(map('---\nbanner: ""\n---\nHi\n').localized["banner"]).toBe("");
    expect("banner" in map("---\ntitle: T\n---\nHi\n").localized).toBe(false);
  });

  test("shared key in a target file is warned and ignored", () => {
    const m = map("---\norder: 3\ntitle: T\n---\n", TGT);
    expect(m.shared).toEqual({});
    expect(m.localized).toEqual({ title: "T" });
    expect(m.warnings).toContain('shared field "order" is read from the source locale only; ignored');
  });

  test("undeclared key is an error", () => {
    expect(() => map("---\nnope: 1\n---\n")).toThrow(ValidationError);
    expect(() => map("---\nnope: 1\n---\n")).toThrow("nope: undeclared field");
  });

  test("body key in front matter is an error", () => {
    expect(() => map("---\nbody: x\n---\n")).toThrow(
      "body: the body field comes from the Markdown body, not front matter",
    );
  });

  test("slug key warned", () => {
    const m = map("---\nslug: x\n---\n");
    expect(m.warnings).toContain('slug comes from the file path; front-matter "slug" ignored');
    expect(m.shared).toEqual({});
  });

  test("reference becomes a placeholder", () => {
    expect(map("---\nauthor: jane\n---\n").shared["author"]).toEqual({ $ref: "jane", collection: "people" });
  });

  test("richText front-matter field becomes a tree", () => {
    const m = map('---\nsummary: "Hello *there*"\n---\n');
    expect(m.localized["summary"]).toEqual(markdownToTree("Hello *there*", { mode: "md" }));
    expect(map('---\nsummary: ""\n---\n').localized["summary"]).toEqual(emptyTree);
  });

  test("whitespace-only body is absent", () => {
    expect("body" in map("---\ntitle: T\n---\n\n  \n").localized).toBe(false);
  });

  test("CRLF front matter", () => {
    const m = map("---\r\ntitle: T\r\n---\r\nHi\r\n");
    expect(m.localized["title"]).toBe("T");
    expect(JSON.stringify(m.localized["body"])).toContain('"value":"Hi"');
  });

  test("unclosed, non-mapping and duplicate-key front matter throw", () => {
    expect(() => splitFrontMatter("---\ntitle: T\n")).toThrow(ValidationError);
    expect(() => splitFrontMatter("---\n- a\n---\n")).toThrow(ValidationError);
    expect(() => splitFrontMatter("---\na: 1\na: 2\n---\n")).toThrow(ValidationError);
    expect(() => splitFrontMatter("---\n- a\n---\n")).toThrow(/^front matter: /);
  });

  test("VitePress container warned", () => {
    const w = map("---\n---\n::: tip Hint\nx\n:::\n").warnings;
    expect(w).toContain(
      'line 1: "::: tip" (VitePress container syntax) is not supported; use ":::tip[Title]"',
    );
    expect(map("---\n---\n```\n::: tip Hint\n```\n").warnings).toEqual([]);
  });

  test("renderFile then mapFile round trip", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const body = markdownToTree("Hello world", { mode: "md" });
    const data = {
      shared: { author: a, related: [a, b], order: 3 },
      localized: { title: "T", banner: "", tags: [], summary: emptyTree, body },
    };
    const out = renderFile(docs, data, { isSourceLocale: true, refToText: () => "jane" });
    expect(out).not.toMatch(/^\w+:\s*$/m);
    const m = mapFile(docs, splitFrontMatter(out), SRC);
    expect(m.shared).toEqual({
      author: { $ref: "jane", collection: "people" },
      related: [{ $ref: "jane", collection: "docs" }, { $ref: "jane", collection: "docs" }],
      order: 3,
    });
    expect(m.localized).toEqual(data.localized);
    expect(m.warnings).toEqual([]);
  });
});
