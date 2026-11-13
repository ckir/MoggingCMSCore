import { describe, expect, test } from "vitest";
import type { DraftReview, ReviewField } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { applyEdits, parseEditFile, parseJsonEditFile, serializeEditFile } from "../src/editFile.js";
import { UsageError } from "../src/types.js";

const field = (path: string, draft: unknown, over: Partial<ReviewField> = {}): ReviewField => ({
  path, source: undefined, previous: undefined, previousFrom: null, draft, warnings: [], edited: false,
  sourceChanged: false, ...over,
});

const review = (fields: ReviewField[]): DraftReview => ({
  docId: "00000000-0000-0000-0000-000000000001", collection: "docs", slug: "intro", locale: "de", version: 3,
  state: "DRAFT_AI", sourceLocale: "en", sourceVersion: 1, supersededVersion: null, fields,
});

const kinds = { title: "text", body: "richText", count: "number", tags: "list" };

/** title (text), body (richText tree), count (number), tags (list). */
const draft = () =>
  review([
    field("body", markdownToTree("Hallo *Welt*")),
    field("count", 3),
    field("tags", ["a", "b"]),
    field("title", "Einleitung"),
  ]);

const BODY_MD = "Hallo *Welt*";

describe("serializeEditFile and parseEditFile", () => {
  test("only the text and richText fields are written, one header each, in the draft's order", () => {
    expect(serializeEditFile(draft(), kinds)).toBe(`=== body ===\n${BODY_MD}\n\n=== title ===\nEinleitung\n`);
  });

  test("Review Focus 9: an untouched file returns no edits", () => {
    expect(parseEditFile(serializeEditFile(draft(), kinds), draft(), kinds)).toEqual({});
  });

  test("changing only the title returns only the title", () => {
    const text = serializeEditFile(draft(), kinds).replace("Einleitung", "Neue Einleitung");
    expect(parseEditFile(text, draft(), kinds)).toEqual({ title: "Neue Einleitung" });
  });

  test("a changed richText field comes back as a tree in the draft's mode", () => {
    const text = serializeEditFile(draft(), kinds).replace(BODY_MD, "Hallo *Welt* und mehr");
    expect(parseEditFile(text, draft(), kinds)).toEqual({ body: markdownToTree("Hallo *Welt* und mehr", { mode: "md" }) });
  });

  test("an MDX richText draft edited through the file parses back as MDX", () => {
    const mdx = review([field("body", markdownToTree("Hello there", { mode: "mdx" }))]);
    const text = serializeEditFile(mdx, kinds).replace("Hello there", "Hello again");
    const edits = parseEditFile(text, mdx, kinds);
    expect(edits).toEqual({ body: markdownToTree("Hello again", { mode: "mdx" }) });
    expect((edits.body as { mode: string }).mode).toBe("mdx");
  });

  test("a string-valued richText round-trips untouched and an edit of it becomes an md tree", () => {
    const r = review([field("body", "Hallo Welt")]);
    expect(serializeEditFile(r, kinds)).toBe("=== body ===\nHallo Welt\n");
    expect(parseEditFile(serializeEditFile(r, kinds), r, kinds)).toEqual({});
    const edits = parseEditFile("=== body ===\nHallo Welt!\n", r, kinds);
    expect(edits).toEqual({ body: markdownToTree("Hallo Welt!", { mode: "md" }) });
    expect((edits.body as { mode: string }).mode).toBe("md");
  });

  test("CRLF input is accepted and leaves no carriage return in a value", () => {
    const text = serializeEditFile(draft(), kinds).replace("Einleitung", "Neue Einleitung").replace(/\n/g, "\r\n");
    expect(parseEditFile(text, draft(), kinds)).toEqual({ title: "Neue Einleitung" });
    expect(parseEditFile(serializeEditFile(draft(), kinds).replace(/\n/g, "\r\n"), draft(), kinds)).toEqual({});
  });

  test("a multi-line text value keeps its inner lines and loses one trailing newline only", () => {
    const text = "=== title ===\nzeile 1\nzeile 2\n\n";
    expect(parseEditFile(text, draft(), kinds)).toEqual({ title: "zeile 1\nzeile 2\n" });
  });

  test("a header in another case is not a header: it is value text, or no header at all", () => {
    expect(parseEditFile("=== title ===\nline1\n=== TITLE ===\nline3\n", draft(), kinds)).toEqual({
      title: "line1\n=== TITLE ===\nline3",
    });
    expect(() => parseEditFile("=== Title ===\nx\n", draft(), kinds)).toThrow(UsageError);
  });

  test("an === other === line naming no key of the draft is plain value text, and survives a round trip", () => {
    const r = review([field("title", "a\n=== other ===\nb")]);
    expect(parseEditFile(serializeEditFile(r, kinds), r, kinds)).toEqual({});
    expect(parseEditFile("=== title ===\nx\n=== other ===\ny\n", r, kinds)).toEqual({ title: "x\n=== other ===\ny" });
  });

  test("a value that looks like a section header makes serializing throw, for editable and non-editable keys alike", () => {
    const message = "a value contains a line that looks like a section header; use a JSON edit file";
    for (const forged of ["=== body ===", "=== count ===", "=== title ==="]) {
      const r = review([field("body", markdownToTree("x")), field("count", 3), field("title", `a\n${forged}\nb`)]);
      expect(() => serializeEditFile(r, kinds)).toThrow(UsageError);
      expect(() => serializeEditFile(r, kinds)).toThrow(message);
    }
    const crlf = review([field("count", 3), field("title", "a\r\n=== count ===\r\nb")]);
    expect(() => serializeEditFile(crlf, kinds)).toThrow(UsageError);
  });

  test("a header repeated, a section for a non-editable key, text before the first header, or no header is a UsageError", () => {
    expect(() => parseEditFile("=== title ===\na\n=== title ===\nb\n", draft(), kinds)).toThrow(UsageError);
    expect(() => parseEditFile("=== title ===\na\n=== title ===\nb\n", draft(), kinds)).toThrow(/more than once/);
    expect(() => parseEditFile("=== count ===\n4\n", draft(), kinds)).toThrow("field count is not editable");
    expect(() => parseEditFile("=== tags ===\nx\n", draft(), kinds)).toThrow(UsageError);
    expect(() => parseEditFile("stray\n=== title ===\na\n", draft(), kinds)).toThrow(UsageError);
    expect(() => parseEditFile("just some text\n", draft(), kinds)).toThrow(UsageError);
    expect(() => parseEditFile("", draft(), kinds)).toThrow(UsageError);
  });
});

