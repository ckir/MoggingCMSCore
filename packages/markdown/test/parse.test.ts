import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ValidationError } from "@mogging/core";
import { markdownToTree } from "../src/index.js";
import { validateTree } from "../src/tree.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("markdownToTree", () => {
  test("paragraph with marks, inline code and link", () => {
    expect(markdownToTree("Hello **big** `x` [a](u)\n")).toEqual({
      type: "root", version: 1, mode: "md",
      children: [{
        type: "paragraph",
        children: [
          { type: "text", value: "Hello ", marks: [] },
          { type: "text", value: "big", marks: ["strong"] },
          { type: "text", value: " ", marks: [] },
          { type: "inlineCode", value: "x", source: "`x`", marks: [] },
          { type: "text", value: " ", marks: [] },
          { type: "link", url: "u", title: null, children: [{ type: "text", value: "a", marks: [] }] },
        ],
      }],
    });
  });

  test("marks pushed into links and sorted", () => {
    const a = markdownToTree("**[a](u)**\n").children[0] as any;
    expect(a.children).toEqual([
      { type: "link", url: "u", title: null, children: [{ type: "text", value: "a", marks: ["strong"] }] },
    ]);
    const b = markdownToTree("***x***\n").children[0] as any;
    expect(b.children).toEqual([{ type: "text", value: "x", marks: ["emphasis", "strong"] }]);
  });

  test("container directive with label and attributes", () => {
    const t = markdownToTree(":::warning[Be **careful**]{#w .x}\nBody text.\n:::\n");
    expect(t.children).toEqual([{
      type: "container", name: "warning", attributes: { id: "w", class: "x" },
      label: [
        { type: "text", value: "Be ", marks: [] },
        { type: "text", value: "careful", marks: ["strong"] },
      ],
      children: [{ type: "paragraph", children: [{ type: "text", value: "Body text.", marks: [] }] }],
    }]);
  });

  test("text directive syntax is not parsed", () => {
    const t = markdownToTree("see ⟦MOGGING:3⟧ and :abbr here");
    expect(t.children).toEqual([{
      type: "paragraph",
      children: [{ type: "text", value: "see ⟦MOGGING:3⟧ and :abbr here", marks: [] }],
    }]);
  });

  test("opaque source inside containers", () => {
    const a = markdownToTree("> ```js\n> let a = 1;\n>   b\n> ```\n").children[0] as any;
    expect(a.children[0].type).toBe("code");
    expect(a.children[0].source).toBe("```js\nlet a = 1;\n  b\n```");
    const b = markdownToTree("- item\n\n  <div>\n    x\n  </div>\n").children[0] as any;
    const html = b.children[0].children[1];
    expect(html.type).toBe("opaqueBlock");
    expect(html.node).toBe("html");
    expect(html.source).toBe("<div>\n  x\n</div>");
  });

  test("mdx mode", () => {
    const src = '<Badge text="x" /> and {name}\n';
    const m = markdownToTree(src, { mode: "mdx" });
    expect(m.mode).toBe("mdx");
    const kids = (m.children[0] as any).children;
    expect(kids.map((k: any) => [k.type, k.node])).toEqual([
      ["opaqueInline", "mdxJsxTextElement"],
      ["text", undefined],
      ["opaqueInline", "mdxTextExpression"],
    ]);
    expect(kids[2].source).toBe("{name}");
    const d = (markdownToTree(src).children[0] as any).children;
    expect(d[0]).toEqual({ type: "opaqueInline", node: "html", source: '<Badge text="x" />', marks: [] });
    expect(d[1]).toEqual({ type: "text", value: " and {name}", marks: [] });
  });

  test("invalid MDX throws", () => {
    let err: unknown;
    try { markdownToTree("<br>\n", { mode: "mdx" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message.startsWith("invalid MDX:")).toBe(true);
  });

  test("CRLF and NFC normalized", () => {
    const t = markdownToTree("Café\r\n");
    expect(t.children).toEqual([{ type: "paragraph", children: [{ type: "text", value: "Café", marks: [] }] }]);
  });

  test("every corpus page converts to a valid tree", () => {
    const dir = path.join(here, "corpus");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");
    expect(files.length).toBe(20);
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      expect(() => validateTree(markdownToTree(text)), f).not.toThrow();
    }
  });
});
