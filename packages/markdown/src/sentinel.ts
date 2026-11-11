import { ValidationError } from "@mogging/core";
import { canonicalize, markdownToTree } from "./parse.js";
import { treeToMarkdown } from "./serialize.js";
import { validateTree } from "./tree.js";
import type { Block, Code, Inline, InlineCode, OpaqueBlock, OpaqueInline, RichTextRoot, Text } from "./tree.js";

export type RejectionCode =
  | "PARSE_ERROR" | "SENTINEL_ALTERED" | "SENTINEL_DUPLICATED" | "SENTINEL_MISSING"
  | "BLOCK_SEQUENCE" | "LINK_TARGETS" | "PLACEHOLDER";
export const REJECTION_ORDER: readonly RejectionCode[] =
  ["PARSE_ERROR", "SENTINEL_ALTERED", "SENTINEL_DUPLICATED", "SENTINEL_MISSING", "BLOCK_SEQUENCE", "LINK_TARGETS", "PLACEHOLDER"];
export type SentinelOriginal = { index: number; kind: "block" | "inline"; node: Code | OpaqueBlock | InlineCode | OpaqueInline };
export type SentinelPrepared = { source: RichTextRoot; markdown: string; originals: SentinelOriginal[] };
export type RestoreResult =
  | { ok: true; root: RichTextRoot }
  | { ok: false; codes: RejectionCode[]; detail: string };

const SENT_SRC = "⟦MOGGING:(\\d+)⟧";
const RESIDUE = /[⟦⟧]|MOGGING:\d/;
const PLACEHOLDER_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}/g;
const token = (i: number): string => `⟦MOGGING:${i}⟧`;
const sentRe = (): RegExp => new RegExp(SENT_SRC, "g");

// ---------------------------------------------------------------- sentinelize

function assertNoSentinel(node: unknown, path: string): void {
  if (Array.isArray(node)) { node.forEach((n, i) => assertNoSentinel(n, `${path}[${i}]`)); return; }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const fields: string[] = o["type"] === "text" ? ["value"] : o["type"] === "image" ? ["alt", "url", "title"] : o["type"] === "link" ? ["url", "title"] : [];
  for (const f of fields) {
    const v = o[f];
    if (typeof v === "string" && RESIDUE.test(v)) throw new ValidationError(`source already contains a sentinel token at ${path}.${f}`);
  }
  if (o["type"] === "container") {
    if (typeof o["name"] === "string" && RESIDUE.test(o["name"])) throw new ValidationError(`source already contains a sentinel token at ${path}.name`);
    for (const [k, v] of Object.entries((o["attributes"] ?? {}) as Record<string, unknown>)) {
      if (typeof v === "string" && RESIDUE.test(v)) throw new ValidationError(`source already contains a sentinel token at ${path}.attributes.${k}`);
    }
  }
  for (const [k, v] of Object.entries(o)) if (v && typeof v === "object") assertNoSentinel(v, `${path}.${k}`);
}

/** Replaces every code / opaque node with a sentinel token so a model can translate the prose around them. */
export function sentinelize(root: RichTextRoot): SentinelPrepared {
  validateTree(root);
  assertNoSentinel(root, "$");
  const source = structuredClone(root);
  const work = structuredClone(root);
  const originals: SentinelOriginal[] = [];

  const inlines = (list: Inline[]): Inline[] => {
    const out: Inline[] = list.map((n): Inline => {
      if (n.type === "inlineCode" || n.type === "opaqueInline") {
        const index = originals.length;
        originals.push({ index, kind: "inline", node: n });
        return { type: "text", value: token(index), marks: [...n.marks] };
      }
      if (n.type === "link") n.children = inlines(n.children) as typeof n.children;
      return n;
    });
    return canonicalize(out);
  };
  const blocks = (list: Block[]): Block[] =>
    list.map((b): Block => {
      switch (b.type) {
        case "code":
        case "opaqueBlock": {
          const index = originals.length;
          originals.push({ index, kind: "block", node: b });
          return { type: "paragraph", children: [{ type: "text", value: token(index), marks: [] }] };
        }
        case "paragraph":
        case "heading":
          b.children = inlines(b.children);
          return b;
        case "blockquote":
          b.children = blocks(b.children);
          return b;
        case "list":
          for (const it of b.children) it.children = blocks(it.children);
          return b;
        case "table":
          for (const row of b.children) for (const cell of row.children) cell.children = inlines(cell.children);
          return b;
        case "container":
          if (b.label) b.label = inlines(b.label);
          b.children = blocks(b.children);
          return b;
        default:
          return b;
      }
    });
  work.children = blocks(work.children);
  return { source, markdown: treeToMarkdown(work), originals };
}

