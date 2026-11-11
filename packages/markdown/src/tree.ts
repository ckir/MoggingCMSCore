import { ValidationError } from "@mogging/core";

export type Mark = "delete" | "emphasis" | "strong";          // canonical order = this (alphabetical) order
export const MARK_ORDER: readonly Mark[] = ["delete", "emphasis", "strong"];

export type Text = { type: "text"; value: string; marks: Mark[] };
export type InlineCode = { type: "inlineCode"; value: string; source: string; marks: Mark[] };
export type OpaqueInline = { type: "opaqueInline"; node: string; source: string; marks: Mark[] };
export type Image = { type: "image"; url: string; title: string | null; alt: string; marks: Mark[] };
export type Break = { type: "break" };
export type Link = { type: "link"; url: string; title: string | null; children: Array<Text | InlineCode | OpaqueInline | Image | Break> };
export type Inline = Text | InlineCode | OpaqueInline | Image | Break | Link;

export type Paragraph = { type: "paragraph"; children: Inline[] };
export type Heading = { type: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] };
export type ThematicBreak = { type: "thematicBreak" };
export type Blockquote = { type: "blockquote"; children: Block[] };
export type ListItem = { type: "listItem"; checked: boolean | null; spread: boolean; children: Block[] };
export type List = { type: "list"; ordered: boolean; start: number | null; spread: boolean; children: ListItem[] };
export type TableCell = { type: "tableCell"; children: Inline[] };
export type TableRow = { type: "tableRow"; children: TableCell[] };
export type Table = { type: "table"; align: Array<"left" | "right" | "center" | null>; children: TableRow[] };
export type Code = { type: "code"; lang: string | null; meta: string | null; value: string; source: string };
export type Container = { type: "container"; name: string; attributes: Record<string, string>; label: Inline[] | null; children: Block[] };
export type OpaqueBlock = { type: "opaqueBlock"; node: string; source: string };
export type Block = Paragraph | Heading | ThematicBreak | Blockquote | List | Table | Code | Container | OpaqueBlock;

export type RichTextRoot = { type: "root"; version: 1; mode: "md" | "mdx"; children: Block[] };

type Obj = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new ValidationError(`${path}: ${msg}`);
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exactKeys(o: Obj, keys: readonly string[], path: string): void {
  for (const k of keys) if (!Object.hasOwn(o, k)) fail(path, `missing key "${k}"`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(path, `unexpected key "${k}"`);
}

function str(o: Obj, k: string, path: string): void {
  if (typeof o[k] !== "string") fail(`${path}.${k}`, "expected a string");
}

function nullableStr(o: Obj, k: string, path: string): void {
  if (o[k] !== null && typeof o[k] !== "string") fail(`${path}.${k}`, "expected a string or null");
}

function bool(o: Obj, k: string, path: string): void {
  if (typeof o[k] !== "boolean") fail(`${path}.${k}`, "expected a boolean");
}

function arr(o: Obj, k: string, path: string): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) fail(`${path}.${k}`, "expected an array");
  return v;
}

function marks(o: Obj, path: string): Mark[] {
  const p = `${path}.marks`;
  const m = o["marks"];
  if (!Array.isArray(m)) fail(p, "expected an array");
  let prev = -1;
  for (const x of m) {
    const i = MARK_ORDER.indexOf(x as Mark);
    if (i < 0) fail(p, `unknown mark ${JSON.stringify(x)}`);
    if (i === prev) fail(p, `duplicate mark "${String(x)}"`);
    if (i < prev) fail(p, "marks must be sorted in canonical order (delete, emphasis, strong)");
    prev = i;
  }
  return m as Mark[];
}

