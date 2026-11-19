import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { migrate, saveDraft } from "@mogging/core";
import { importFolder } from "../../src/import.js";
import { withTestDb } from "../db.js";
import { capturingSql, ctxFor, layout, project } from "./fixtures.js";
import { CLOCK_READ, ROW_LOCK, SLUG_LOCK, firstIndex, splitTransactions } from "./statementKinds.js";

const D = "src/content/docs";
const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "statement-sequences.json");
const golden = (): Record<string, string[]> =>
  (JSON.parse(fs.readFileSync(goldenPath, "utf8")) as { kinds: Record<string, string[]> }).kinds;

/** A source page file: `extra` goes into the front matter after the title. */
const page = (title: string, body: string, extra = ""): string => `---\ntitle: ${title}\n${extra}---\n${body}\n`;

function put(root: string, rel: string, text: string): void {
  const full = path.join(root, D, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

/** The ordering contract of any write transaction: row lock first, then clock and slug lock; no savepoint. */
function expectOrdered(tx: string[], label: string): void {
  expect(tx[0], `${label}: begin is first`).toBe("begin");
  expect(tx[tx.length - 1], `${label}: commit is last`).toBe("commit");
  const lock = firstIndex(tx, ROW_LOCK);
  const clock = firstIndex(tx, CLOCK_READ);
  const slug = firstIndex(tx, SLUG_LOCK);
  expect(lock, `${label}: the documents row lock is taken`).toBeGreaterThan(0);
  expect(clock, `${label}: the clock is read`).toBeGreaterThan(0);
  expect(lock, `${label}: the row lock comes before the clock read`).toBeLessThan(clock);
  if (slug !== -1) expect(lock, `${label}: the row lock comes before the slug lock`).toBeLessThan(slug);
  expect(tx.some((x) => /savepoint/i.test(x)), `${label}: no savepoint`).toBe(false);
  expect(tx.some((x) => /from migrations/i.test(x)), `${label}: the licence read is outside the transaction`).toBe(false);
}

/**
 * The source-page transactions the three-phase scenario never reaches: it creates its English pages and then leaves
 * them alone, so the `alreadyLocked: false` publish of `applySource` and the edit of an existing page are unpinned
 * there. No locale file is present in these projects, so every transaction below is a source-phase one; the content
 * classifier of `statementKinds.ts` is not used (it would call an edit of an existing page a locale transaction).
 */
describe("source transactions of an existing page", () => {
  async function setup(fn: (sql: Sql, cap: Awaited<ReturnType<typeof capturingSql>>) => Promise<void>): Promise<void> {
    await withTestDb(async (sql) => {
      await migrate(sql);
      const cap = await capturingSql(sql);
      try {
        await fn(sql, cap);
      } finally {
        await cap.sql.end();
      }
    });
  }

  it("(i) an English page edited in both scopes: save and publish of each, one transaction", async () => {
    await setup(async (sql, cap) => {
      const root = project({});
      put(root, "p.md", page("P", "body one"));
      await importFolder(ctxFor(sql), { dir: root, publish: true, starlight: { layout } });
      put(root, "p.md", page("P2", "body two", "sidebar:\n  order: 3\n"));
      cap.reset();
      const r = await importFolder(ctxFor(cap.sql), { dir: root, publish: true, starlight: { layout } });
      expect(r.files.find((f) => f.file === `${D}/p.md`)).toMatchObject({ outcome: "updated", published: true });

      const txs = splitTransactions(cap.statements());
      expect(txs).toHaveLength(1);
      const tx = txs[0]!;
      expectOrdered(tx, "existing page edited");
      // The same statements as the new-page transaction without the `insert into documents` that opens it.
      expect(tx).toEqual(["begin", ...golden()["source"]!.slice(2)]);
      expect(tx).toHaveLength(24);
    });
  });

  it("(ii) an English scope whose draft head already matches the file: a publish with no save, row lock taken by the publish", async () => {
    await setup(async (sql, cap) => {
      const root = project({});
      put(root, "p.md", page("P", "body one"));
      put(root, "q.md", page("P2", "body two"));
      await importFolder(ctxFor(sql), { dir: root, publish: true, starlight: { layout } });
      // q's published English data is exactly what p.md will hold after the edit; park it as p's draft head through
      // core, so `decide` sees a publishable draft with the file's hash and plans a publish and no save.
      const [q] = (await sql`
        select l.data from document_localized l join document_shared s on s.doc_id = l.doc_id
         where s.data->>'slug' = 'q' and l.locale = 'en' and l.is_head_published`) as unknown as Array<{ data: Record<string, unknown> }>;
      const [p] = (await sql`select doc_id from document_shared where data->>'slug' = 'p' and is_head_published`) as unknown as Array<{ doc_id: string }>;
      await saveDraft(ctxFor(sql), { docId: p!.doc_id, locale: "en", data: q!.data });
      put(root, "p.md", page("P2", "body two"));
      cap.reset();
      const r = await importFolder(ctxFor(cap.sql), { dir: root, publish: true, starlight: { layout } });
      expect(r.files.find((f) => f.file === `${D}/p.md`)).toMatchObject({ outcome: "updated", published: true });
      expect(r.files.find((f) => f.file === `${D}/q.md`)).toMatchObject({ outcome: "unchanged" });

      const txs = splitTransactions(cap.statements());
      expect(txs).toHaveLength(1);
      const tx = txs[0]!;
      expectOrdered(tx, "existing page, publish only");
      expect(tx.some((x) => /insert into document_/.test(x)), "no save").toBe(false);
      // The same statements as the locale publish-only transaction: one lock, one clock read, one publish.
      expect(tx).toEqual(golden()["locale-publish-only"]);
      expect(tx).toHaveLength(8);
    });
  });
});
