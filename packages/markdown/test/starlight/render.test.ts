import { describe, expect, test } from "vitest";
import { parseFrontmatter } from "@astrojs/internal-helpers/frontmatter";
import { normalizeValue } from "@mogging/core";
import { markdownToTree } from "../../src/parse.js";
import { readStarlightFile, splitPage } from "../../src/starlight/frontMatter.js";
import { rebaseTree, rebaseValueAt } from "../../src/starlight/rebase.js";
import { renderLocaleFile } from "../../src/starlight/render.js";
import { docs, layout } from "./fixtures.js";

const EN_PATH = "src/content/docs/a.md";
const DE_PATH = "src/content/docs/de/a.md";

/** Renders a German file from English front matter `fm` and the German localized values. */
function render(fm: string | null, localized: Record<string, unknown>, enBody = "") {
  const english = readStarlightFile(fm === null ? enBody : `---\n${fm}\n---\n${enBody}`);
  return renderLocaleFile({ layout, col: docs, english, englishPath: EN_PATH, localePath: DE_PATH, localized });
}

/** What Astro reads from `text`. */
const astro = (text: string): Record<string, unknown> => parseFrontmatter(text).frontmatter as Record<string, unknown>;

describe("renderLocaleFile", () => {
  test("follows-English keys are English's bytes", () => {
    const fm = [
      "title: Hello",
      "lastUpdated: 2024-01-01",
      'publishedAt: "2024-02-02"',
      "# a comment line",
      "tags: [a, b]",
      "sidebar: { order: 3, label: Intro }",
    ].join("\n");
    const { text, errors } = render(fm, { title: "Hallo", sidebarLabel: "Einführung" });
    expect(errors).toEqual([]);
    const en = astro(`---\n${fm}\n---\n`);
    const de = astro(text);
    expect(de.lastUpdated).toBeInstanceOf(Date);
    expect(de.lastUpdated).toEqual(en.lastUpdated);
    expect(de.publishedAt).toBe("2024-02-02");
    expect(de.tags).toEqual(["a", "b"]);
    expect((de.sidebar as Record<string, unknown>).order).toBe(3);
    expect(de.title).toBe("Hallo");
    expect((de.sidebar as Record<string, unknown>).label).toBe("Einführung");
    expect(Object.keys(de)).toEqual(Object.keys(en));
    expect(Object.keys(de.sidebar as object)).toEqual(["order", "label"]);
    expect(text).toContain("# a comment line\n");
    expect(text).toContain('publishedAt: "2024-02-02"');
    expect(text).toContain("tags: [ a, b ]");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text.endsWith("---\n")).toBe(true);
  });

  test("a long flow sequence is not refolded", () => {
    const items = Array.from({ length: 40 }, (_, i) => `item-number-${i}`).join(", ");
    const { text } = render(`title: T\ntags: [${items}]`, { title: "T" });
    expect(text.split("\n").filter((l) => l.startsWith("tags:"))).toHaveLength(1);
    expect(astro(text).tags).toHaveLength(40);
  });

  test("merged keys never leak", () => {
    const fm = "title: Hello\nbase: &b { description: English }\n<<: *b";
    expect(astro(`---\n${fm}\n---\n`).description).toBe("English");
    const { text, errors, warnings } = render(fm, { title: "Hallo" });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    const de = astro(text);
    expect(de.description).toBeUndefined();
    expect(de.title).toBe("Hallo");
    expect(de.base).toEqual({ description: "English" });
  });

  test("an alias is resolved and keeps its value type", () => {
    const { text, warnings } = render("title: T\nd: &d 2024-01-01\ne: *d", { title: "T" });
    expect(warnings).toHaveLength(1);
    const de = astro(text);
    expect(de.d).toBeInstanceOf(Date);
    expect(de.e).toEqual(de.d);
    expect(text).not.toContain("*");
  });

  test("a merged object shared by two keys is written twice, never aliased", () => {
    const { text } = render("title: T\nbase: &b { x: { y: 1 } }\nm:\n  <<: *b", { title: "T" });
    expect(text).not.toMatch(/[&*]/);
    expect(astro(text).m).toEqual({ x: { y: 1 } });
  });

  test("a document without aliases has no warning", () => {
    expect(render("title: T", { title: "T" }).warnings).toEqual([]);
  });

  test("a date-like localized string is quoted", () => {
    const { text } = render("title: Hello", { title: "2024-01-01" });
    expect(text).toContain('title: "2024-01-01"');
    expect(astro(text).title).toBe("2024-01-01");
  });

  test("a localized key English lacks is appended after English's keys; an absent one is removed", () => {
    const { text } = render("title: Hello\ndescription: Eng\nz: 1", { title: "Hallo", sidebarLabel: "Intro" });
    const de = astro(text);
    expect(Object.keys(de)).toEqual(["title", "z", "sidebar"]);
    expect(de.sidebar).toEqual({ label: "Intro" });
  });

  test("removing the last key of a mapping removes the mapping", () => {
    const { text } = render("title: Hello\nsidebar:\n  label: Intro", { title: "Hallo" });
    expect(astro(text)).toEqual({ title: "Hallo" });
    expect(text).not.toContain("sidebar");
  });

  test("a leading comment of a replaced key stays", () => {
    const { text } = render("# about the title\ntitle: Hello", { title: "Hallo" });
    expect(text).toBe("---\n# about the title\ntitle: Hallo\n---\n");
  });

  test("an English mapping in the way of a locale path is an error", () => {
    const { errors } = render("title: T\nsidebar: 5", { title: "T", sidebarLabel: "Intro" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/sidebar\.label.*non-mapping.*"sidebar"/);
  });

  test("no front matter block when the document is empty", () => {
    expect(render(null, {}).text).toBe("");
    expect(render("title: Hello", {}).text).toBe("");
  });

  test("an English file without front matter gets one when the locale has values", () => {
    const { text } = render(null, { title: "Hallo" });
    expect(text).toBe("---\ntitle: Hallo\n---\n");
  });

  describe("union rule", () => {
    const prev = (fm: string, value: unknown) => {
      const r = render(`title: T${fm === "" ? "" : `\n${fm}`}`, { title: "T", ...(value === undefined ? {} : { prev: value }) });
      expect(r.errors).toEqual([]);
      return astro(r.text);
    };
    test("English false stays false", () => {
      expect(prev("prev: false", { label: "Zurück" }).prev).toBe(false);
    });
    test("English string takes the locale's label as a string", () => {
      expect(prev('prev: "Back"', { label: "Zurück" }).prev).toBe("Zurück");
    });
    test("English absent takes the locale's object", () => {
      expect(prev("", { label: "Zurück", link: "/de/a" }).prev).toEqual({ label: "Zurück", link: "/de/a" });
    });
    test("English true and no locale value leaves no key", () => {
      expect(Object.hasOwn(prev("prev: true", undefined), "prev")).toBe(false);
    });
    test("English false and no locale value stays false", () => {
      expect(prev("prev: false", undefined).prev).toBe(false);
    });
    test("English object and no locale value leaves no key", () => {
      expect(Object.hasOwn(prev("prev:\n  label: Back", undefined), "prev")).toBe(false);
    });
    test("an object of only the stringAs key is written as a string, in a union and in a plain entry", () => {
      const r = render("title: T", { title: "T", sidebarBadge: { text: "Neu" } });
      expect(astro(r.text).sidebar).toEqual({ badge: "Neu" });
      const r2 = render("title: T", { title: "T", sidebarBadge: { text: "Neu", variant: "tip" } });
      expect(astro(r2.text).sidebar).toEqual({ badge: { text: "Neu", variant: "tip" } });
    });
  });

  test("an orphaned per-locale value is written", () => {
    const { text } = render("title: T", { title: "T", banner: { content: "Nur hier" } });
    expect(astro(text).banner).toEqual({ content: "Nur hier" });
  });

  test("file references are rebased", () => {
    const { text } = render("title: T", { title: "T", hero: { title: "H", image: { file: "../../assets/h.webp" } } });
    expect((astro(text).hero as { image: { file: string } }).image.file).toBe("../../../assets/h.webp");
  });

  test("the body's images are rebased and written after the front matter", () => {
    const body = markdownToTree("Hi ![a](./img.png)\n", { mode: "md" });
    const { text, errors } = render("title: T", { title: "T", body });
    expect(errors).toEqual([]);
    expect(text).toBe("---\ntitle: T\n---\nHi ![a](../img.png)\n");
  });

  test("an empty body tree leaves an empty body", () => {
    const { text } = render("title: T", { title: "T", body: { type: "root", mode: "md", children: [] } });
    expect(text).toBe("---\ntitle: T\n---\n");
  });

  test("an unparseable mdxjsEsm block is an error", () => {
    const body = markdownToTree("import A from './a.js'\n\nText\n", { mode: "mdx" });
    const bad = structuredClone(body);
    const esm = bad.children.find((b) => b.type === "opaqueBlock" && b.node === "mdxjsEsm");
    if (esm?.type !== "opaqueBlock") throw new Error("fixture: no ESM block");
    esm.source = "import {";
    const { errors } = render("title: T", { title: "T", body: bad });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/mdxjsEsm/);
  });

  test("round trip", () => {
    const fm = [
      "title: Hello", "description: Eng", "lastUpdated: 2024-01-01", "template: splash",
      "prev: true", "next: false", "sidebar:", "  order: 3", "  label: Intro",
    ].join("\n");
    const english = readStarlightFile(`---\n${fm}\n---\nHello\n`);
    const german: Record<string, unknown> = {
      title: "Hallo", description: "Deutsch", sidebarLabel: "Einführung", sidebarBadge: { text: "Neu" },
      prev: { label: "Zurück", link: "/de/a" }, next: { label: "Weiter" },
      hero: { title: "H", tagline: "T", image: { alt: "A", file: "../../assets/h.webp" },
              actions: [{ text: "Go", link: "/de/b", variant: "primary" }] },
      banner: { content: "Nur hier" },
      body: markdownToTree("Hallo ![a](./img.png)\n\n- eins\n- zwei\n", { mode: "md" }),
    };
    for (const [k, v] of Object.entries(german)) {
      if (k !== "body") german[k] = normalizeValue(docs.fields[k]!, v, k);
    }
    const { text, errors } = renderLocaleFile({
      layout, col: docs, english, englishPath: EN_PATH, localePath: DE_PATH, localized: german,
    });
    expect(errors).toEqual([]);

    const back = splitPage(layout, docs, readStarlightFile(text), "md");
    const enSplit = splitPage(layout, docs, english, "md");
    // Read back and rebased to the English file, the values are the German ones; English's `next: false` kept no value.
    const reread = structuredClone(back.localized);
    reread.hero = rebaseValueAt(reread.hero, ["image", "file"], DE_PATH, EN_PATH);
    reread.body = rebaseTree(reread.body as never, DE_PATH, EN_PATH).tree;
    const expected = structuredClone(german);
    delete expected.next;
    expect(reread).toEqual(expected);

    const falsy = (t: Record<string, boolean>) => Object.fromEntries(Object.entries(t).filter(([, v]) => !v));
    expect(falsy(back.toggles)).toEqual(falsy(enSplit.toggles));
    const { prevToggle: _true, ...sharedWithoutTrue } = enSplit.shared;
    expect(back.shared).toEqual(sharedWithoutTrue);
    expect(back.remainder).toEqual(enSplit.remainder);
  });
});
