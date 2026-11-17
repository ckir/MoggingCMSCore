import { defineConfig } from "@mogging/core";
import { starlightPreset } from "@mogging/starlight/preset";

// The Starlight docs collection and its layout (folders, locale folders, front-matter mapping).
const docs = starlightPreset({
  docsDir: "src/content/docs",
  sourceDir: null,
  localeDirs: { "de": "de", "zh-CN": "zh-cn" },
});

export const config = defineConfig({
  collections: [docs.collection],
  locales: { source: "en", chains: { "de": ["en"], "zh-CN": ["en"] } },
});

// Read by the mogging CLI: where the docs live and how front matter maps to fields.
export const starlight = docs.layout;

// AI translation (optional). Uncomment, then set the model ids and prices from your provider.
// Secrets are read from the environment, never from this file:
//   OPENROUTER_API_KEY   the OpenRouter API key used by `mogging compile` and `mogging worker`
//   MOGGING_LICENSE_KEY  your MoggingCMS licence key (without one, the 30-day evaluation applies)
//
// import { defineAiConfig } from "@mogging/ai";
//
// export const ai = defineAiConfig({
//   provider: { kind: "openrouter" },
//   models: { translate: "<vendor>/<model-id>" },
//   prices: { "<vendor>/<model-id>": { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 128000 } },
//   budgets: { monthlyCapUsd: 10 },
// });
