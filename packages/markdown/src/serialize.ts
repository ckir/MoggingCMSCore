import { toMarkdown } from "mdast-util-to-markdown";
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

/** Portable rich-text tree to Markdown (or MDX source). Validates first. Idempotent through markdownToTree. */
export function treeToMarkdown(root: RichTextRoot): string {
  validateTree(root);
  const mdast = { type: "root", children: blocks(root.children) } as Root;
  return toMarkdown(mdast, { extensions: [gfmToMarkdown(), directiveToMarkdown()] });
}
