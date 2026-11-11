import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, test } from "vitest";
import { ValidationError } from "@mogging/core";
import { markdownToTree, restoreDraft, sentinelize, treeToMarkdown } from "../src/index.js";

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

  test.each(["a**b**c", "***x***", "*a*__b__", "**a *b* c**", "~~*x*~~ y", '[**a** b](u "t")', "`x` **`y`**", "a  \nb",
    "*a.*__b__", "*`y`*__b__", "*<b>*__c__", "__a.__*b*", "~~a.~~**b**", "*a*__.b__",
    "a  \n`x`\n", "a  \n<b>x</b>\n", "a\\\n`x`\n", "*a*  \n`x`\n"])(
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

  test.each(["a \\{x\\} b\n", "a \\< b\n", "x \\{ y\n"])("mdx mode escapes braces %j", (src) => {
    const t1 = markdownToTree(src, { mode: "mdx" });
    const md1 = treeToMarkdown(t1);
    const t2 = markdownToTree(md1, { mode: "mdx" });
    expect(t2).toEqual(t1);
    expect(treeToMarkdown(t2)).toBe(md1);
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

const rt = (src: string, mode: "md" | "mdx") => {
  const t = markdownToTree(src, { mode });
  const md = treeToMarkdown(t);
  expect(markdownToTree(md, { mode })).toEqual(t);
  const p = sentinelize(t);
  expect(restoreDraft(p, p.markdown).ok).toBe(true);
};

describe("capstone r1 round trips", () => {
  it("escapes { and < in mdx container labels", () => {
    for (const x of [
      ":::tip[A \\{ b]\nx\n:::\n",
      ":::tip[A \\<b]\nx\n:::\n",
      ":::tip[*A \\{ b*]\nx\n:::\n",
      "> :::tip[A \\{ b]\n> x\n> :::\n",
      ":::tip[A \\} b]\nx\n:::\n",
    ]) rt(x, "mdx");
    for (const x of [":::tip[A { b]\nx\n:::\n", ":::tip[A <b]\nx\n:::\n"]) rt(x, "md");
  });

  it("keeps a raw inline source that starts a line inline", () => {
    for (const x of [
      "para\n    <div>foo</div>\n",
      "para\n    <!-- c -->\n",
      "a\\\n    <div>x</div>\n",
      "- item\n      <div>x</div>\n",
      "> q\n>     <div>x</div>\n",
      "para\n    ```\n    code\n    ```\n",
      "para\n    <span>x</span> y\n",
      "para\n    ```x``` y\n",
      "para\n    [^1]\n\n[^1]: n\n",
      "a `x` b\n",
      "a\\\n`x`\n",
    ]) rt(x, "md");
    for (const x of ["para\n    <div>x</div>\n", "para\n    <Foo />\n", "para\n    {1+1}\n"]) rt(x, "mdx");
  });
});
