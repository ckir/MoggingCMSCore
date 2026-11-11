import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ValidationError } from "@mogging/core";
import { markdownToTree, treeToMarkdown } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "corpus");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");

function collect(node: unknown, out: any[] = []): any[] {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return out; }
  if (node && typeof node === "object") {
    const o = node as any;
    if (["code", "opaqueBlock", "inlineCode", "opaqueInline"].includes(o.type)) out.push(o);
    for (const v of Object.values(o)) if (v && typeof v === "object") collect(v, out);
  }
  return out;
}

describe("treeToMarkdown", () => {
  test("idempotent on every corpus page", () => {
    expect(files.length).toBe(20);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const t1 = markdownToTree(src);
      const md1 = treeToMarkdown(t1);
      const t2 = markdownToTree(md1);
      expect(t2, f).toEqual(t1);
      expect(treeToMarkdown(t2), f).toBe(md1);
    }
  });

  test.each(["a**b**c", "***x***", "*a*__b__", "**a *b* c**", "~~*x*~~ y", '[**a** b](u "t")', "`x` **`y`**", "a  \nb"])(
    "idempotent on mark edge case %j",
    (src) => {
      const t1 = markdownToTree(src);
      const md1 = treeToMarkdown(t1);
      const t2 = markdownToTree(md1);
      expect(t2).toEqual(t1);
      expect(treeToMarkdown(t2)).toBe(md1);
    },
  );

  test.each([
    "> ```js\n> let a = 1;\n>   b\n> ```\n",
    "- item\n\n  <div>\n    x\n  </div>\n",
    "text <a\n    href=x>y</a>\n",
    "- i <a\n      href=x>y</a>\n",
    "> q <a\n>   href=x>y</a>\n",
    "a `b\n    c` d\n",
    "- a\n\n  ~~~py\n  x = 1\n  ~~~\n",
  ])("code and opaque bytes survive inside containers %j", (src) => {
    const before = collect(markdownToTree(src).children).map((n) => n.source);
    const after = collect(markdownToTree(treeToMarkdown(markdownToTree(src))).children).map((n) => n.source);
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });

  test("container round trip", () => {
    const t = markdownToTree(":::tip[Title]\nText\n:::\n");
    const md = treeToMarkdown(t);
    expect(md).toContain(":::tip[Title]");
    expect(markdownToTree(md)).toEqual(t);
  });

  test("mdx mode preserved", () => {
    const t = markdownToTree('Hi <Badge text="x" /> there\n', { mode: "mdx" });
    expect(collect(t.children).some((n) => n.type === "opaqueInline")).toBe(true);
    const md = treeToMarkdown(t);
    expect(markdownToTree(md, { mode: "mdx" })).toEqual(t);
  });

  test("rejects an invalid tree", () => {
    const valid = markdownToTree("x\n");
    expect(() => treeToMarkdown({ ...valid, version: 2 } as never)).toThrow(ValidationError);
  });
});
