// Existing-adopter acceptance run (spec 7): copies scripts/fixtures/starlight-adopter (a Starlight site with
// hand-made German translations and no MoggingCMS configuration) outside the repository, installs the packed packages
// into it and drives the real CLI against a throwaway schema: init --starlight, the day-one import, a follows-English
// change with an export, a rename, a second export, a check that no hand-written text changed, and astro build.
// Needs the npm registry; not part of `pnpm test`. Usage: DATABASE_URL=postgres://... pnpm accept:adopter
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildAndPack, check, installSite, removeLicences, requireFrom, root, sh, siteEnv, throwawaySchema } from "./lib/packed.mjs";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL is not set: point it at the test database (docs/dev-setup.md)");
  process.exit(2);
}

const ok = (step) => console.log(`OK   ${step}`);

const work = mkdtempSync(join(tmpdir(), "mogging-adopter-"));
const tarDir = join(work, "tarballs");
const site = join(work, "site");
mkdirSync(tarDir);

const DOCS = "src/content/docs";
const doc = (rel) => join(site, DOCS, rel);
const read = (rel) => readFileSync(doc(rel), "utf8");

/** Every file under a folder, as folder-relative POSIX paths. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"))
    .sort();
}

/** Splits a page into its parsed front matter and its body, with `\r\n` read as `\n`. */
function parsePage(yaml, text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  check(m !== null, `no front matter in:\n${text}`);
  return { front: yaml.parse(m[1]) ?? {}, body: m[2].trim() };
}

/** The localized front-matter values a translator wrote (spec 5.4: only these must survive an export). */
function localizedValues(front) {
  return {
    title: front.title,
    description: front.description,
    label: front.sidebar?.label,
    badge: front.sidebar?.badge,
    heroTitle: front.hero?.title,
    heroTagline: front.hero?.tagline,
    actions: (front.hero?.actions ?? []).map((a) => a.text),
  };
}

