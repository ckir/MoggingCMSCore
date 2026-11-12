import { normalizeLocale, type Ctx } from "@mogging/core";
import type { GlossaryEntry } from "./validate.js";

type Row = {
  source_locale: string; target_locale: string; term: string; translation: string | null;
  accepted_forms: string[]; do_not_translate: boolean; note: string | null;
};

/** The glossary entries of one locale pair, ordered by term. Locales are normalized (DE -> de). */
export async function listGlossary(
  ctx: Ctx, input: { sourceLocale: string; targetLocale: string },
): Promise<GlossaryEntry[]> {
  const source = normalizeLocale(input.sourceLocale);
  const target = normalizeLocale(input.targetLocale);
  const rows = (await ctx.sql`select source_locale, target_locale, term, translation, accepted_forms, do_not_translate, note
    from glossary where source_locale = ${source} and target_locale = ${target} order by term`) as unknown as Row[];
  return rows.map((r) => ({
    sourceLocale: r.source_locale, targetLocale: r.target_locale, term: r.term, translation: r.translation,
    acceptedForms: [...r.accepted_forms], doNotTranslate: r.do_not_translate, note: r.note,
  }));
}

/** Inserts or updates entries by (source locale, target locale, term), all in one transaction. */
export async function upsertGlossary(ctx: Ctx, entries: GlossaryEntry[]): Promise<{ upserted: number }> {
  // Normalize before opening the transaction so a malformed locale writes nothing.
  const prepared = entries.map((e) => ({
    ...e, sourceLocale: normalizeLocale(e.sourceLocale), targetLocale: normalizeLocale(e.targetLocale),
  }));
  await ctx.sql.begin(async (tx) => {
    for (const e of prepared) {
      await tx`insert into glossary (source_locale, target_locale, term, translation, accepted_forms, do_not_translate, note, updated_by, updated_at)
        values (${e.sourceLocale}, ${e.targetLocale}, ${e.term}, ${e.translation}, ${e.acceptedForms}::text[],
                ${e.doNotTranslate}, ${e.note}, ${ctx.actor}, clock_timestamp())
        on conflict (source_locale, target_locale, term) do update set
          translation = excluded.translation, accepted_forms = excluded.accepted_forms,
          do_not_translate = excluded.do_not_translate, note = excluded.note,
          updated_by = excluded.updated_by, updated_at = clock_timestamp()`;
    }
  });
  return { upserted: prepared.length };
}
