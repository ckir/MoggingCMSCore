import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ValidationError } from "@mogging/core";
import { markdownToTree, restoreDraft, sentinelize, validateTree } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "corpus");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");

const SRC = "Use `x` and [docs](https://a.example) for {name}.\n\n```js\nq\n```\n";
const prep = () => sentinelize(markdownToTree(SRC));
const codesOf = (r: ReturnType<typeof restoreDraft>) => (r.ok ? [] : r.codes);

describe("identity translation", () => {
  test.each([
    "- a\n  ```js\n  x\n  ```\n- b\n",
    "- a\n  <div>\n  x\n  </div>\n- b\n",
  ])("identity keeps tight list items with a block original %j", (src) => {
    const p = sentinelize(markdownToTree(src));
    const r = restoreDraft(p, p.markdown);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.root).toEqual(p.source);
  });

  test("identity ok on an mdx source with escaped braces", () => {
    const p = sentinelize(markdownToTree("a \\{x\\} b and `c`\n", { mode: "mdx" }));
    const r = restoreDraft(p, p.markdown);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.root).toEqual(p.source);
  });
});

describe("sentinelize", () => {
  test("numbering and kinds", () => {
    const p = sentinelize(markdownToTree("Run `a` then:\n\n```sh\nb\n```\n"));
    expect(p.originals).toMatchObject([{ index: 0, kind: "inline" }, { index: 1, kind: "block" }]);
    expect(p.markdown).toContain("⟦MOGGING:0⟧");
    expect(p.markdown).toContain("⟦MOGGING:1⟧");
  });

  test("throws on a pre-existing sentinel", () => {
    expect(() => sentinelize(markdownToTree("text ⟦MOGGING:0⟧"))).toThrow(ValidationError);
  });

  test("prose word MOGGING is fine", () => {
    const p = sentinelize(markdownToTree("MOGGING rocks\n\n```js\nq\n```\n"));
    expect(restoreDraft(p, p.markdown)).toMatchObject({ ok: true });
  });
});

