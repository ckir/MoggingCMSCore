// Template acceptance run (spec 7): packs the five packages, installs them into a copy of templates/starlight outside
// the repository, drives the real CLI through the template's own `mogging` npm script against a throwaway schema
// (import, a mocked compile, approve, a release, export) and then builds the site with `astro build`.
// Needs the npm registry; not part of `pnpm test`. Usage: DATABASE_URL=postgres://... pnpm accept:starlight
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAndPack, check, installSite, removeLicences, root, sh, siteEnv, throwawaySchema } from "./lib/packed.mjs";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL is not set: point it at the test database (docs/dev-setup.md)");
  process.exit(2);
}

const ok = (step) => console.log(`OK   ${step}`);
const MARK = "Übersetzt: ";

const work = mkdtempSync(join(tmpdir(), "mogging-accept-"));
const tarDir = join(work, "tarballs");
const site = join(work, "site");
mkdirSync(tarDir);

/** The accept config: the template's `config` and `starlight` plus an `ai` export whose model is a mock. */
const ACCEPT_CONFIG = `import { defineAiConfig } from "@mogging/ai";
import { MockLanguageModelV3 } from "ai/test";

export { config, starlight } from "./mogging.config.ts";

const MARK = ${JSON.stringify(MARK)};

// A string leaf without a line break (a title, a description) gets the mark; a multi-line leaf (a body) stays as it is,
// because a prefix in front of a body could turn its first heading into a paragraph and fail validation.
const mark = (v) =>
  typeof v === "string" ? (v.includes("\\n") ? v : MARK + v)
  : Array.isArray(v) ? v.map(mark)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mark(x)]))
  : v;

const model = new MockLanguageModelV3({
  doGenerate: async (options) => {
    let user = "";
    for (const m of options.prompt) {
      if (m.role === "user") for (const p of m.content) if (p.type === "text") user += p.text;
    }
    const data = JSON.parse(user.slice("<<<DATA\\n".length, -"\\nDATA>>>".length));
    return {
      content: [{ type: "text", text: JSON.stringify({ fields: mark(data.translate), glossaryTermsUsed: [] }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 50, text: 50, reasoning: undefined },
      },
      warnings: [],
    };
  },
});

export const ai = defineAiConfig({
  provider: { kind: "custom", models: { "mock/translate": model } },
  models: { translate: "mock/translate" },
  prices: { "mock/translate": { inputUsdPerMtok: 1, outputUsdPerMtok: 2, contextTokens: 128000 } },
  budgets: { monthlyCapUsd: 5 },
});
`;

