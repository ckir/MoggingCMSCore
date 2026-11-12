import type { Collection, DocumentRecord, Field } from "@mogging/core";
import type { AiConfig } from "./config.js";
import { contextValues } from "./prompt.js";

export type ContextGlossary = Array<{ term: string; translation: string | null; doNotTranslate: boolean }>;

/** What a job's requests send beside the fields to translate, and its size as buildPrompt renders it. */
export type JobContext = {
  siblings: Record<string, unknown>; shared: Record<string, unknown>; glossary: ContextGlossary;
  contextChars: number;  // siblings, shared and glossary
  glossaryChars: number; // the glossary alone (a noContext request)
};

/** The JSON rendering of the non-translate part of the user message, as buildPrompt renders it (indent 1). */
const payloadChars = (siblings: Record<string, unknown>, shared: Record<string, unknown>, glossary: unknown[]): number =>
  JSON.stringify({ siblings, shared, glossary }, null, 1).length;

/**
 * The context of a job over `jobFields` of `doc` for `locale`: the target's other localized fields (draft head, else
 * published head) as siblings, the shared head's non-localized fields as shared, and the glossary reduced to what the
 * prompt carries. ONE derivation for the enqueue estimate and the worker, so the two cannot drift.
 */
export function jobContext(
  ai: AiConfig, collection: Collection, doc: DocumentRecord, locale: string, jobFields: Iterable<string>,
  glossary: ReadonlyArray<{ term: string; translation: string | null; doNotTranslate: boolean }>,
): JobContext {
  const target = doc.locales[locale];
  const inJob = new Set(jobFields);
  const siblingFields: Record<string, Field> = {};
  const sharedFields: Record<string, Field> = {};
  for (const [name, f] of Object.entries(collection.fields)) {
    if (!f.localized) sharedFields[name] = f;
    else if (!inJob.has(name)) siblingFields[name] = f;
  }
  const siblings = contextValues(siblingFields, (target?.draft ?? target?.published)?.data ?? {}, ai.contextCharLimit);
  const shared = contextValues(sharedFields, doc.shared.published?.data ?? {}, ai.contextCharLimit);
  const g = glossary.map((e) => ({ term: e.term, translation: e.translation, doNotTranslate: e.doNotTranslate }));
  return { siblings, shared, glossary: g, contextChars: payloadChars(siblings, shared, g), glossaryChars: payloadChars({}, {}, g) };
}