describe("parseJsonEditFile", () => {
  const json = (o: unknown) => JSON.stringify(o);

  test("an untouched file returns no edits and a change returns only that field", () => {
    expect(parseJsonEditFile(json({ title: "Einleitung", body: BODY_MD }), draft(), kinds)).toEqual({});
    expect(parseJsonEditFile(json({ title: "Neu", body: BODY_MD }), draft(), kinds)).toEqual({ title: "Neu" });
    expect(parseJsonEditFile(json({ body: "Neu" }), draft(), kinds)).toEqual({ body: markdownToTree("Neu", { mode: "md" }) });
  });

  test("an MDX draft stays MDX", () => {
    const mdx = review([field("body", markdownToTree("Hello there", { mode: "mdx" }))]);
    expect(parseJsonEditFile(json({ body: "Hello again" }), mdx, kinds)).toEqual({
      body: markdownToTree("Hello again", { mode: "mdx" }),
    });
  });

  test("a name that is not an editable field of the draft, a non-string value, or bad JSON is a UsageError", () => {
    expect(() => parseJsonEditFile(json({ count: "4" }), draft(), kinds)).toThrow(UsageError);
    expect(() => parseJsonEditFile(json({ nope: "x" }), draft(), kinds)).toThrow(UsageError);
    expect(() => parseJsonEditFile(json({ title: 4 }), draft(), kinds)).toThrow(UsageError);
    expect(() => parseJsonEditFile(json(["title"]), draft(), kinds)).toThrow(UsageError);
    expect(() => parseJsonEditFile("{", draft(), kinds)).toThrow(UsageError);
  });
});

describe("applyEdits", () => {
  test("returns a copy with the edited drafts replaced and marked edited; nothing else changes", () => {
    const before = draft();
    const after = applyEdits(before, { title: "Neu" });
    expect(after.fields.find((f) => f.path === "title")).toMatchObject({ draft: "Neu", edited: true });
    expect(after.fields.find((f) => f.path === "count")).toMatchObject({ draft: 3, edited: false });
    expect(before.fields.find((f) => f.path === "title")).toMatchObject({ draft: "Einleitung", edited: false });
    expect(after).not.toBe(before);
  });
});
