import { describe, expect, test } from "vitest";
import { markdownToTree } from "../../src/parse.js";
import { rebaseSource, rebaseSpecifier, rebaseTree, rebaseValueAt } from "../../src/starlight/rebase.js";
import type { Block, Inline, RichTextRoot } from "../../src/tree.js";

// Root-locale mode: the English page and its German file differ by one folder level.
const E = "src/content/docs/guides/a.mdx";
const L = "src/content/docs/de/guides/a.mdx";
// Own-folder mode: the English page lives in its own locale folder.
const EE = "src/content/docs/en/guides/a.md";
const LL = "src/content/docs/de/guides/a.md";

describe("rebaseSource: exact strings (root-locale mode, both directions)", () => {
  test.each([
    ["../../assets/h.webp", "../../../assets/h.webp"],
    ["./img.png", "../../guides/img.png"],
    ["img.png", "../../guides/img.png"],
    ["./a/../b.png?x=1#y", "../../guides/b.png?x=1#y"],
  ])("%s -> %s", (from, to) => {
    expect(rebaseSource(from, E, L)).toBe(to);
  });

  test("a bare name is canonical ./name on the English side, then rebases", () => {
    expect(rebaseSource("img.png", E, E)).toBe("./img.png");
    expect(rebaseSource(rebaseSource("img.png", E, E), E, L)).toBe("../../guides/img.png");
  });

  test.each([
    ["../../../assets/h.webp", "../../assets/h.webp"],
    ["../../guides/img.png", "./img.png"],
    ["../../guides/b.png?x=1#y", "./b.png?x=1#y"],
  ])("back from German: %s -> %s", (from, to) => {
    expect(rebaseSource(from, L, E)).toBe(to);
  });

  test.each([
    "/abs.png", "https://x/y.png", "#top", "~/x", "@assets/x", "data:image/png;base64,AA", "//cdn/x.png", "", "?x=1",
    "C:\\x.png", "mailto:a@b.c",
  ])("%j is not a relative file reference and is unchanged", (v) => {
    expect(rebaseSource(v, E, L)).toBe(v);
  });

  test("a trailing slash and a bare dot keep their meaning", () => {
    expect(rebaseSource("./dir/", E, L)).toBe("../../guides/dir/");
    expect(rebaseSource(".", E, E)).toBe("./");
  });

  test("a leading .. run beyond the project root round-trips", () => {
    const up = rebaseSource("../../../../../x.png", E, L);
    expect(up).toBe("../../../../../../x.png");
    expect(rebaseSource(up, L, E)).toBe("../../../../../x.png");
  });
});

describe("rebaseSource: own-folder mode (D11, no depth-zero shortcut)", () => {
  test("a colocated reference moves to the English folder", () => {
    expect(rebaseSource("./img.png", EE, LL)).toBe("../../en/guides/img.png");
    expect(rebaseSource("../../en/guides/img.png", LL, EE)).toBe("./img.png");
  });
  test("a reference leaving both locale folders is unchanged", () => {
    expect(rebaseSource("../../../assets/h.webp", EE, LL)).toBe("../../../assets/h.webp");
  });
});

describe("rebaseSpecifier: ESM grammar", () => {
  test.each([
    ["../../components/A.astro", "../../../components/A.astro"],
    ["./b.js", "../../guides/b.js"],
    ["./a/../b.js?raw", "../../guides/b.js?raw"],
  ])("%s -> %s", (from, to) => {
    expect(rebaseSpecifier(from, E, L)).toBe(to);
  });

  test.each(["react", "astro-embed", "/abs.js", "https://x/y.js", "node:fs", "@scope/pkg", "~/x", "b.js", "."])(
    "%j is not relative in ESM and is unchanged",
    (v) => {
      expect(rebaseSpecifier(v, E, L)).toBe(v);
    },
  );
});

/** A generated sample: depth 0 to 4 of `../`, optional `./` or bare start, `?`/`#` suffixes. */
function samples(): string[] {
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };
  const names = ["a", "img.png", "x/y", "deep/er/z.webp", "q/../r"];
  const suffixes = ["", "", "?x=1", "#frag", "?a=b#c", "#a?b"];
  const out: string[] = [];
  while (out.length < 300) {
    const depth = rnd(5);
    const lead = depth > 0 ? "../".repeat(depth) : ["", "./"][rnd(2)]!;
    out.push(lead + names[rnd(names.length)]! + suffixes[rnd(suffixes.length)]!);
  }
  return out;
}

