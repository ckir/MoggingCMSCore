import { assertActor, type Ctx } from "../ctx.js";
import { ConflictError, NotFoundError, NotPublishableError, ValidationError } from "../errors.js";
import { normalizeLocale } from "../schema/locale.js";
import { rejectNul } from "../values/nul.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Duplicated from approve.ts on purpose (the repo's idiom, see recordAiDraft.ts).
function resolveLocale(ctx: Ctx, input: string): string {
  const { config } = ctx;
  if (input === "shared") throw new ValidationError("AI drafts are translations: locale cannot be \"shared\"");
  const locale = normalizeLocale(input);
  const declared = new Set([config.locales.source, ...Object.keys(config.locales.chains)]);
  if (!declared.has(locale)) throw new ValidationError(`Locale "${locale}" is not declared in the config`);
  if (locale === config.locales.source) {
    throw new ValidationError(`Locale "${locale}" is the source locale: AI drafts are translations`);
  }
  return locale;
}

/**
 * Rejects the DRAFT_AI head of (doc, locale) as a whole (spec 6.3): the head flag is cleared, the row stays in
 * history and a `human:reject` provenance row records who and why. The pair is stale again afterwards. Not
 * licence-guarded: it only removes a draft head (spec 12.3). Returns the rejected draft's version.
 */
export async function rejectDraft(
  ctx: Ctx, input: { docId: string; locale: string; reason?: string; expectedVersion?: number },
): Promise<{ version: number }> {
  assertActor(ctx);
  const { sql, actor } = ctx;
  const locale = resolveLocale(ctx, input.locale);
  if (typeof input.reason === "string") rejectNul(input.reason, "reason");
  if (!UUID.test(input.docId)) throw new NotFoundError(`Document "${input.docId}" not found`);

  return sql.begin(async (tx) => {
    const [doc] = await tx`select id from documents where id = ${input.docId} and deleted_at is null for update`;
    if (!doc) throw new NotFoundError(`Document "${input.docId}" not found`);
    const [{ t }] = (await tx`select clock_timestamp() as t`) as unknown as [{ t: Date }];
    const label = `${input.docId}/${locale}`;

    const [head] = await tx`select version, state from document_localized
      where doc_id = ${input.docId} and locale = ${locale} and is_head_draft`;
    if (!head) throw new NotPublishableError(`${label} has no draft head to reject`);
    if (head.state !== "DRAFT_AI") {
      throw new NotPublishableError(`Draft head of ${label} (state ${String(head.state)}) is not a DRAFT_AI`);
    }
    const version = head.version as number;
    if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
      throw new ConflictError(`Expected draft version ${input.expectedVersion} of ${label} but the head is ${version}`);
    }

    await tx`update document_localized set is_head_draft = false
      where doc_id = ${input.docId} and locale = ${locale} and is_head_draft`;
    await tx`insert into content_provenance
        (doc_id, locale, version, field_path, job_id, model_id, prompt_version, prompt_tokens,
         completion_tokens, cost_micros, discard_reason, approved_by, approved_at, created_at)
      values (${input.docId}, ${locale}, ${version}, null, null, 'human:reject', '', 0, 0, 0,
              ${input.reason ?? null}, ${actor}, ${t}, ${t})`;
    return { version };
  });
}