// ---------------------------------------------------------------- structure signature

function signature(root: RichTextRoot, indexOf?: WeakMap<object, number>): string[] {
  const out: string[] = [];
  let counter = 0; // document-order original numbering, mirrors sentinelize; used for the source tree
  const idx = (n: object): number => { const c = counter++; return indexOf ? (indexOf.get(n) ?? -1) : c; };
  const inl = (list: Inline[]): void => {
    for (const n of list) {
      if (n.type === "inlineCode") { idx(n); out.push("inlineCode"); }
      else if (n.type === "opaqueInline") { idx(n); out.push(`opaqueInline:${n.node}`); }
      else if (n.type === "link") inl(n.children);
    }
  };
  const blk = (list: Block[]): void => {
    for (const b of list) {
      switch (b.type) {
        case "paragraph": out.push("paragraph"); inl(b.children); break;
        case "heading": out.push(`heading:${b.depth}`); inl(b.children); break;
        case "blockquote": out.push("blockquote"); blk(b.children); out.push("/blockquote"); break;
        case "list":
          out.push(b.ordered ? `list:o:${JSON.stringify(b.start)}` : "list:u");
          for (const it of b.children) { out.push(`listItem:${String(it.checked)}`); blk(it.children); out.push("/listItem"); }
          out.push("/list");
          break;
        case "table":
          out.push(`table:${b.align.join(",")}`);
          for (const row of b.children) {
            out.push(`tableRow:${row.children.length}`);
            for (const c of row.children) { out.push("tableCell"); inl(c.children); out.push("/tableCell"); }
            out.push("/tableRow");
          }
          out.push("/table");
          break;
        case "thematicBreak": out.push("thematicBreak"); break;
        case "code": out.push(`code#${idx(b)}`); break;
        case "opaqueBlock": out.push(`opaqueBlock:${b.node}#${idx(b)}`); break;
        case "container": {
          const attrs = Object.fromEntries(Object.entries(b.attributes).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
          out.push(`container:${b.name}:${JSON.stringify(attrs)}`);
          if (b.label) inl(b.label);
          blk(b.children);
          out.push("/container");
          break;
        }
      }
    }
  };
  blk(root.children);
  return out;
}

function linkTargets(root: RichTextRoot): string[] {
  const out: string[] = [];
  const inl = (list: Inline[]): void => {
    for (const n of list) {
      if (n.type === "image") out.push(`img:${n.url}`);
      else if (n.type === "link") { out.push(`link:${n.url}`); inl(n.children); }
    }
  };
  const blk = (list: Block[]): void => {
    for (const b of list) {
      switch (b.type) {
        case "paragraph": case "heading": inl(b.children); break;
        case "blockquote": blk(b.children); break;
        case "list": for (const it of b.children) blk(it.children); break;
        case "table": for (const row of b.children) for (const c of row.children) inl(c.children); break;
        case "container": if (b.label) inl(b.label); blk(b.children); break;
        default: break;
      }
    }
  };
  blk(root.children);
  return out.sort();
}

function placeholders(md: string): string {
  return (md.replace(sentRe(), "").match(PLACEHOLDER_RE) ?? []).sort().join("\n");
}

// ---------------------------------------------------------------- restoreDraft

/** Structurally validates an AI draft against its sentinelized source and re-inserts the originals. */
export function restoreDraft(prepared: SentinelPrepared, draftMarkdown: string): RestoreResult {
  const { source, originals } = prepared;
  const n = originals.length;
  const mode = source.mode;
  const codes = new Set<RejectionCode>();
  const notes: string[] = [];

  // 1. parse the draft
  let draft: RichTextRoot;
  try {
    draft = markdownToTree(draftMarkdown, { mode });
  } catch (e) {
    return { ok: false, codes: ["PARSE_ERROR"], detail: `parse: ${String((e as Error).message).slice(0, 120)}` };
  }

  // 2. sentinel scan on the raw draft string
  const counts = new Map<number, number>();
  for (const m of draftMarkdown.matchAll(sentRe())) counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1);
  const residue = draftMarkdown.replace(sentRe(), "");
  const invented = [...counts.keys()].filter((i) => i >= n);
  if (RESIDUE.test(residue) || invented.length > 0) {
    codes.add("SENTINEL_ALTERED");
    notes.push(`altered/invented sentinel text: ${(residue.match(/.{0,12}(?:[⟦⟧]|MOGGING:\d).{0,12}/) ?? [`invented index ${invented[0]}`])[0]}`);
  }
  const dups: number[] = [];
  const missing: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = counts.get(i) ?? 0;
    if (c > 1) dups.push(i);
    if (c === 0) missing.push(i);
  }

  // 3. re-insert the originals at legal positions only
  const seen = new Map<number, number>();
  const hit = (i: number): void => { seen.set(i, (seen.get(i) ?? 0) + 1); };
  const indexOf = new WeakMap<object, number>();
  const inl = (list: Inline[]): Inline[] => {
    const out: Inline[] = [];
    for (const node of list) {
      if (node.type === "link") { node.children = inl(node.children) as typeof node.children; out.push(node); continue; }
      if (node.type !== "text") { out.push(node); continue; }
      const t: Text = node;
      let last = 0;
      for (const m of t.value.matchAll(sentRe())) {
        const idx = Number(m[1]);
        const orig = originals[idx];
        if (!orig || orig.kind !== "inline") continue;
        if (m.index > last) out.push({ type: "text", value: t.value.slice(last, m.index), marks: [...t.marks] });
        const clone = structuredClone(orig.node) as InlineCode | OpaqueInline;
        clone.marks = [...t.marks];
        indexOf.set(clone, idx);
        out.push(clone);
        hit(idx);
        last = m.index + m[0].length;
      }
      if (last === 0) out.push(t);
      else if (last < t.value.length) out.push({ type: "text", value: t.value.slice(last), marks: [...t.marks] });
    }
    return canonicalize(out);
  };
  const blk = (list: Block[]): Block[] =>
    list.map((b): Block => {
      if (b.type === "paragraph" && b.children.length === 1) {
        const only = b.children[0]!;
        if (only.type === "text" && only.marks.length === 0) {
          const m = new RegExp(`^${SENT_SRC}$`).exec(only.value);
          const orig = m ? originals[Number(m[1])] : undefined;
          if (orig && orig.kind === "block") {
            hit(orig.index);
            const clone = structuredClone(orig.node) as Block;
            indexOf.set(clone, orig.index);
            return clone;
          }
        }
      }
      switch (b.type) {
        case "paragraph":
        case "heading":
          b.children = inl(b.children);
          return b;
        case "blockquote":
          b.children = blk(b.children);
          return b;
        case "list":
          for (const it of b.children) it.children = blk(it.children);
          return b;
        case "table":
          for (const row of b.children) for (const cell of row.children) cell.children = inl(cell.children);
          return b;
        case "container":
          if (b.label) b.label = inl(b.label);
          b.children = blk(b.children);
          return b;
        default:
          return b;
      }
    });
  const restored: RichTextRoot = { ...draft, children: blk(draft.children) };
  for (const [i, c] of counts) {
    if (i < n && (seen.get(i) ?? 0) !== c && !codes.has("SENTINEL_ALTERED")) {
      codes.add("SENTINEL_ALTERED");
      notes.push(`sentinel ${i} is not a standalone ${originals[i]!.kind} token (wrong position/kind/wrapped)`);
    }
  }
  if (dups.length) { codes.add("SENTINEL_DUPLICATED"); notes.push(`duplicated: ${dups.slice(0, 5).join(",")}`); }
  if (missing.length) { codes.add("SENTINEL_MISSING"); notes.push(`missing: ${missing.slice(0, 5).join(",")} (${missing.length}/${n})`); }

  // 4 + 5. structure and link targets, only when the sentinels are sound
  if (codes.size === 0) {
    const a = signature(source);
    const b = signature(restored, indexOf);
    if (a.join("|") !== b.join("|")) {
      codes.add("BLOCK_SEQUENCE");
      let k = 0;
      while (k < a.length && a[k] === b[k]) k++;
      notes.push(`block seq differs at ${k}: source=${a[k] ?? "(end)"} draft=${b[k] ?? "(end)"} (len ${a.length} vs ${b.length})`);
    }
    if (linkTargets(source).join("\n") !== linkTargets(restored).join("\n")) {
      codes.add("LINK_TARGETS");
      notes.push("link/image targets differ from the source");
    }
  }

  // 6. placeholders
  if (placeholders(prepared.markdown) !== placeholders(draftMarkdown)) {
    codes.add("PLACEHOLDER");
    notes.push(`placeholders source=[${placeholders(prepared.markdown).replace(/\n/g, ",")}] draft=[${placeholders(draftMarkdown).replace(/\n/g, ",")}]`);
  }

  // 7. the restored tree must survive a serialize/parse round trip
  try {
    markdownToTree(treeToMarkdown(restored), { mode });
  } catch (e) {
    codes.add("PARSE_ERROR");
    notes.push(`re-serialised result does not parse: ${String((e as Error).message).slice(0, 100)}`);
  }

  if (codes.size > 0) return { ok: false, codes: REJECTION_ORDER.filter((c) => codes.has(c)), detail: notes.join(" | ") };
  return { ok: true, root: validateTree(restored) };
}