describe("rebaseSource: properties", () => {
  const inputs = samples();
  test("rebase there and back equals the canonical form, and canonical is idempotent", () => {
    for (const v of inputs) {
      const canon = rebaseSource(v, E, E);
      expect(rebaseSource(rebaseSource(v, E, L), L, E), v).toBe(canon);
      expect(rebaseSource(canon, E, E), v).toBe(canon);
      expect(canon.startsWith("./") || canon.startsWith("../"), v).toBe(true);
      const path = canon.split(/[?#]/)[0]!;
      const rest = path.split("/").slice(1);
      while (rest[0] === "..") rest.shift();
      expect(rest.filter((s) => s === "." || s === ".."), v).toEqual([]);
      const own = rebaseSource(rebaseSource(v, EE, LL), LL, EE);
      expect(own, v).toBe(canon);
    }
  });
  test("the samples are 300 and cover every depth", () => {
    expect(inputs).toHaveLength(300);
    for (let d = 0; d <= 4; d++) expect(inputs.some((v) => v.startsWith("../".repeat(d)) && !v.startsWith("../".repeat(d + 1)))).toBe(true);
  });
});

const tree = (md: string): RichTextRoot => markdownToTree(md, { mode: "mdx" });

/** Every image url of a tree, in document order. */
function imageUrls(root: RichTextRoot): string[] {
  const out: string[] = [];
  const inl = (list: Inline[]) => {
    for (const n of list) {
      if (n.type === "image") out.push(n.url);
      else if (n.type === "link") inl(n.children);
    }
  };
  const blk = (list: Block[]) => {
    for (const b of list) {
      if (b.type === "paragraph" || b.type === "heading") inl(b.children);
      else if (b.type === "blockquote") blk(b.children);
      else if (b.type === "list") b.children.forEach((i) => blk(i.children));
      else if (b.type === "table") b.children.forEach((r) => r.children.forEach((c) => inl(c.children)));
      else if (b.type === "container") { if (b.label) inl(b.label); blk(b.children); }
    }
  };
  blk(root.children);
  return out;
}

describe("rebaseTree: images in every container", () => {
  const md = [
    "- item ![x](./a.png)",
    "",
    "| h | i |",
    "| - | - |",
    "| ![x](./a.png) | plain |",
    "",
    "> quote ![x](./a.png)",
    "",
    "# head ![x](./a.png)",
    "",
    ":::note[label ![x](./a.png)]",
    "body ![x](./a.png)",
    ":::",
    "",
    "[![x](./a.png)](/p)",
    "",
    "![top](./a.png)",
  ].join("\n");

  test("the source tree really holds an image in each position", () => {
    expect(imageUrls(tree(md))).toEqual(Array(8).fill("./a.png"));
    const t = tree(md);
    const kinds = t.children.map((b) => b.type);
    expect(kinds).toEqual(expect.arrayContaining(["list", "table", "blockquote", "heading", "container", "paragraph"]));
    const container = t.children.find((b) => b.type === "container");
    expect(container && container.type === "container" && container.label).toBeTruthy();
  });

  test("English to German and back, each url exact; the input is not mutated", () => {
    const src = tree(md);
    const before = JSON.stringify(src);
    const there = rebaseTree(src, E, L);
    expect(there.errors).toEqual([]);
    expect(imageUrls(there.tree)).toEqual(Array(8).fill("../../guides/a.png"));
    expect(JSON.stringify(src)).toBe(before);
    expect(there.tree).not.toBe(src);
    const back = rebaseTree(there.tree, L, E);
    expect(imageUrls(back.tree)).toEqual(Array(8).fill("./a.png"));
    expect(back.tree).toEqual(src);
  });

  test("a link target is never rewritten; the image inside it is", () => {
    const out = rebaseTree(tree("[![x](./a.png)](../guide/)\n\n[y](../guide/)"), E, L).tree;
    const [p1, p2] = out.children;
    expect(p1).toMatchObject({ type: "paragraph", children: [{ type: "link", url: "../guide/", children: [{ type: "image", url: "../../guides/a.png" }] }] });
    expect(p2).toMatchObject({ type: "paragraph", children: [{ type: "link", url: "../guide/" }] });
  });

  test("an image inside a code block or inline code is unchanged", () => {
    const code = "```md\n![x](./a.png)\n```\n\nuse `![x](./a.png)` here";
    const src = tree(code);
    const out = rebaseTree(src, E, L);
    expect(out.errors).toEqual([]);
    expect(out.tree).toEqual(src);
  });

  test("an absolute, remote and data image is unchanged", () => {
    const md2 = "![a](/abs.png) ![b](https://x/y.png) ![c](data:image/png;base64,AA)";
    const src = tree(md2);
    expect(rebaseTree(src, E, L).tree).toEqual(src);
  });
});

describe("rebaseTree: MDX ESM blocks", () => {
  const block = (t: RichTextRoot, i = 0) => {
    const b = t.children[i]!;
    if (b.type !== "opaqueBlock") throw new Error("not an opaque block");
    return b;
  };

  test("an import specifier is rewritten and every other byte of the block is identical", () => {
    const esm = "import A from '../../components/A.astro'";
    const src = tree(`${esm}\n\n# T`);
    expect(block(src)).toMatchObject({ node: "mdxjsEsm", source: esm });
    const out = rebaseTree(src, E, L);
    expect(out.errors).toEqual([]);
    expect(block(out.tree).source).toBe("import A from '../../../components/A.astro'");
    expect(block(src).source).toBe(esm);
  });

  test("an export-from specifier is rewritten and keeps its double quotes", () => {
    const out = rebaseTree(tree('export { b } from "./b.js"'), E, L);
    expect(block(out.tree).source).toBe('export { b } from "../../guides/b.js"');
  });

  test("several declarations in one block are rewritten back to front without shifting each other", () => {
    const esm = [
      "import A from '../../components/A.astro'",
      'import   B   from   "./b.js"  ;',
      "import 'react'",
      'import x from "astro-embed"',
      "export * from './c.js'",
      "export const n = 1",
    ].join("\n");
    const out = rebaseTree(tree(esm), E, L);
    expect(out.errors).toEqual([]);
    expect(block(out.tree).source).toBe(
      [
        "import A from '../../../components/A.astro'",
        'import   B   from   "../../guides/b.js"  ;',
        "import 'react'",
        'import x from "astro-embed"',
        "export * from '../../guides/c.js'",
        "export const n = 1",
      ].join("\n"),
    );
  });

  test("a bare import and a package import are untouched", () => {
    const src = tree("import 'react'\nimport x from \"astro-embed\"");
    expect(rebaseTree(src, E, L).tree).toEqual(src);
  });

  test("the round trip restores the canonical block", () => {
    const src = tree("import A from '../../components/A.astro'\nexport { b } from \"./b.js\"");
    const back = rebaseTree(rebaseTree(src, E, L).tree, L, E);
    expect(block(back.tree).source).toBe("import A from '../../components/A.astro'\nexport { b } from \"./b.js\"");
  });

  test("own-folder mode also rewrites colocated specifiers", () => {
    const out = rebaseTree(tree('import C from "./c.astro"'), EE, LL);
    expect(block(out.tree).source).toBe('import C from "../../en/guides/c.astro"');
  });

  test("a block that does not parse is left as is and reported", () => {
    const src = tree("import A from '../../components/A.astro'");
    const broken = structuredClone(src);
    block(broken).source = "import A from '../x.astro' junk (";
    const out = rebaseTree(broken, E, L);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/mdxjsEsm/);
    expect(block(out.tree).source).toBe("import A from '../x.astro' junk (");
  });

  test("a block whose source is not ESM when re-parsed is reported", () => {
    const broken = structuredClone(tree("import A from './a.astro'"));
    block(broken).source = "# not esm";
    const out = rebaseTree(broken, E, L);
    expect(out.errors).toHaveLength(1);
    expect(block(out.tree).source).toBe("# not esm");
  });

  test("other opaque blocks are never touched", () => {
    const src = tree('<Card src="./a.png" />\n\n{/* ./a.png */}');
    expect(rebaseTree(src, E, L).tree).toEqual(src);
  });
});

describe("rebaseValueAt", () => {
  const v = { file: "./hero.png", alt: "x", other: "./o.png" };

  test("rewrites only the leaf and returns a new object", () => {
    const out = rebaseValueAt(v, ["file"], E, L);
    expect(out).toEqual({ file: "../../guides/hero.png", alt: "x", other: "./o.png" });
    expect(v.file).toBe("./hero.png");
    expect(out).not.toBe(v);
  });

  test("a nested leaf", () => {
    const nested = { image: { file: "../../assets/h.webp", alt: "a" } };
    expect(rebaseValueAt(nested, ["image", "file"], E, L)).toEqual({ image: { file: "../../../assets/h.webp", alt: "a" } });
  });

  test("an empty leaf path addresses a string value itself", () => {
    expect(rebaseValueAt("./hero.png", [], E, L)).toBe("../../guides/hero.png");
    expect(rebaseValueAt(5, [], E, L)).toBe(5);
  });

  test("a missing, inherited or non-string leaf leaves the value as it was", () => {
    expect(rebaseValueAt(v, ["nope"], E, L)).toBe(v);
    expect(rebaseValueAt(v, ["constructor"], E, L)).toBe(v);
    expect(rebaseValueAt(v, ["__proto__"], E, L)).toBe(v);
    expect(rebaseValueAt({ file: 3 }, ["file"], E, L)).toEqual({ file: 3 });
    expect(rebaseValueAt(["./a.png"], ["0"], E, L)).toEqual(["./a.png"]);
    expect(rebaseValueAt(null, ["file"], E, L)).toBeNull();
    expect(rebaseValueAt({ a: "x" }, ["a", "b"], E, L)).toEqual({ a: "x" });
  });

  test("a non-relative leaf is unchanged", () => {
    expect(rebaseValueAt({ file: "https://x/y.png" }, ["file"], E, L)).toEqual({ file: "https://x/y.png" });
  });
});
