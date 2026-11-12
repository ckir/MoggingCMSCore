import { usdToMicros, type AiConfig, type ModelPrice } from "./config.js";

/** JSON overhead of the structured output, reserved on top of the translated text (tokens). */
const OUTPUT_MARGIN_TOKENS = 512;
const SAFETY_FACTOR = 1.5;
const CJK = new Set(["zh", "ja", "ko"]);

const language = (locale: string): string => locale.split(/[-_]/)[0]!.toLowerCase();

/** Spec 8.5: 1.5 characters per token when either language subtag is zh, ja or ko, otherwise 3. */
export function charsPerToken(sourceLocale: string, targetLocale: string): 3 | 1.5 {
  return CJK.has(language(sourceLocale)) || CJK.has(language(targetLocale)) ? 1.5 : 3;
}

const tokensOf = (chars: number, cpt: number): number => Math.ceil(chars / cpt);

// ceil(1.3 * t) computed in integers, so 1.3 * 77 = 100.10000000000001 and its kin cannot drift.
const translatedTokens = (t: number): number => Math.ceil((t * 13) / 10);

export type Estimate = { inputTokens: number; outputTokens: number; costMicros: number };

/** Spec 8.5's pre-call estimate, including the 1.5 safety factor. */
export function estimateRequest(args: {
  sourceLocale: string; targetLocale: string; translateChars: number; contextChars: number;
  templateTokens: number; price: ModelPrice;
}): Estimate {
  const cpt = charsPerToken(args.sourceLocale, args.targetLocale);
  const inputTokens = tokensOf(args.translateChars + args.contextChars, cpt) + args.templateTokens;
  const outputTokens = translatedTokens(tokensOf(args.translateChars, cpt)) + OUTPUT_MARGIN_TOKENS;
  const usd = (inputTokens * args.price.inputUsdPerMtok + outputTokens * args.price.outputUsdPerMtok) / 1e6;
  return { inputTokens, outputTokens, costMicros: Math.round(usd * SAFETY_FACTOR * 1e6) };
}

/**
 * The cost of a call that happened: the provider-reported cost when there is one, else tokens x price (no safety
 * factor). An unreported token count counts as 0; the caller records the warning.
 */
export function actualCostMicros(
  usage: { inputTokens: number | undefined; outputTokens: number | undefined },
  price: ModelPrice,
  providerCostUsd?: number,
): number {
  if (providerCostUsd !== undefined && Number.isFinite(providerCostUsd)) return usdToMicros(providerCostUsd);
  const usd = ((usage.inputTokens ?? 0) * price.inputUsdPerMtok + (usage.outputTokens ?? 0) * price.outputUsdPerMtok) / 1e6;
  return usdToMicros(usd);
}

/** A field's own input tokens, without the template (counted once per request by planRequests). */
export function fieldTokens(wire: unknown, sourceLocale: string, targetLocale: string): number {
  return tokensOf((JSON.stringify(wire) ?? "").length, charsPerToken(sourceLocale, targetLocale));
}

export type RequestPlan = { fields: string[]; inputTokens: number; maxOutputTokens: number; noContext: boolean };

/**
 * The one grouping rule (spec 8.2): packs fields into requests that fit the model's context window, an oversized
 * field in its own request, a field too large for the window with context retried alone without it.
 */
export function planRequests(args: {
  ai: AiConfig; price: ModelPrice; sourceLocale: string; targetLocale: string;
  fields: Array<{ name: string; wire: unknown }>; contextChars: number; glossaryChars: number; templateTokens: number;
}): { requests: RequestPlan[] } | { tooLarge: string } {
  const { ai, price } = args;
  const cpt = charsPerToken(args.sourceLocale, args.targetLocale);
  const withContext = tokensOf(args.contextChars, cpt) + args.templateTokens;
  const withoutContext = tokensOf(args.glossaryChars, cpt) + args.templateTokens;
  const reserve = (t: number): number => Math.min(ai.maxOutputTokens, translatedTokens(t) + OUTPUT_MARGIN_TOKENS);
  const fits = (t: number, fixed: number): boolean => t + fixed + reserve(t) <= price.contextTokens;

  type Draft = { fields: string[]; t: number; fixed: number; noContext: boolean };
  const drafts: Draft[] = []; // in creation order, which is the order of each request's first field
  let packed: Draft | undefined; // the last open packed request

  for (const { name, wire } of args.fields) {
    const t = fieldTokens(wire, args.sourceLocale, args.targetLocale);
    if (!fits(t, withContext)) {
      if (!fits(t, withoutContext)) return { tooLarge: name };
      drafts.push({ fields: [name], t, fixed: withoutContext, noContext: true });
    } else if (t > ai.perFieldTokenLimit) {
      drafts.push({ fields: [name], t, fixed: withContext, noContext: false });
    } else if (packed && fits(packed.t + t, withContext)) {
      packed.fields.push(name);
      packed.t += t;
    } else {
      packed = { fields: [name], t, fixed: withContext, noContext: false };
      drafts.push(packed);
    }
  }

  return {
    requests: drafts.map((d) => {
      const inputTokens = d.t + d.fixed;
      return {
        fields: d.fields,
        inputTokens,
        maxOutputTokens: Math.min(ai.maxOutputTokens, price.contextTokens - inputTokens),
        noContext: d.noContext,
      };
    }),
  };
}

/**
 * Splits an integer total by proportional shares, floor rounding with the remainder on the first element, so the
 * parts sum to the total. All-zero shares split evenly.
 */
export function apportion(total: number, shares: number[]): number[] {
  if (shares.length === 0) return [];
  const sum = shares.reduce((a, b) => a + b, 0);
  const weights = sum === 0 ? shares.map(() => 1) : shares;
  const weightSum = sum === 0 ? shares.length : sum;
  const parts = weights.map((w) => Math.floor((total * w) / weightSum));
  parts[0]! += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}
