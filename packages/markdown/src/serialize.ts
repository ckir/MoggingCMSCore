import { toMarkdown, defaultHandlers } from "mdast-util-to-markdown";
import type { Handle } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import { directiveToMarkdown } from "mdast-util-directive";
import type { PhrasingContent, RootContent, Root } from "mdast";
import { MARK_ORDER, validateTree } from "./tree.js";
import type { Block, Inline, ListItem, Mark, RichTextRoot, TableCell, TableRow } from "./tree.js";

const MARK_NODE = { delete: "delete", emphasis: "emphasis", strong: "strong" } as const;

function marksOf(n: Inline): readonly Mark[] {
  return n.type === "break" || n.type === "link" ? [] : n.marks;
}

function leaf(n: Inline): PhrasingContent {
  switch (n.type) {
    case "text": return { type: "text", value: n.value };
    case "inlineCode":
    case "opaqueInline": return { type: "html", value: n.source };
    case "image": return { type: "image", url: n.url, title: n.title, alt: n.alt };
    case "break": return { type: "break" };
    case "link":
      return { type: "link", url: n.url, title: n.title, children: wrap(n.children, new Set()) };
  }
}

/** Nests marks: see the Task 3 brief. Maximal runs of consecutive nodes sharing the first unapplied mark. */
function wrap(list: readonly Inline[], applied: ReadonlySet<Mark>): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < list.length) {
    const n = list[i]!;
    const mark = MARK_ORDER.find((m) => marksOf(n).includes(m) && !applied.has(m));
    if (!mark) { out.push(leaf(n)); i++; continue; }
    let j = i;
    while (j < list.length && marksOf(list[j]!).includes(mark)) j++;
    const next = new Set(applied).add(mark);
    out.push({ type: MARK_NODE[mark], children: wrap(list.slice(i, j), next) } as PhrasingContent);
    i = j;
  }
  return out;
}

function item(li: ListItem): RootContent {
  return { type: "listItem", checked: li.checked, spread: li.spread, children: blocks(li.children) } as RootContent;
}

function block(b: Block): RootContent {
  switch (b.type) {
    case "paragraph": return { type: "paragraph", children: wrap(b.children, new Set()) };
    case "heading": return { type: "heading", depth: b.depth, children: wrap(b.children, new Set()) };
    case "thematicBreak": return { type: "thematicBreak" };
    case "blockquote": return { type: "blockquote", children: blocks(b.children) } as RootContent;
    case "list":
      return {
        type: "list", ordered: b.ordered, start: b.start, spread: b.spread, children: b.children.map(item),
      } as RootContent;
    case "table":
      return {
        type: "table", align: b.align,
        children: b.children.map((row: TableRow) => ({
          type: "tableRow",
          children: row.children.map((cell: TableCell) => ({ type: "tableCell", children: wrap(cell.children, new Set()) })),
        })),
      } as RootContent;
    case "code":
    case "opaqueBlock": return { type: "html", value: b.source };
    case "container": {
      const children: RootContent[] = blocks(b.children);
      if (b.label) {
        children.unshift({ type: "paragraph", data: { directiveLabel: true }, children: wrap(b.label, new Set()) });
      }
      return { type: "containerDirective", name: b.name, attributes: { ...b.attributes }, children } as unknown as RootContent;
    }
  }
}

function blocks(list: readonly Block[]): any[] {
  return list.map(block);
}

type Attn = { type: string };
const isAttn = (n: Attn | undefined): boolean => n?.type === "emphasis" || n?.type === "strong";
const WORD = /[\p{L}\p{N}]/u;

/**
 * Adjacent emphasis/strong siblings must use different marker characters. With one character the closing run of
 * the first and the opening run of the second merge into one delimiter run (e.g. `*a.***b**`), which flanks the
 * wrong way and reparses as literal stars. `_` is only allowed where it is not intraword.
 */
function markers(parent: { children: any[] }): Map<unknown, "*" | "_"> {
  const out = new Map<unknown, "*" | "_">();
  const kids = parent.children;
  const underscoreOk = (i: number): boolean => {
    const prev = kids[i - 1], next = kids[i + 1];
    if (prev?.type === "text" && WORD.test(Array.from(prev.value as string).pop() ?? "")) return false;
    if (next?.type === "text" && WORD.test(Array.from(next.value as string)[0] ?? "")) return false;
    return true;
  };
  let i = 0;
  while (i < kids.length) {
    if (!isAttn(kids[i])) { i++; continue; }
    let j = i;
    while (j < kids.length && isAttn(kids[j])) j++;
    const chainOk = (first: "*" | "_") => kids.slice(i, j).every((_, k) => (k % 2 === 0 ? first : first === "*" ? "_" : "*") === "*" || underscoreOk(i + k));
    const first: "*" | "_" = chainOk("*") || !chainOk("_") ? "*" : "_";
    for (let k = i; k < j; k++) out.set(kids[k], (k - i) % 2 === 0 ? first : first === "*" ? "_" : "*");
    i = j;
  }
  return out;
}

const cache = new WeakMap<object, Map<unknown, "*" | "_">>();
function markerOf(node: unknown, parent: any): "*" | "_" {
  if (!parent) return "*";
  let m = cache.get(parent);
  if (!m) { m = markers(parent); cache.set(parent, m); }
  return m.get(node) ?? "*";
}

function attention(kind: "emphasis" | "strong"): Handle {
  const base = defaultHandlers[kind] as Handle;
  const h: Handle = (node, parent, state, info) => {
    const saved = state.options[kind];
    state.options[kind] = markerOf(node, parent);
    try { return base(node, parent, state, info); } finally { state.options[kind] = saved; }
  };
  (h as any).peek = (node: unknown, parent: unknown) => markerOf(node, parent);
  return h;
}

/** Portable rich-text tree to Markdown (or MDX source). Validates first. Idempotent through markdownToTree. */
export function treeToMarkdown(root: RichTextRoot): string {
  validateTree(root);
  const mdast = { type: "root", children: blocks(root.children) } as Root;
  return toMarkdown(mdast, {
    extensions: [gfmToMarkdown(), directiveToMarkdown()],
    handlers: { emphasis: attention("emphasis"), strong: attention("strong") },
  });
}