let failed = false;
let schema;
let schemaName = "";
try {
  // 1. Build, pack, copy the template, install.
  const tarballs = buildAndPack(root, tarDir);
  ok(`build and pack ${Object.keys(tarballs).length} tarballs`);
  cpSync(join(root, "templates", "starlight"), site, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes("node_modules") });
  installSite(site, tarballs, { ai: "7.0.154" });
  check(existsSync(join(site, "node_modules", "@mogging", "cli", "dist", "bin.js")), "the installed CLI has no dist/bin.js");
  ok("npm install of the template with the five tarballs");

  // 2. Throwaway schema; the .env carries its URL, and every command runs through the template's own script.
  schema = await throwawaySchema(baseUrl);
  schemaName = new URL(schema.url).searchParams.get("search_path") ?? "";
  writeFileSync(join(site, ".env"), `DATABASE_URL=${schema.url}\n`);
  const mogging = (...args) => sh("npm", ["run", "--silent", "mogging", "--", ...args], { cwd: site, env: siteEnv({}) });
  const moggingJson = (...args) => {
    const out = mogging(...args, "--json");
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`mogging ${args.join(" ")} --json printed no JSON document:\n${out}`);
    }
  };
  const publicBefore = await schema.tables("public");

  // 3. Migrate and import.
  mogging("migrate");
  const inSchema = await schema.tables();
  const publicAfter = await schema.tables("public");
  check(inSchema > 0, `migrate applied no migrations into the throwaway schema`);
  check(publicAfter === publicBefore, `migrate changed the public schema (${publicBefore} -> ${publicAfter} tables): the .env URL was not used`);
  ok(`mogging migrate (${inSchema} tables in the throwaway schema; public has ${publicAfter}, unchanged)`);

  const imported = mogging("import");
  const created = imported.split("\n").filter((l) => l.startsWith("created "));
  check(created.length === 3, `import reported ${created.length} created lines, expected 3:\n${imported}`);
  ok("mogging import (three English files created)");

  // 4. The accept config, with the mock model.
  writeFileSync(join(site, "mogging.accept.config.ts"), ACCEPT_CONFIG);

  // 5. Compile.
  mogging("compile", "--locales", "de,zh-CN", "--budget", "1", "--config", "mogging.accept.config.ts");
  ok("mogging compile (mock model)");

  // 6. Review, approve, release.
  const listed = moggingJson("review", "list");
  const drafts = listed.data.items;
  check(drafts.length === 6, `review list shows ${drafts.length} items, expected 6:\n${JSON.stringify(drafts, null, 2)}`);
  check(drafts.every((d) => d.state === "DRAFT_AI"), `review list holds a state other than DRAFT_AI: ${[...new Set(drafts.map((d) => d.state))].join(", ")}`);
  ok("review list: 6 DRAFT_AI items");

  const approved = moggingJson("review", "--approve-clean");
  check(approved.data.approved === 6, `review --approve-clean approved ${approved.data.approved}, expected 6:\n${JSON.stringify(approved, null, 2)}`);
  ok("review --approve-clean approved 6");

  mogging("release", "create", "accept");
  mogging("release", "add", "accept", "--all-approved");
  mogging("release", "publish", "accept");
  const left = moggingJson("review", "list", "--state", "APPROVED").data.items;
  check(left.length === 0, `${left.length} APPROVED items remain after the release:\n${JSON.stringify(left, null, 2)}`);
  ok("release create, add --all-approved, publish; no APPROVED item remains");

  // 7. Export, a second export, status.
  mogging("export");
  const de = join(site, "src/content/docs/de/guides/getting-started.md");
  const zh = join(site, "src/content/docs/zh-cn/guides/getting-started.md");
  for (const f of [de, zh]) {
    check(existsSync(f), `export did not write ${f}`);
    check(readFileSync(f, "utf8").includes(MARK), `${f} does not contain ${JSON.stringify(MARK)}`);
  }
  check(existsSync(join(site, ".mogging", "manifest.json")), "export did not write .mogging/manifest.json");
  ok("mogging export (de and zh-cn files carry the mark; manifest written)");

  const again = moggingJson("export");
  const actions = again.data.starlight?.actions;
  check(Array.isArray(actions) && actions.length > 0, `the second export reported no actions:\n${JSON.stringify(again, null, 2)}`);
  const notKept = actions.filter((a) => a.action !== "keep");
  check(notKept.length === 0, `the second export rewrote files:\n${JSON.stringify(notKept, null, 2)}`);
  ok(`second mogging export keeps all ${actions.length} files`);

  const rows = moggingJson("status").data.rows.filter((r) => r.locale === "de" || r.locale === "zh-CN");
  for (const locale of ["de", "zh-CN"]) {
    check(rows.some((r) => r.locale === locale && r.state === "current"), `status shows no current row for ${locale}`);
  }
  const bad = rows.filter((r) => r.state === "stale" || r.state === "missing");
  check(bad.length === 0, `status shows stale or missing rows:\n${JSON.stringify(bad, null, 2)}`);
  ok("mogging status: current rows for de and zh-CN, none stale or missing");

  // 8. The site builds, and the translated pages carry the mark.
  sh(join(site, "node_modules", ".bin", "astro"), ["build"], { cwd: site, env: siteEnv({}) });
  for (const p of ["dist/de/guides/getting-started/index.html", "dist/zh-cn/guides/getting-started/index.html"]) {
    const f = join(site, p);
    check(existsSync(f), `astro build did not write ${p}`);
    check(readFileSync(f, "utf8").includes(MARK), `${p} does not contain ${JSON.stringify(MARK)}`);
  }
  const index = join(site, "dist/index.html");
  check(existsSync(index), "astro build did not write dist/index.html");
  check(!readFileSync(index, "utf8").includes(MARK), `dist/index.html contains ${JSON.stringify(MARK)}`);
  ok("astro build (translated pages carry the mark; the English index does not)");
} catch (e) {
  failed = true;
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (schema !== undefined) {
    try {
      await schema.drop();
    } catch (e) {
      failed = true;
      console.error(`FAIL could not drop ${schemaName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  removeLicences(root);
  rmSync(work, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("accept:starlight passed");
