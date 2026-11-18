// Pure checks on one packed tarball of a @mogging package, shared by scripts/check-publish-ready.mjs and its tests
// (packages/core/test/publishReady.test.ts). No file or process access here: callers pass the tar listing and the
// two manifests, so every rule can be exercised with a hand-made broken input.

/** Every string value reachable from `value` (a package.json `exports`/`bin` field, or a plain string). */
function strings(value) {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/**
 * The files a packed manifest tells a consumer to load: `main`, `types`, `bin` and every `exports` target.
 * @param {Record<string, unknown>} manifest the manifest as it appears INSIDE the tarball
 * @returns {string[]} package-relative paths without the leading `./`
 */
export function entryFiles(manifest) {
  return [manifest.main, manifest.types, manifest.bin, manifest.exports].flatMap(strings).map((p) => p.replace(/^\.\//, ""));
}

const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/**
 * Checks one tarball against the rules for "this is exactly what we want on npm".
 * @param {{ listing: string[], manifest: Record<string, any>, source: Record<string, any>,
 *   siblings: Map<string, string>, release: boolean }} input `listing`: `tar -t` paths (`package/...`); `manifest`: the
 *   package.json inside the tarball; `source`: the package.json in the repository; `siblings`: name -> source version of
 *   every workspace package; `release`: also demand a publishable (non-private, non-0.0.0) manifest.
 * @returns {string[]} one message per violated rule; empty when the tarball is publishable
 */
export function checkTarball({ listing, manifest, source, siblings, release }) {
  const problems = [];
  const has = (path) => listing.includes(path);
  const hasUnder = (dir) => listing.some((p) => p === `package/${dir}` || p.startsWith(`package/${dir.replace(/\/$/, "")}/`));

  if (!has("package/LICENSE.md")) problems.push("package/LICENSE.md is missing from the tarball");
  if (!has("package/README.md")) problems.push("package/README.md is missing from the tarball");
  for (const p of listing) {
    if (/^package\/(src|test)\//.test(p)) problems.push(`the tarball ships source or tests: ${p}`);
    if (p.endsWith(".tsbuildinfo")) problems.push(`the tarball ships a build cache: ${p}`);
  }
  for (const f of source.files ?? []) {
    if (!hasUnder(f)) problems.push(`"files" entry ${f} has nothing in the tarball`);
  }
  for (const target of [manifest.main, manifest.types, manifest.bin, manifest.exports].flatMap(strings)) {
    if (!target.startsWith("./dist/")) problems.push(`the packed manifest points at ${target}, not at ./dist/`);
  }
  for (const f of entryFiles(manifest)) {
    if (!has(`package/${f}`)) problems.push(`the packed manifest names ${f} but the tarball does not contain it`);
  }
  for (const field of DEP_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (String(range).startsWith("workspace:")) problems.push(`${field}.${name} is still ${range} (the workspace protocol was not rewritten)`);
      else if (siblings.has(name) && range !== siblings.get(name)) {
        problems.push(`${field}.${name} is ${range} but ${name} is at ${siblings.get(name)} in this repository`);
      }
    }
  }
  if (source.publishConfig?.access !== "public") problems.push(`publishConfig.access is not "public" (a scoped package would publish as restricted)`);
  if (typeof manifest.license !== "string" || manifest.license === "") problems.push("the manifest has no license field");
  if (release) {
    if (manifest.private === true) problems.push(`"private": true would make npm refuse to publish it`);
    if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version)) || manifest.version === "0.0.0") {
      problems.push(`version ${manifest.version} is not a release version`);
    }
  }
  return problems;
}
