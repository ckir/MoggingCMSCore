import { describe, expect, it } from "vitest";
import { ValidationError } from "@mogging/core";
import { validateTree } from "../src/index.js";

const text = (value: string, marks: string[] = []) => ({ type: "text", value, marks });

function canonical(): any {
  return {
    type: "root", version: 1, mode: "mdx",
    children: [
      { type: "paragraph", children: [
        text("plain"),
        text("bold", ["strong"]),
        { type: "inlineCode", value: "x", source: "`x`", marks: [] },
        { type: "opaqueInline", node: "mdxJsxTextElement", source: "<b/>", marks: ["delete", "emphasis"] },
        { type: "image", url: "u.png", title: null, alt: "a", marks: [] },
        { type: "break" },
        { type: "link", url: "https://x", title: null, children: [
          text("l"), { type: "inlineCode", value: "c", source: "`c`", marks: [] },
        ] },
      ] },
      { type: "heading", depth: 2, children: [text("h")] },
      { type: "thematicBreak" },
      { type: "blockquote", children: [{ type: "paragraph", children: [text("q")] }] },
      { type: "list", ordered: true, start: 1, spread: false, children: [
        { type: "listItem", checked: null, spread: false, children: [{ type: "paragraph", children: [text("i")] }] },
      ] },
      { type: "table", align: ["left", null], children: [
        { type: "tableRow", children: [
          { type: "tableCell", children: [text("a")] },
          { type: "tableCell", children: [text("b")] },
        ] },
      ] },
      { type: "code", lang: "ts", meta: null, value: "1", source: "```ts\n1\n```" },
      { type: "container", name: "note", attributes: { a: "b" }, label: [text("lab")], children: [
        { type: "paragraph", children: [text("in")] },
      ] },
      { type: "container", name: "bare", attributes: {}, label: null, children: [] },
      { type: "opaqueBlock", node: "mdxjsEsm", source: "import a from 'a'" },
    ],
  };
}

describe("validateTree", () => {
  it("validateTree accepts a canonical tree", () => {
    const t = canonical();
    expect(validateTree(t)).toBe(t);
  });

  const cases: Array<[string, (t: any) => void, string]> = [
    ["unsorted marks", (t) => { t.children[0].children[1].marks = ["strong", "emphasis"]; }, "$.children[0].children[1].marks"],
    ["unsorted marks (first child)", (t) => { t.children = [{ type: "paragraph", children: [text("a", ["strong", "emphasis"])] }]; }, "$.children[0].children[0].marks"],
    ["duplicate mark", (t) => { t.children[0].children[1].marks = ["strong", "strong"]; }, "$.children[0].children[1].marks"],
    ["extra key foo", (t) => { t.children[1].foo = 1; }, "$.children[1]"],
    ["missing title on link", (t) => { delete t.children[0].children[6].title; }, "$.children[0].children[6]"],
    ["nested link", (t) => { t.children[0].children[6].children.push({ type: "link", url: "u", title: null, children: [] }); }, "$.children[0].children[6].children[2]"],
    ["adjacent equal-marks text", (t) => { t.children[1].children = [text("a", ["strong"]), text("b", ["strong"])]; }, "$.children[1].children[1]"],
    ["empty text", (t) => { t.children[1].children = [text("")]; }, "$.children[1].children[0].value"],
    ["version 2", (t) => { t.version = 2; }, "$.version"],
    ["unknown type html", (t) => { t.children[2] = { type: "html", value: "<b>" }; }, "$.children[2]"],
    ["depth 7", (t) => { t.children[1].depth = 7; }, "$.children[1].depth"],
    ["list start NaN", (t) => { t.children[4].start = NaN; }, "$.children[4].start"],
    ["list start 1.5", (t) => { t.children[4].start = 1.5; }, "$.children[4].start"],
    ["list start -1", (t) => { t.children[4].start = -1; }, "$.children[4].start"],
    ["container label []", (t) => { t.children[7].label = []; }, "$.children[7].label"],
  ];

  it.each(cases)("validateTree rejects %s", (_name, mutate, path) => {
    const t = canonical();
    mutate(t);
    let err: unknown;
    try { validateTree(t); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain(path);
  });
});
