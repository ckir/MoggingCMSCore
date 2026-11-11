import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Sql } from "postgres";
import { defineCollection, defineConfig, list, number, reference, richText, slug, text } from "@mogging/core";
import type { Ctx } from "@mogging/core";

export const docs = defineCollection("docs", {
  slug: slug(),
  title: text({ localized: true }),
  description: text({ localized: true }),
  banner: text({ localized: true }),
  summary: richText({ localized: true }),
  tags: list(text(), { localized: true }),
  author: reference("people"),
  related: list(reference("docs")),
  order: number(),
  body: richText({ localized: true, body: true }),
});

export const people = defineCollection("people", {
  slug: slug(),
  name: text(),
  body: richText({ localized: true, body: true }),
});

export const config = defineConfig({
  collections: [docs, people],
  locales: { source: "en", chains: { de: ["en"] } },
});

export const ctxFor = (sql: Sql, actor = "tester"): Ctx => ({ sql, config, actor });

/** Writes `files` (POSIX relative path -> content) under a fresh temp directory and returns its path. */
export function writeTree(root: string | null, files: Record<string, string>): string {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "mog-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
