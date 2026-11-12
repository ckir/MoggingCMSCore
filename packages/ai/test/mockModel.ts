import { MockLanguageModelV3 } from "ai/test";

export type MockCallOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];
export type MockResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

/** A provider result returned as is (merged over the default), for finish reasons and usage the plain form cannot express. */
export class RawResult {
  constructor(readonly result: Partial<MockResult>) {}
}

/** An output the mock returns: a value (JSON-encoded as the text), a thrown Error, a raw result, or a function of the call. */
export type MockOutput = unknown | Error | RawResult | ((options: MockCallOptions) => unknown);

const base = (text: string): MockResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  },
  warnings: [],
});

/**
 * A V3 mock whose n-th call answers with outputs[n]: a value is returned as JSON text with 100 input and 50 output
 * tokens; an Error is thrown; a function receives the call options and its result is treated the same way. A call
 * beyond the list throws.
 */
export function mockModel(outputs: MockOutput[]): MockLanguageModelV3 {
  let n = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const i = n++;
      if (i >= outputs.length) throw new Error(`mockModel: no output for call ${i}`);
      let out = outputs[i];
      if (typeof out === "function") out = (out as (o: MockCallOptions) => unknown)(options);
      if (out instanceof Error) throw out;
      if (out instanceof RawResult) return { ...base(""), ...out.result };
      return base(JSON.stringify(out));
    },
  });
}

/** The system and user message texts of a recorded call. */
export function messagesOf(options: MockCallOptions): { system: string; user: string } {
  let system = "";
  let user = "";
  for (const m of options.prompt) {
    if (m.role === "system") system += m.content;
    else if (m.role === "user") {
      for (const p of m.content) if (p.type === "text") user += p.text;
    }
  }
  return { system, user };
}

/** The parsed data block of a user message (`<<<DATA\n...\nDATA>>>`). */
export function dataOf(options: MockCallOptions): {
  translate: Record<string, unknown>; siblings: Record<string, unknown>; shared: Record<string, unknown>; glossary: unknown[];
} {
  const { user } = messagesOf(options);
  return JSON.parse(user.slice("<<<DATA\n".length, -"\nDATA>>>".length));
}

/** An identity translation: every field of the request returned unchanged. */
export const identity = (options: MockCallOptions): unknown => ({ fields: dataOf(options).translate, glossaryTermsUsed: [] });
