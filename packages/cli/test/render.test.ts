import { describe, expect, test } from "vitest";
import type { GlossaryEntry } from "@mogging/ai";
import type { DraftReview, ReviewField } from "@mogging/core";
import { markdownToTree } from "@mogging/markdown";
import { renderDraftReview, valueText } from "../src/render.js";

const field = (path: string, over: Partial<ReviewField> = {}): ReviewField => ({
  path, source: undefined, previous: undefined, previousFrom: null, draft: undefined, warnings: [], edited: false,
  sourceChanged: false, ...over,
});

const review = (fields: ReviewField[], over: Partial<DraftReview> = {}): DraftReview => ({
  docId: "00000000-0000-0000-0000-000000000001", collection: "docs", slug: "intro", locale: "de", version: 3,
  state: "DRAFT_AI", sourceLocale: "en", sourceVersion: 1, supersededVersion: null, fields, ...over,
});

const entry = (term: string, translation: string | null, doNotTranslate = false): GlossaryEntry => ({
  sourceLocale: "en", targetLocale: "de", term, translation, acceptedForms: [], doNotTranslate, note: null,
});

const plain = { width: 40, color: false };

/** One row of the two columns (at width 40 each column is 18 wide, at 60 it is 28), the gutter is " | ". */
const row = (left: string, right: string, col = 18) => `${left.padEnd(col)} | ${right}`.trimEnd();

describe("valueText", () => {
  test("text is the string, absent is (none), a richText tree is Markdown, a richText string is itself, the rest is JSON", () => {
    expect(valueText("Hallo", "text")).toBe("Hallo");
    expect(valueText(undefined, "text")).toBe("(none)");
    expect(valueText(markdownToTree("Hallo *Welt*"), "richText")).toBe("Hallo *Welt*\n");
    expect(valueText("Hallo *Welt*", "richText")).toBe("Hallo *Welt*");
    expect(valueText(3, "number")).toBe("3");
    expect(valueText(["a", "b"], "list")).toBe('["a","b"]');
    expect(valueText(true, "")).toBe("true");
  });
});

describe("renderDraftReview", () => {
  test("a one-field review at width 40: wrapped aligned columns, the warning line, the superseded label", () => {
    const lines = renderDraftReview(
      review(
        [
          field("title", {
            source: "Introduction to the system",
            previous: "Alte Einleitung zum System",
            previousFrom: "superseded",
            draft: "Einleitung in das System",
            warnings: ['glossary: "system" expected "System"'],
          }),
        ],
        { supersededVersion: 2 },
      ),
      { title: "text" },
      plain,
    );
    expect(lines).toEqual([
      "docs/intro de v3 DRAFT_AI (source en v1)",
      "",
      "title",
      "source",
      "  Introduction to the system",
      "previous           | draft",
      "(superseded v2)    |",
      "Alte Einleitung    | Einleitung in das",
      "zum System         | System",
      '! glossary: "system" expected "System"',
    ]);
  });

  test("a published previous value is labelled without a version and a missing one prints (none)", () => {
    const published = renderDraftReview(
      review([field("title", { source: "Intro", previous: "Einleitung", previousFrom: "published", draft: "Hallo" })]),
      { title: "text" },
      { width: 60, color: false },
    );
    expect(published).toContain(row("previous (published)", "draft", 28));
    const missing = renderDraftReview(
      review([field("title", { source: "Intro", draft: "Hallo" })]),
      { title: "text" },
      { width: 60, color: false },
    );
    expect(missing).toContain(row("previous", "draft", 28));
    expect(missing).toContain(row("(none)", "Hallo", 28));
  });

  test("a header for a document without a slug uses the id and one without a source head has no source version", () => {
    const [header] = renderDraftReview(review([], { slug: null, sourceVersion: null }), {}, plain);
    expect(header).toBe("docs/00000000-0000-0000-0000-000000000001 de v3 DRAFT_AI (source en)");
  });

  test("a token longer than a column is hard-broken", () => {
    const lines = renderDraftReview(review([field("title", { draft: "x".repeat(30) })]), { title: "text" }, plain);
    expect(lines).toContain(row("(none)", "x".repeat(18)));
    expect(lines).toContain(row("", "x".repeat(12)));
  });

  test("a source that changed after the draft is flagged before the warnings", () => {
    const lines = renderDraftReview(
      review([field("title", { draft: "Hallo", sourceChanged: true, warnings: ["tone: too formal"] })]),
      { title: "text" },
      plain,
    );
    const at = lines.indexOf("! source changed since this draft was translated");
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe("! tone: too formal");
  });

  test("richText values render as Markdown", () => {
    const lines = renderDraftReview(
      review([field("body", { source: markdownToTree("Hello **world**"), draft: markdownToTree("Hallo **Welt**") })]),
      { body: "richText" },
      { width: 60, color: false },
    );
    expect(lines).toContain("  Hello **world**");
    expect(lines.some((l) => l.endsWith("| Hallo **Welt**"))).toBe(true);
  });

  test("color adds ANSI bold to the title rows only; no color adds no escape bytes", () => {
    const r = review([field("title", { draft: "Hallo" }), field("body", { draft: "Welt" })]);
    const kinds = { title: "text", body: "text" };
    const colored = renderDraftReview(r, kinds, { width: 40, color: true });
    expect(colored.filter((l) => l.includes("\u001b"))).toEqual(["\u001b[1mtitle\u001b[22m", "\u001b[1mbody\u001b[22m"]);
    const uncolored = renderDraftReview(r, kinds, plain);
    expect(uncolored.some((l) => l.includes("\u001b"))).toBe(false);
    expect(uncolored).toContain("title");
  });

  test("a glossary term found in the source prints its translation, a do-not-translate entry prints (keep), an absent term nothing", () => {
    const lines = renderDraftReview(
      review([field("title", { source: "The Widget API guide", draft: "Die Widget API Anleitung" })]),
      { title: "text" },
      {
        width: 60,
        color: false,
        glossary: [entry("guide", "Anleitung"), entry("widget", null, true), entry("invoice", "Rechnung")],
      },
    );
    expect(lines).toContain("glossary: guide -> Anleitung");
    expect(lines).toContain("glossary: widget -> (keep)");
    expect(lines.some((l) => l.includes("invoice"))).toBe(false);
  });
});
