# Releasing to npm

The owner publishes by hand. Nothing here is run by CI, and no agent publishes. Until the release commit the packages stay
`"private": true` at `0.0.0`, so an accidental `pnpm publish` fails instead of shipping.

## One-time

1. Confirm the `@mogging` scope on npm is registered to you (`npm view @mogging/core` returning 404 only shows that nothing
   is published, not who owns the scope). Create the `mogging` org or user scope first if it is not yours.
2. `npm whoami` shows your account and the account can publish to that scope (two-factor authentication on).
3. The gate numbers are written in `docs/superpowers/gates/v0.1.md` (roadmap section 7) and the checkout, key delivery
   and operations of ship step 4 are live. The packages' READMEs promise them.

## Every release

All five packages are released together at one version (the first is `0.1.0`).

1. **Release commit on `main`.** In each of `packages/{core,markdown,ai,cli,starlight}/package.json` remove
   `"private": true` and set the same `"version"`. Commit it; the working tree must be clean.
2. **Tests green.** `pnpm typecheck && pnpm test` (needs `DATABASE_URL`) and `pnpm smoke:pack`. CI on the release commit is green.
3. **Final check, keeping the tarballs.** `pnpm check:publish --release --out /tmp/mogging-release`.
   Each package's `prepack` rebuilds `dist` from the release commit, and the check fails if a package is still
   private, still `0.0.0`, at a different version from the others, or has anything wrong in its tarball. Read the `OK` lines.
4. **Publish exactly those tarballs, in dependency order:**

   ```bash
   cd /tmp/mogging-release
   npm publish ./mogging-core-<version>.tgz     --access public
   npm publish ./mogging-markdown-<version>.tgz --access public
   npm publish ./mogging-ai-<version>.tgz       --access public
   npm publish ./mogging-cli-<version>.tgz      --access public
   npm publish ./mogging-starlight-<version>.tgz --access public
   ```

   Publish the files from step 3, never a fresh `pnpm publish` from a package folder: the files you checked are the files
   that ship. `--provenance` is not available from a local machine (it needs a CI identity token).
5. **Verify.** `npm view @mogging/core version` for each package; install `@mogging/cli` into an empty folder and run
   `mogging --version`.
6. **Tag.** `git tag -a v<version> -m "v<version>"` on the release commit and push it only with the owner's word.

A published version cannot be reused. A bad release is fixed by publishing the next patch version and running `npm deprecate` on the bad one.
