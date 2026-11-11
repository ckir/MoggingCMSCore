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