function sameMarks(a: Mark[], b: Mark[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

function inlineList(list: unknown[], path: string, inLink: boolean): void {
  let prevText: Text | null = null;
  list.forEach((n, i) => {
    const p = `${path}[${i}]`;
    inline(n, p, inLink);
    const cur = (n as Obj)["type"] === "text" ? (n as Text) : null;
    if (cur && prevText && sameMarks(prevText.marks, cur.marks)) {
      fail(p, "adjacent text nodes with identical marks must be merged");
    }
    prevText = cur;
  });
}

function inline(n: unknown, path: string, inLink: boolean): void {
  if (!isObj(n)) fail(path, "expected an object");
  switch (n["type"]) {
    case "text":
      exactKeys(n, ["type", "value", "marks"], path);
      str(n, "value", path);
      if (n["value"] === "") fail(`${path}.value`, "text value must not be empty");
      marks(n, path);
      return;
    case "inlineCode":
      exactKeys(n, ["type", "value", "source", "marks"], path);
      str(n, "value", path); str(n, "source", path); marks(n, path);
      return;
    case "opaqueInline":
      exactKeys(n, ["type", "node", "source", "marks"], path);
      str(n, "node", path); str(n, "source", path); marks(n, path);
      return;
    case "image":
      exactKeys(n, ["type", "url", "title", "alt", "marks"], path);
      str(n, "url", path); nullableStr(n, "title", path); str(n, "alt", path); marks(n, path);
      return;
    case "break":
      exactKeys(n, ["type"], path);
      return;
    case "link":
      if (inLink) fail(path, "a link must not contain a link");
      exactKeys(n, ["type", "url", "title", "children"], path);
      str(n, "url", path); nullableStr(n, "title", path);
      inlineList(arr(n, "children", path), `${path}.children`, true);
      return;
    default:
      fail(path, `unknown inline type ${JSON.stringify(n["type"])}`);
  }
}

function blockList(list: unknown[], path: string): void {
  list.forEach((n, i) => block(n, `${path}[${i}]`));
}

function block(n: unknown, path: string): void {
  if (!isObj(n)) fail(path, "expected an object");
  switch (n["type"]) {
    case "paragraph":
      exactKeys(n, ["type", "children"], path);
      inlineList(arr(n, "children", path), `${path}.children`, false);
      return;
    case "heading":
      exactKeys(n, ["type", "depth", "children"], path);
      if (![1, 2, 3, 4, 5, 6].includes(n["depth"] as number)) fail(`${path}.depth`, "depth must be 1 to 6");
      inlineList(arr(n, "children", path), `${path}.children`, false);
      return;
    case "thematicBreak":
      exactKeys(n, ["type"], path);
      return;
    case "blockquote":
      exactKeys(n, ["type", "children"], path);
      blockList(arr(n, "children", path), `${path}.children`);
      return;
    case "list": {
      exactKeys(n, ["type", "ordered", "start", "spread", "children"], path);
      bool(n, "ordered", path); bool(n, "spread", path);
      if (n["start"] !== null && typeof n["start"] !== "number") fail(`${path}.start`, "expected a number or null");
      arr(n, "children", path).forEach((it, i) => {
        const p = `${path}.children[${i}]`;
        if (!isObj(it) || it["type"] !== "listItem") fail(p, "expected a listItem");
        exactKeys(it, ["type", "checked", "spread", "children"], p);
        if (it["checked"] !== null && typeof it["checked"] !== "boolean") fail(`${p}.checked`, "expected a boolean or null");
        bool(it, "spread", p);
        blockList(arr(it, "children", p), `${p}.children`);
      });
      return;
    }
    case "table": {
      exactKeys(n, ["type", "align", "children"], path);
      arr(n, "align", path).forEach((a, i) => {
        if (a !== null && a !== "left" && a !== "right" && a !== "center") fail(`${path}.align[${i}]`, "invalid alignment");
      });
      arr(n, "children", path).forEach((row, i) => {
        const p = `${path}.children[${i}]`;
        if (!isObj(row) || row["type"] !== "tableRow") fail(p, "expected a tableRow");
        exactKeys(row, ["type", "children"], p);
        arr(row, "children", p).forEach((cell, j) => {
          const cp = `${p}.children[${j}]`;
          if (!isObj(cell) || cell["type"] !== "tableCell") fail(cp, "expected a tableCell");
          exactKeys(cell, ["type", "children"], cp);
          inlineList(arr(cell, "children", cp), `${cp}.children`, false);
        });
      });
      return;
    }
    case "code":
      exactKeys(n, ["type", "lang", "meta", "value", "source"], path);
      nullableStr(n, "lang", path); nullableStr(n, "meta", path); str(n, "value", path); str(n, "source", path);
      return;
    case "container": {
      exactKeys(n, ["type", "name", "attributes", "label", "children"], path);
      str(n, "name", path);
      const attrs = n["attributes"];
      if (!isObj(attrs)) fail(`${path}.attributes`, "expected an object");
      for (const [k, v] of Object.entries(attrs)) {
        if (typeof v !== "string") fail(`${path}.attributes.${k}`, "expected a string");
      }
      const label = n["label"];
      if (label !== null) {
        if (!Array.isArray(label)) fail(`${path}.label`, "expected an array or null");
        if (label.length === 0) fail(`${path}.label`, "label must be null or a non-empty inline array");
        inlineList(label, `${path}.label`, false);
      }
      blockList(arr(n, "children", path), `${path}.children`);
      return;
    }
    case "opaqueBlock":
      exactKeys(n, ["type", "node", "source"], path);
      str(n, "node", path); str(n, "source", path);
      return;
    default:
      fail(path, `unknown block type ${JSON.stringify(n["type"])}`);
  }
}

/** Validates the portable rich-text tree contract v1. Returns the same object; throws ValidationError naming the JSON path. */
export function validateTree(value: unknown, path = "$"): RichTextRoot {
  if (!isObj(value)) fail(path, "expected an object");
  if (value["type"] !== "root") fail(path, `expected type "root"`);
  exactKeys(value, ["type", "version", "mode", "children"], path);
  if (value["version"] !== 1) fail(`${path}.version`, "version must be 1");
  if (value["mode"] !== "md" && value["mode"] !== "mdx") fail(`${path}.mode`, 'mode must be "md" or "mdx"');
  blockList(arr(value, "children", path), `${path}.children`);
  return value as unknown as RichTextRoot;
}