let failed = false;
let schema;
let schemaName = "";
try {
  // 1. Build, pack, copy the fixture, make one German file CRLF, install, record the German texts.
  const tarballs = buildAndPack(root, tarDir);
  ok(`build and pack ${Object.keys(tarballs).length} tarballs`);
  cpSync(join(root, "scripts", "fixtures", "starlight-adopter"), site, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes("node_modules"),
  });
  const setupFile = doc("de/guides/setup.md");
  writeFileSync(setupFile, readFileSync(setupFile, "utf8").replace(/\r?\n/g, "\r\n"));
  check(readFileSync(setupFile, "utf8").includes("\r\n"), "de/guides/setup.md has no CRLF line endings");
  installSite(site, tarballs, {});
  const bin = join(site, "node_modules", ".bin", "mogging");
  check(existsSync(bin), "the install has no node_modules/.bin/mogging");
  ok("npm install of the fixture with the five tarballs");

  const yaml = await requireFrom(root, "markdown", "yaml");
  const germanBefore = new Map(filesUnder(doc("de")).map((f) => [f, readFileSync(doc(`de/${f}`))]));
  check(germanBefore.size === 6, `the fixture has ${germanBefore.size} German files, expected 6: ${[...germanBefore.keys()].join(", ")}`);
  ok(`recorded ${germanBefore.size} German files`);

  schema = await throwawaySchema(baseUrl);
  schemaName = new URL(schema.url).searchParams.get("search_path") ?? "";
  const env = siteEnv({ DATABASE_URL: schema.url });
  const mogging = (...args) => sh(bin, args, { cwd: site, env });
  const moggingJson = (...args) => {
    const out = mogging(...args, "--json");
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`mogging ${args.join(" ")} --json printed no JSON document:\n${out}`);
    }
  };
  const publicBefore = await schema.tables("public");

  // 2. init --starlight.
  check(!existsSync(join(site, "mogging.config.ts")), "the fixture already has a mogging.config.ts");
  mogging("init", "--starlight");
  const config = readFileSync(join(site, "mogging.config.ts"), "utf8");
  check(/chains:\s*\{\s*"de":\s*\["en"\]\s*\}/.test(config), `mogging.config.ts has no \`chains: { "de": ["en"] }\`:\n${config}`);
  const inSchema = await schema.tables();
  const publicAfter = await schema.tables("public");
  check(inSchema > 0, "init --starlight applied no migrations into the throwaway schema");
  check(publicAfter === publicBefore, `init changed the public schema (${publicBefore} -> ${publicAfter} tables)`);
  ok(`mogging init --starlight (config written; ${inSchema} tables in the throwaway schema; public has ${publicAfter}, unchanged)`);

  // 3. The day-one import.
  const imported = mogging("import");
  const lines = imported.split("\n");
  const outcome = (file) => lines.find((l) => l.endsWith(` ${DOCS}/${file}`));
  for (const f of ["index.mdx", "guides/setup.md", "guides/images.md", "guides/components.mdx", "reference/levels.md", "guides/wip.md"]) {
    check(outcome(f)?.startsWith("created "), `import did not report \`created ${DOCS}/${f}\`:\n${imported}`);
  }
  // A day-one locale file is reported `updated`: the English file of the same page created the document first.
  for (const f of germanBefore.keys()) {
    check(outcome(`de/${f}`)?.startsWith("updated "), `import did not report \`updated ${DOCS}/de/${f}\`:\n${imported}`);
  }
  const wipWarning = lines.filter((l) => l.startsWith("warning: ") && l.includes(`${DOCS}/de/guides/wip.md`));
  check(wipWarning.length === 1, `import has ${wipWarning.length} warning lines for de/guides/wip.md, expected 1:\n${imported}`);
  const wip = mogging("query", "docs/guides/wip", "--raw");
  check(/^de draft /m.test(wip) && !/^de published /m.test(wip), `de/guides/wip.md is not an unpublished draft:\n${wip}`);
  check(/^en published /m.test(wip), `English guides/wip.md is not published:\n${wip}`);
  for (const slug of ["guides/setup", "guides/images", "guides/components", "reference/levels"]) {
    const raw = mogging("query", `docs/${slug}`, "--raw");
    check(/^de published /m.test(raw), `de/${slug} is not published:\n${raw}`);
  }
  ok("mogging import (English created, German updated and published; the German draft warned about and not published)");

  // 4. A follows-English change, imported and exported.
  for (const f of ["guides/images.md", "guides/components.mdx"]) {
    const text = read(f);
    check(!/^sidebar:/m.test(text), `English ${f} already has a sidebar key`);
    writeFileSync(doc(f), text.replace(/\n---\n/, "\nsidebar:\n  order: 5\n---\n"));
    check(/^sidebar:\n {2}order: 5$/m.test(read(f)), `could not add sidebar.order to ${f}`);
  }
  mogging("import");
  mogging("export");
  const images = read("de/guides/images.md");
  check(images.includes("![Diagramm](../../guides/diagram.svg)"), `de/guides/images.md lost the reference:\n${images}`);
  const components = read("de/guides/components.mdx");
  for (const line of ["import Note from '../../../../components/Note.astro';", "import { Card } from '@astrojs/starlight/components';"]) {
    check(components.includes(line), `de/guides/components.mdx does not contain ${line}:\n${components}`);
  }
  for (const [f, text] of [["images.md", images], ["components.mdx", components]]) {
    check(parsePage(yaml, text).front.sidebar?.order === 5, `de/guides/${f} does not carry sidebar.order 5:\n${text}`);
  }
  ok("mogging import, export (rebased references exact; sidebar.order 5 reached the German files)");

  // 5. Rename.
  const renamed = mogging("rename", "guides/setup", "guides/installation");
  check(renamed.split("\n").some((l) => l.startsWith("reference astro.config.mjs:")), `rename listed no \`reference astro.config.mjs:\` line:\n${renamed}`);
  const astroConfig = join(site, "astro.config.mjs");
  const astroText = readFileSync(astroConfig, "utf8");
  check(/slug:\s*['"]guides\/setup['"]/.test(astroText), "astro.config.mjs has no sidebar slug guides/setup");
  writeFileSync(astroConfig, astroText.replace(/(slug:\s*['"])guides\/setup(['"])/, "$1guides/installation$2"));
  check(existsSync(doc("de/guides/installation.md")), "rename did not create de/guides/installation.md");
  check(!existsSync(doc("de/guides/setup.md")), "rename left de/guides/setup.md in place");
  ok("mogging rename (astro.config reference listed and edited; the German file moved)");

  // 6. A second export.
  mogging("export");
  check(existsSync(doc("de/guides/installation.md")) && !existsSync(doc("de/guides/setup.md")), "the second export changed the renamed German files");
  ok("mogging export (after the rename)");

  // 7. No hand-written text changed.
  for (const [f, before] of germanBefore) {
    const now = f === "guides/setup.md" ? "guides/installation.md" : f;
    const after = readFileSync(doc(`de/${now}`));
    if (f === "guides/wip.md") {
      check(Buffer.compare(before, after) === 0, `de/${f} is not byte-identical:\n${after.toString("utf8")}`);
      continue;
    }
    const was = parsePage(yaml, before.toString("utf8"));
    const is = parsePage(yaml, after.toString("utf8"));
    check(is.body === was.body, `the body of de/${now} changed:\n--- before\n${was.body}\n--- after\n${is.body}`);
    const [a, b] = [localizedValues(was.front), localizedValues(is.front)];
    check(JSON.stringify(a) === JSON.stringify(b), `the localized front matter of de/${now} changed:\n${JSON.stringify(a)}\n${JSON.stringify(b)}`);
  }
  check(parsePage(yaml, read("de/reference/levels.md")).front.difficulty === "beginner", "de/reference/levels.md lost difficulty: beginner");
  ok("no hand-written German text changed (bodies, localized front matter; wip.md byte-identical; difficulty kept)");

  // 8. The site builds, with the page title, the image and the draft fallback.
  sh(join(site, "node_modules", ".bin", "astro"), ["build"], { cwd: site, env: siteEnv({}) });
  const dist = (p) => {
    const f = join(site, "dist", p);
    check(existsSync(f), `astro build did not write dist/${p}`);
    return readFileSync(f, "utf8");
  };
  check(/<h1[^>]*>[\s\S]*?Einrichtung[\s\S]*?<\/h1>/.test(dist("de/guides/installation/index.html")), "dist/de/guides/installation/index.html has no Einrichtung inside <h1");
  check(dist("de/guides/images/index.html").includes("<img"), "dist/de/guides/images/index.html has no <img");
  const wipHtml = dist("de/guides/wip/index.html");
  check(wipHtml.includes("This English page is published and complete."), "dist/de/guides/wip/index.html is not the English fallback page");
  check(!wipHtml.includes("Diese deutsche Seite ist noch ein unveröffentlichter Entwurf"), "dist/de/guides/wip/index.html shows the German draft");
  ok("astro build (German title, image, draft falls back to English)");
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
console.log("accept:adopter passed");
