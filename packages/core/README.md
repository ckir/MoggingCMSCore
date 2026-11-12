# @mogging/core

The MoggingCMS engine: a multilingual, Postgres-backed content store with draft/publish versioning,
per-field locale fallback, sync tracking for translations, releases and offline licence keys.

MoggingCMSCore is source-available software under the licence in [LICENSE.md](../../LICENSE.md). It is not
open source. This is a pre-release (v0.1, in development): the package is not yet published to npm.

## Install

Requires Node 22 or newer and PostgreSQL. Until the first release, use the workspace package:

```bash
pnpm install
pnpm add @mogging/core postgres
```

Point the engine at a database with a `DATABASE_URL` such as `postgres://user:password@localhost:5432/mydb`
and pass the connection to every call. `migrate` creates and updates the engine tables.

## Example

```ts
import postgres from "postgres";
import { defineCollection, defineConfig, text, richText, slug } from "@mogging/core";
import { migrate, createDocument, saveDraft, publish, resolve } from "@mogging/core";

const sql = postgres(process.env.DATABASE_URL!);

const posts = defineCollection("posts", {
  slug: slug(),
  title: text({ localized: true }),
  body: richText({ localized: true, body: true }),
});
const config = defineConfig({
  collections: [posts],
  locales: { source: "en", chains: { "de-CH": ["de", "en"], de: ["en"] } },
});
const ctx = { sql, config, actor: "me" };

await migrate(sql);
const { id } = await createDocument(ctx, { collection: "posts" });
await saveDraft(ctx, { docId: id, locale: "shared", data: { slug: "hello" } });
await saveDraft(ctx, { docId: id, locale: "en", data: { title: "Hello", body: "Welcome" } });
await saveDraft(ctx, { docId: id, locale: "de", data: { title: "Hallo" } });
await publish(ctx, { docId: id, locale: "shared" });
await publish(ctx, { docId: id, locale: "en" });
await publish(ctx, { docId: id, locale: "de" });

const [doc] = await resolve(ctx, { collection: "posts", locale: "de-CH" });
// doc.data: { slug: "hello", title: "Hallo", body: "Welcome" }; doc.fellBack: { title: "de", body: "en" }
```

`de-CH` has no German-Swiss text, so `title` falls back to `de` and `body` to `en`; `fellBack` says which.
This example is run as a test (`test/readme.test.ts`), so it matches the real API.

## Licence

MoggingCMSCore is source-available, not open source; the terms are in [LICENSE.md](../../LICENSE.md).

- Evaluation: the first 30 days after the first `migrate` need no key.
- A key: set the `MOGGING_LICENSE_KEY` environment variable, or `license` in `defineConfig`
  (the environment variable wins). Keys are verified offline.
- When the evaluation ends without a valid key, writes and publishing are paused (`LicenceError`
  `LICENCE_REQUIRED`). Reads such as `resolve` and `getDocument` keep working.
- The production Ed25519 public key is embedded in `src/licence/publicKey.ts`. Keys are signed offline with
  the owner's private key and verified against that public key without any network call.
