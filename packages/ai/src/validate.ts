import type { Field } from "@mogging/core";
import { restoreDraft, sentinelize, validateTree } from "@mogging/markdown";
import type { SentinelPrepared } from "@mogging/markdown";
import type { GlossaryMode } from "./config.js";
import { checkShape, stringLeaves } from "./fields.js";

export type GlossaryEntry = {
  sourceLocale: string; targetLocale: string; term: string; translation: string | null;
  acceptedForms: string[]; doNotTranslate: boolean; note: string | null;
};

export type PreparedField =
  | { kind: "richText"; field: string; prepared: SentinelPrepared; wire: string }   // wire = prepared.markdown
  | { kind: "value"; field: string; source: unknown; wire: unknown };

export type FieldVerdict =
  | { ok: true; value: unknown; warnings: string[]; glossaryTermsUsed: string[] }
  | { ok: false; rejections: string[]; warnings: string[] };

const PLACEHOLDER_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}/g;

/** Rich text: validate the tree, then replace code and opaque nodes with sentinels. Anything else goes over the wire as is. */
export function prepareField(name: string, field: Field, value: unknown): PreparedField {
  if (field.kind === "richText") {
    const prepared = sentinelize(validateTree(value));
    return { kind: "richText", field: name, prepared, wire: prepared.markdown };
  }
  return { kind: "value", field: name, source: value, wire: value };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A term bounded by non-letter characters or a string edge (digits and punctuation are boundaries; a combining mark continues a word); the term itself matches literally. */
function boundedTerm(term: string, flags: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{M}])${escapeRegExp(term)}(?![\\p{L}\\p{M}])`, flags);
}

function countTerm(text: string, term: string, flags: string): number {
  return (text.match(boundedTerm(term, flags)) ?? []).length;
}

function leafText(value: unknown): string {
  return stringLeaves(value).map((l) => l.text).join("\n");
}

/**
 * Spec 8.4 checks 2 to 4 (plus the U+0000 and shape gates) over one field's draft. Rejections are collected in rule
 * order; when the draft is not well formed (rule 1) rules 2 to 4 are skipped because they need a readable draft.
 */
export function validateField(args: {
  prepared: PreparedField; field: Field; draft: unknown; glossary: GlossaryEntry[]; glossaryMode: GlossaryMode;
}): FieldVerdict {
  const { prepared, field, draft, glossary, glossaryMode } = args;
  const name = prepared.field;
  const reject = (m: string): string => `${name}: ${m}`;
  const rejections: string[] = [];
  const warnings: string[] = [];
  let value: unknown = draft;
  let wellFormed = true;
  let sourceText: string;
  let draftText: string;

  if (prepared.kind === "richText") {
    sourceText = prepared.prepared.markdown;
    draftText = typeof draft === "string" ? draft : "";
    if (draftText.includes("\u0000")) rejections.push(reject("contains U+0000"));
    if (typeof draft !== "string") {
      rejections.push(reject("expected a Markdown string"));
      wellFormed = false;
    } else {
      const restored = restoreDraft(prepared.prepared, draft);
      if (restored.ok) value = restored.root;
      else {
        rejections.push(reject(`restore ${restored.codes.join(",")}: ${restored.detail}`));
        wellFormed = false;
      }
    }
  } else {
    sourceText = leafText(prepared.source);
    draftText = leafText(draft);
    if (stringLeaves(draft).some((l) => l.text.includes("\u0000"))) rejections.push(reject("contains U+0000"));
    const shape = checkShape(field, prepared.source, draft);
    for (const s of shape) rejections.push(reject(s));
    if (shape.length > 0) wellFormed = false;
  }

  const glossaryTermsUsed: string[] = [];
  if (wellFormed) {
    sourceText = sourceText.normalize("NFC");
    draftText = draftText.normalize("NFC");

    // 2. placeholder parity (multiset)
    const src = (sourceText.match(PLACEHOLDER_RE) ?? []).sort();
    const dst = (draftText.match(PLACEHOLDER_RE) ?? []).sort();
    if (src.length !== dst.length || src.some((p, i) => p !== dst[i])) {
      rejections.push(reject(`placeholder mismatch: source [${src.join(", ")}] draft [${dst.join(", ")}]`));
    }

    // 3. do-not-translate terms survive, at least as often as in the source
    for (const g of glossary) {
      if (!g.doNotTranslate || g.term === "") continue;
      const term = g.term.normalize("NFC");
      const inSource = countTerm(sourceText, term, "gu");
      if (inSource > 0 && countTerm(draftText, term, "gu") < inSource) {
        rejections.push(reject(`do-not-translate term "${g.term}" missing`));
      }
    }

    // 4. glossary translations: the approved translation or an accepted form must appear
    const draftLower = draftText.toLowerCase();
    for (const g of glossary) {
      if (g.translation === null || g.translation === "" || g.term === "") continue;
      if (countTerm(sourceText, g.term.normalize("NFC"), "giu") === 0) continue;
      const wanted = [g.translation, ...g.acceptedForms].filter((f) => f !== "");
      if (wanted.some((f) => draftLower.includes(f.normalize("NFC").toLowerCase()))) {
        if (!glossaryTermsUsed.includes(g.term)) glossaryTermsUsed.push(g.term);
        continue;
      }
      const message = `glossary: "${g.term}" expected "${g.translation}"`;
      if (glossaryMode === "strict") rejections.push(reject(message));
      else warnings.push(message);
    }
  }

  if (rejections.length > 0) return { ok: false, rejections, warnings };
  return { ok: true, value, warnings, glossaryTermsUsed };
}
