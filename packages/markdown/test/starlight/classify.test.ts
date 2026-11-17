import { describe, expect, test } from "vitest";
import { markdownToTree } from "../../src/parse.js";
import { classifyEarlier, classifyHeads, sameLocalized } from "../../src/starlight/classify.js";
import type { FileClass } from "../../src/starlight/classify.js";
import { docs, layout } from "./fixtures.js";

type Rec = Record<string, unknown>;

/** The full three-step classification a caller runs for one file. */
function classify(file: Rec, published: Rec | null, draft: Rec | null, earlier: Rec[]): FileClass {
  return classifyHeads(layout, docs, file, { published, draft }) ?? classifyEarlier(layout, docs, file, earlier);
}

const v = (title: string, extra: Rec = {}): Rec => ({ title, ...extra });

describe("classification precedence", () => {
  test("equal to the published head is published", () => {
    expect(classify(v("A"), v("A"), v("B"), [v("C")])).toBe("published");
  });
  test("equal to the draft head is pending", () => {
    expect(classify(v("B"), v("A"), v("B"), [v("C")])).toBe("pending");
  });
  test("equal to an earlier version is behind", () => {
    expect(classify(v("C"), v("A"), v("B"), [v("D"), v("C")])).toBe("behind");
  });
  test("anything else is hand work, also with no heads and no history", () => {
    expect(classify(v("Z"), v("A"), v("B"), [v("C")])).toBe("hand work");
    expect(classify(v("Z"), null, null, [])).toBe("hand work");
  });
  test("a file equal to both the draft head and an earlier version is pending", () => {
    expect(classify(v("B"), v("A"), v("B"), [v("B")])).toBe("pending");
    expect(classifyHeads(layout, docs, v("B"), { published: v("A"), draft: v("B") })).toBe("pending");
  });
  test("classifyHeads returns null for a divergent file", () => {
    expect(classifyHeads(layout, docs, v("Z"), { published: v("A"), draft: null })).toBeNull();
  });
});

describe("the suppressible union value (R9-1 / R10-1)", () => {
  const withPrev = v("A", { prev: { label: "Zurueck" } });

  test("a file without prev against a head with prev is published", () => {
    expect(classify(v("A"), withPrev, null, [])).toBe("published");
  });
  test("it is still published after English re-enables the link (the head is unchanged)", () => {
    expect(sameLocalized(layout, docs, v("A"), withPrev)).toBe(true);
    expect(classifyHeads(layout, docs, v("A"), { published: withPrev, draft: null })).toBe("published");
  });
  test("prev: {} in the file equals absent", () => {
    expect(classify(v("A", { prev: {} }), withPrev, null, [])).toBe("published");
    expect(sameLocalized(layout, docs, v("A", { prev: {} }), v("A"))).toBe(true);
  });
  test("a file whose prev differs from the head is hand work", () => {
    expect(classify(v("A", { prev: { label: "Anders" } }), withPrev, null, [])).toBe("hand work");
  });
  test("a file with prev against a head without it differs", () => {
    expect(sameLocalized(layout, docs, withPrev, v("A"))).toBe(false);
  });
  test("a different title is hand work even when prev is dropped", () => {
    expect(classify(v("B"), withPrev, null, [])).toBe("hand work");
  });
  test("the rule applies to earlier versions and the draft head too", () => {
    expect(classify(v("A"), v("Z"), withPrev, [])).toBe("pending");
    expect(classify(v("A"), v("Z"), v("Y"), [withPrev])).toBe("behind");
  });
  test("next is a union value as well, and a non-union object is compared", () => {
    expect(sameLocalized(layout, docs, v("A"), v("A", { next: { label: "Weiter" } }))).toBe(true);
    expect(sameLocalized(layout, docs, v("A"), v("A", { banner: { content: "x" } }))).toBe(false);
    expect(sameLocalized(layout, docs, v("A", { banner: {} }), v("A"))).toBe(false);
  });
});

describe("the richText root mode follows the file extension", () => {
  test("the same body stored as an md tree and read from an .mdx file is published", () => {
    const stored = { ...v("A"), body: markdownToTree("Hello **world**\n", { mode: "md" }) };
    const fromMdx = { ...v("A"), body: markdownToTree("Hello **world**\n", { mode: "mdx" }) };
    expect((fromMdx.body as { mode: string }).mode).toBe("mdx");
    expect(classify(fromMdx, stored, null, [])).toBe("published");
  });
  test("a different body is still different", () => {
    const stored = { ...v("A"), body: markdownToTree("Hello\n", { mode: "md" }) };
    const other = { ...v("A"), body: markdownToTree("Bye\n", { mode: "mdx" }) };
    expect(classify(other, stored, null, [])).toBe("hand work");
  });
  test("a non-richText field named like a root is left alone, and nulls and strings do not throw", () => {
    expect(sameLocalized(layout, docs, v("A", { body: null }), v("A", { body: null }))).toBe(true);
    expect(sameLocalized(layout, docs, v("A", { body: "x" }), v("A", { body: "y" }))).toBe(false);
  });
});

describe("purity", () => {
  test("neither record is mutated", () => {
    const body = markdownToTree("Hi\n", { mode: "mdx" });
    const file = { ...v("A", { prev: {} }), body };
    const version = { ...v("A", { prev: { label: "L" } }), body: markdownToTree("Hi\n", { mode: "md" }) };
    const before = JSON.stringify([file, version]);
    sameLocalized(layout, docs, file, version);
    expect(JSON.stringify([file, version])).toBe(before);
    expect(body.mode).toBe("mdx");
  });
  test("key order never matters (canonical hash)", () => {
    expect(sameLocalized(layout, docs, { title: "A", description: "d" }, { description: "d", title: "A" })).toBe(true);
  });
});
