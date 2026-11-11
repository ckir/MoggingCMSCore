import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { withTestDb } from "./db.js";
// README:IMPORTS
import { defineCollection, defineConfig, text, richText, slug } from "@mogging/core";
import { migrate, createDocument, saveDraft, publish, resolve } from "@mogging/core";
// README:IMPORTS-END

// The README example, verbatim between the markers, run against the real API.
test("README example runs and resolves with locale fallback", async () => withTestDb(async (sql) => {
  // README:START
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
  // README:END
  expect(doc!.data).toEqual({ slug: "hello", title: "Hallo", body: "Welcome" });
  expect(doc!.fellBack).toEqual({ title: "de", body: "en" });
}));

// The README code block must be the code above, so the documented example cannot drift from the tested one.
test("README contains the tested example verbatim", () => {
  const src = readFileSync(new URL("./readme.test.ts", import.meta.url), "utf8");
  const between = (a: string, b: string) => src.split(a)[1]!.split(b)[0]!;
  const imports = between("// README:IMPORTS\n", "// README:IMPORTS-END").trimEnd();
  const body = between("// README:START\n", "  // README:END")
    .split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n").trimEnd();
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain(imports);
  expect(readme).toContain(body);
});
