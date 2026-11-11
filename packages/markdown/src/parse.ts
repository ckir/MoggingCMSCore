import { unified } from "unified";
import type { Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import { directive as directiveSyntax } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import type { Nodes, Root } from "mdast";
import { ValidationError } from "@mogging/core";
import { MARK_ORDER } from "./tree.js";
import type { Block, Inline, Link, ListItem, Mark, RichTextRoot, TableCell, TableRow } from "./tree.js";

/**
 * Block (container/leaf) directives only, for `:::note` admonitions. The TEXT directive (`:name`) must stay off:
 * it parses the `:3` inside the sentinel `⟦MOGGING:3⟧` as a directive and splits the sentinel.
 */
function remarkBlockDirectives(this: Processor): void {
  const data = this.data() as Record<string, unknown[]>;
  (data.micromarkExtensions ??= []).push({ flow: directiveSyntax().flow });
  (data.fromMarkdownExtensions ??= []).push(directiveFromMarkdown());
}

/** Parses already-normalized markdown to mdast (gfm, block directives, and MDX when mode is "mdx"). */
export function parseMdast(markdown: string, mode: "md" | "mdx"): Root {
  const p = unified().use(remarkParse).use(remarkGfm).use(remarkBlockDirectives);
  if (mode === "mdx") p.use(remarkMdx);
  return p.parse(markdown) as Root;
}

type AnyNode = Nodes & { position?: { start: { offset?: number; column: number }; end: { offset?: number } } };

/** Source text of a node with container prefixes (`> `, list indentation) removed from every line after the first. */
function slice(src: string, node: AnyNode, blockColumn?: number): string {
  const pos = node.position;
  if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) {
    throw new Error("internal: node without position");
  }
  const [first, ...rest] = src.slice(pos.start.offset, pos.end.offset).split("\n");
  // Inline nodes strip against their enclosing block's column; a mid-line column would eat real content.
  const max = (blockColumn ?? pos.start.column) - 1;
  const lines = rest.map((line) => {
    let i = 0;
    while (i < max && i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === ">")) i++;
    return line.slice(i);
  });
  return [first, ...lines].join("\n");
}

export function canonicalize(list: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of list) {
    if (n.type === "text") {
      if (n.value === "") continue;
      const prev = out[out.length - 1];
      if (prev && prev.type === "text" && prev.marks.join() === n.marks.join()) {
        prev.value += n.value;
        continue;
      }
    }
    out.push(n);
  }
  return out;
}

function sortMarks(marks: Iterable<Mark>): Mark[] {
  const s = new Set(marks);
  return MARK_ORDER.filter((m) => s.has(m));
}

function inlines(src: string, bc: number, children: readonly Nodes[], marks: Mark[], inLink = false): Inline[] {
  const out: Inline[] = [];
  for (const n of children) {
    switch (n.type) {
      case "text":
        out.push({ type: "text", value: n.value, marks: sortMarks(marks) });
        break;
      case "emphasis":
      case "strong":
      case "delete":
        out.push(...inlines(src, bc, n.children, [...marks, n.type], inLink));
        break;
      case "link":
        if (inLink) {
          out.push(...inlines(src, bc, n.children, marks, true)); // a link cannot contain a link: keep the text
        } else {
          out.push({
            type: "link", url: n.url, title: n.title ?? null,
            children: canonicalize(inlines(src, bc, n.children, marks, true)) as Link["children"],
          });
        }
        break;
      case "image":
        out.push({ type: "image", url: n.url, title: n.title ?? null, alt: n.alt ?? "", marks: sortMarks(marks) });
        break;
      case "break":
        out.push({ type: "break" });
        break;
      case "inlineCode":
        out.push({ type: "inlineCode", value: n.value, source: slice(src, n, bc), marks: sortMarks(marks) });
        break;
      default:
        out.push({ type: "opaqueInline", node: n.type, source: slice(src, n, bc), marks: sortMarks(marks) });
    }
  }
  return out;
}

function inlineList(src: string, block: AnyNode, children: readonly Nodes[]): Inline[] {
  const bc = block.position?.start.column;
  if (bc === undefined) throw new Error("internal: node without position");
  return canonicalize(inlines(src, bc, children, []));
}

function blocks(src: string, children: readonly Nodes[]): Block[] {
  return children.map((n): Block => {
    switch (n.type) {
      case "paragraph":
        return { type: "paragraph", children: inlineList(src, n, n.children) };
      case "heading":
        return { type: "heading", depth: n.depth, children: inlineList(src, n, n.children) };
      case "thematicBreak":
        return { type: "thematicBreak" };
      case "blockquote":
        return { type: "blockquote", children: blocks(src, n.children) };
      case "list":
        return {
          type: "list", ordered: n.ordered ?? false, start: n.start ?? null, spread: n.spread ?? false,
          children: n.children.map((it): ListItem => ({
            type: "listItem", checked: it.checked ?? null, spread: it.spread ?? false,
            children: blocks(src, it.children),
          })),
        };
      case "table":
        return {
          type: "table",
          align: (n.align ?? []).map((a) => a ?? null),
          children: n.children.map((row): TableRow => ({
            type: "tableRow",
            children: row.children.map((cell): TableCell => ({ type: "tableCell", children: inlineList(src, cell, cell.children) })),
          })),
        };
      case "code":
        return { type: "code", lang: n.lang ?? null, meta: n.meta ?? null, value: n.value, source: slice(src, n) };
      case "containerDirective": {
        const attributes: Record<string, string> = {};
        for (const [k, v] of Object.entries(n.attributes ?? {})) attributes[k] = v ?? "";
        const first = n.children[0];
        const hasLabel = first?.type === "paragraph" && first.data?.directiveLabel === true;
        const label = hasLabel ? inlineList(src, first, first.children) : [];
        return {
          type: "container", name: n.name, attributes,
          label: label.length > 0 ? label : null,
          children: blocks(src, hasLabel ? n.children.slice(1) : n.children),
        };
      }
      default:
        return { type: "opaqueBlock", node: n.type, source: slice(src, n) };
    }
  });
}

/** Markdown (or MDX) to the portable rich-text tree. The mode comes from the caller; there is no md fallback. */
export function markdownToTree(markdown: string, options?: { mode?: "md" | "mdx" }): RichTextRoot {
  const mode = options?.mode ?? "md";
  const src = markdown.replace(/\r\n?/g, "\n").normalize("NFC");
  let tree: Root;
  try {
    tree = parseMdast(src, mode);
  } catch (e) {
    if (mode === "mdx") throw new ValidationError(`invalid MDX: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  return { type: "root", version: 1, mode, children: blocks(src, tree.children) };
}