describe("restoreDraft", () => {
  test("identity translation accepted on every corpus page", () => {
    expect(files.length).toBe(20);
    for (const f of files) {
      const p = sentinelize(markdownToTree(fs.readFileSync(path.join(dir, f), "utf8")));
      const r = restoreDraft(p, p.markdown);
      expect(r.ok, `${f}: ${r.ok ? "" : r.codes.join(",") + " " + r.detail}`).toBe(true);
      if (r.ok) {
        expect(r.root, f).toEqual(p.source);
        expect(() => validateTree(r.root)).not.toThrow();
      }
    }
  });

  test("SENTINEL_ALTERED with SENTINEL_MISSING", () => {
    const p = prep();
    expect(p.markdown).toContain("⟦MOGGING:0⟧");
    expect(codesOf(restoreDraft(p, p.markdown.replace("⟦MOGGING:0⟧", "⟦MOGGING:0⟦")))).toEqual(["SENTINEL_ALTERED", "SENTINEL_MISSING"]);
  });

  test("SENTINEL_DUPLICATED", () => {
    const p = prep();
    const draft = p.markdown.replace("\n", " ⟦MOGGING:0⟧\n");
    expect(codesOf(restoreDraft(p, draft))).toEqual(["SENTINEL_DUPLICATED"]);
  });

  test("SENTINEL_MISSING", () => {
    const p = prep();
    expect(codesOf(restoreDraft(p, p.markdown.replace("⟦MOGGING:1⟧", "")))).toEqual(["SENTINEL_MISSING"]);
  });

  test("SENTINEL_ALTERED for a block sentinel moved inline", () => {
    const p = prep();
    const draft = p.markdown.replace("\n\n⟦MOGGING:1⟧", " ⟦MOGGING:1⟧");
    expect(draft).not.toBe(p.markdown);
    expect(codesOf(restoreDraft(p, draft))).toEqual(["SENTINEL_ALTERED"]);
  });

  test("BLOCK_SEQUENCE", () => {
    const p = prep();
    expect(codesOf(restoreDraft(p, p.markdown.replace("docs", "`docs`")))).toEqual(["BLOCK_SEQUENCE"]);
  });

  test("LINK_TARGETS", () => {
    const p = prep();
    expect(codesOf(restoreDraft(p, p.markdown.replace("https://a.example", "https://de.example")))).toEqual(["LINK_TARGETS"]);
  });

  test("PLACEHOLDER", () => {
    const p = prep();
    expect(p.markdown).toContain("{name}");
    expect(codesOf(restoreDraft(p, p.markdown.replace("{name}", "{Name}")))).toEqual(["PLACEHOLDER"]);
  });

  test("PARSE_ERROR", () => {
    const p = sentinelize(markdownToTree("Hi <Badge /> there.\n", { mode: "mdx" }));
    expect(p.markdown).toContain("⟦MOGGING:0⟧");
    expect(codesOf(restoreDraft(p, p.markdown.replace("⟦MOGGING:0⟧", "<Badge")))).toEqual(["PARSE_ERROR"]);
  });

  test("codes are ordered and unique", () => {
    const p = prep();
    const draft = p.markdown.replace("⟦MOGGING:1⟧", "").replace("{name}", "{Name}");
    expect(codesOf(restoreDraft(p, draft))).toEqual(["SENTINEL_MISSING", "PLACEHOLDER"]);
  });

  test("translated prose accepted", () => {
    const p = prep();
    const r = restoreDraft(p, p.markdown.replace("Use", "Verwende").replace("for", "für"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const para = r.root.children[0] as { children: Array<{ type: string; source?: string }> };
      expect(para.children.find((c) => c.type === "inlineCode")?.source).toBe("`x`");
    }
  });

  test("container label and body are translatable", () => {
    const p = sentinelize(markdownToTree(":::tip[Title]\nBody `c`.\n:::\n"));
    expect(restoreDraft(p, p.markdown.replace("Title", "Titel").replace("Body", "Inhalt")).ok).toBe(true);
    expect(codesOf(restoreDraft(p, p.markdown.replace(":::tip", ":::tipp")))).toEqual(["BLOCK_SEQUENCE"]);
  });
});

describe("restoreDraft hardening", () => {
  const mk = (src: string) => sentinelize(markdownToTree(src));
  const run = (src: string, edit: (md: string) => string) => {
    const p = mk(src);
    const draft = edit(p.markdown);
    expect(draft).not.toBe(p.markdown);
    return restoreDraft(p, draft);
  };

  test("code block moved out of a list item", () => {
    expect(codesOf(run("* item\n\n  ```js\n  q\n  ```\n", (m) => m.replace(/\n\n\s+⟦MOGGING:0⟧/, "\n\n⟦MOGGING:0⟧")))).toEqual(["BLOCK_SEQUENCE"]);
  });

  test("code block moved out of a blockquote", () => {
    expect(codesOf(run("> quote\n>\n> ```js\n> q\n> ```\n", (m) => m.replace(/\n> ⟦MOGGING:0⟧/, "\n\n⟦MOGGING:0⟧")))).toEqual(["BLOCK_SEQUENCE"]);
  });

  test("two code blocks swapped", () => {
    expect(codesOf(run("```js\na\n```\n\n```js\nb\n```\n", (m) => m.replace("⟦MOGGING:0⟧", "@@").replace("⟦MOGGING:1⟧", "⟦MOGGING:0⟧").replace("@@", "⟦MOGGING:1⟧")))).toEqual(["BLOCK_SEQUENCE"]);
  });

  test("ordered list start changed", () => {
    expect(codesOf(run("3. a\n4. b\n", (m) => m.replace("3.", "1.")))).toEqual(["BLOCK_SEQUENCE"]);
  });

  test("task checkbox flipped", () => {
    expect(codesOf(run("* [ ] a\n* [x] b\n", (m) => m.replace("[ ]", "[x]")))).toEqual(["BLOCK_SEQUENCE"]);
  });

  test("image turned into a link", () => {
    expect(codesOf(run("See ![b](u) now\n", (m) => m.replace("![b](u)", "[b](u)")))).toEqual(["LINK_TARGETS"]);
  });

  test("sentinelize throws on a sentinel-like container attribute", () => {
    expect(() => mk(':::tip{title="MOGGING:1"}\nBody\n:::\n')).toThrow(ValidationError);
  });

  test.each([
    ["heading", (m: string) => m.replace("\n\n⟦MOGGING:1⟧", "\n\n# ⟦MOGGING:1⟧")],
    ["emphasis", (m: string) => m.replace("\n\n⟦MOGGING:1⟧", "\n\n*⟦MOGGING:1⟧*")],
    ["table cell", (m: string) => m.replace("\n\n⟦MOGGING:1⟧", "\n\n| a |\n|---|\n| ⟦MOGGING:1⟧ |")],
  ])("block sentinel moved into a %s", (_n, edit) => {
    expect(codesOf(run("Use `x`.\n\n```js\nq\n```\n", edit))).toEqual(["SENTINEL_ALTERED"]);
  });

  test("invented index", () => {
    expect(codesOf(run("Use `x`.\n", (m) => m + "\n⟦MOGGING:9⟧\n"))).toEqual(["SENTINEL_ALTERED"]);
  });

  test("identity on a non-corpus source with nested structures", () => {
    const src = [
      "* outer", "", "  * inner", "", "    ```js", "    q", "    ```", "",
      "| a | `b` |", "|---|:-:|", "| `c` | d |", "",
      "## Head `code`", "",
      ':::tip[Label `l`]{title="T" id="i"}', "Body `c`.", ":::", "",
      "* [ ] todo", "* [x] done", "",
      "3. three", "4. four", "",
    ].join("\n");
    const p = mk(src);
    const r = restoreDraft(p, p.markdown);
    expect(r.ok, r.ok ? "" : `${r.codes.join(",")} ${r.detail}`).toBe(true);
    if (r.ok) expect(r.root).toEqual(p.source);
  });
});


describe("signature rejects structural tampering", () => {
  const codes = (src: string, edit: (md: string) => string) => {
    const p = sentinelize(markdownToTree(src));
    expect(restoreDraft(p, p.markdown).ok).toBe(true);
    const draft = edit(p.markdown);
    expect(draft).not.toBe(p.markdown);
    return codesOf(restoreDraft(p, draft));
  };

  test("a changed table column alignment is rejected", () => {
    const src = "| a | b |\n| :- | -: |\n| x | y |\n";
    expect(codes(src, (m) => m.replace("| :- | -: |", "| -: | :- |"))).toEqual(["BLOCK_SEQUENCE"]);
    expect(codes(src, (m) => m.replace("| :- | -: |", "| -- | -: |"))).toEqual(["BLOCK_SEQUENCE"]);
  });

  test("a changed or dropped container attribute is rejected", () => {
    const src = ':::tip{title="T" id="i"}\nBody\n:::\n';
    expect(codes(src, (m) => m.replace('title="T"', 'title="U"'))).toEqual(["BLOCK_SEQUENCE"]);
    expect(codes(src, (m) => m.replace(' title="T"', ""))).toEqual(["BLOCK_SEQUENCE"]);
    expect(codes(src, (m) => m.replace("{#i ", "{#j "))).toEqual(["BLOCK_SEQUENCE"]);
  });
});
