import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { LicenceError, migrate } from "@mogging/core";
import { withTestDb } from "../db.js";
import { importFolder } from "../../src/import.js";
import type { StarlightImportOptions } from "../../src/import.js";
import { capturingSql, ctxFor, layout, project } from "./fixtures.js";

const D = "src/content/docs";
const page = (title: string, body: string): string => `---\ntitle: ${title}\n---\n${body}\n`;

function put(root: string, rel: string, text: string): void {
  const full = path.join(root, D, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

/** Runs `fn` on a migrated schema whose first migration is 31 days old, with `MOGGING_LICENSE_KEY` unset and restored. */
async function withExpiredLicence(fn: (sql: Sql) => Promise<void>): Promise<void> {
  const saved = process.env.MOGGING_LICENSE_KEY;
  delete process.env.MOGGING_LICENSE_KEY;
  try {
    await withTestDb(async (sql) => {
      await migrate(sql);
      await sql`update migrations set applied_at = now() - interval '31 days'`;
      await fn(sql);
    });
  } finally {
    if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
  }
}

const importWith = (sql: Sql, root: string, starlight: Partial<StarlightImportOptions> = {}, publish = true) =>
  importFolder(ctxFor(sql), { dir: root, publish, starlight: { layout, ...starlight } });

const countDocuments = async (sql: Sql): Promise<number> =>
  Number((await sql`select count(*)::int as n from documents`)[0]!["n"]);

describe("the licence guard of a Starlight import", () => {
  it("a dry run of new files writes nothing and needs no licence", async () => {
    await withExpiredLicence(async (sql) => {
      const root = project({});
      put(root, "a.md", page("A", "English a"));
      put(root, "de/a.md", page("a-de", "Deutsch a"));
      const r = await importWith(sql, root, { dryRun: true });
      expect(r.starlight!.dryRun).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.files.find((f) => f.file === `${D}/a.md`)!.outcome).toBe("created");
      expect(await countDocuments(sql)).toBe(0);
    });
  });

  it("an import where every file is unchanged succeeds after the licence expired", async () => {
    const saved = process.env.MOGGING_LICENSE_KEY;
    delete process.env.MOGGING_LICENSE_KEY;
    try {
      await withTestDb(async (sql) => {
        await migrate(sql);
        const root = project({});
        put(root, "a.md", page("A", "English a"));
        put(root, "de/a.md", page("a-de", "Deutsch a"));
        const first = await importWith(sql, root);
        expect(first.errors).toEqual([]);
        await sql`update migrations set applied_at = now() - interval '31 days'`;
        const again = await importWith(sql, root);
        expect(again.errors).toEqual([]);
        expect(again.files.map((f) => f.outcome)).toEqual(["unchanged", "unchanged"]);
      });
    } finally {
      if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
    }
  });

  it("a prune-only run succeeds after the licence expired", async () => {
    const saved = process.env.MOGGING_LICENSE_KEY;
    delete process.env.MOGGING_LICENSE_KEY;
    try {
      await withTestDb(async (sql) => {
        await migrate(sql);
        const root = project({});
        put(root, "a.md", page("A", "English a"));
        put(root, "b.md", page("B", "English b"));
        expect((await importWith(sql, root)).errors).toEqual([]);
        await sql`update migrations set applied_at = now() - interval '31 days'`;
        fs.rmSync(path.join(root, D, "b.md"));
        const r = await importWith(sql, root, { prune: true });
        expect(r.starlight!.pruned).toEqual(["b"]);
        const [{ n }] = (await sql`select count(*)::int as n from documents where deleted_at is not null`) as unknown as [{ n: number }];
        expect(n).toBe(1);
      });
    } finally {
      if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
    }
  });

  it("one new page rejects with LicenceError and leaves no document row", async () => {
    await withExpiredLicence(async (sql) => {
      const root = project({});
      put(root, "a.md", page("A", "English a"));
      await expect(importWith(sql, root)).rejects.toBeInstanceOf(LicenceError);
      expect(await countDocuments(sql)).toBe(0);
    });
  });

  it("a valid licence makes exactly one licence read for the whole import", async () => {
    const saved = process.env.MOGGING_LICENSE_KEY;
    delete process.env.MOGGING_LICENSE_KEY;
    try {
      await withTestDb(async (sql) => {
        await migrate(sql);
        const cap = await capturingSql(sql);
        try {
          const root = project({});
          for (const s of ["a", "b", "c"]) {
            put(root, `${s}.md`, page(s.toUpperCase(), `English ${s}`));
            put(root, `de/${s}.md`, page(`${s}-de`, `Deutsch ${s}`));
            put(root, `zh-cn/${s}.md`, page(`${s}-zh`, `Chinese ${s}`));
          }
          const r = await importFolder(ctxFor(cap.sql), { dir: root, publish: true, starlight: { layout } });
          expect(r.errors).toEqual([]);
          expect(r.files.filter((f) => f.outcome === "created")).toHaveLength(3);
          // The raw log, not the transactions: the licence read runs before the first `begin`.
          const reads = cap.statements().filter((x) => /from migrations/i.test(x));
          expect(reads).toHaveLength(1);
        } finally {
          await cap.sql.end();
        }
      });
    } finally {
      if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
    }
  });

  it("a locale-only import with an expired licence rejects with LicenceError and writes no locale row", async () => {
    const saved = process.env.MOGGING_LICENSE_KEY;
    delete process.env.MOGGING_LICENSE_KEY;
    try {
      await withTestDb(async (sql) => {
        await migrate(sql);
        const root = project({});
        put(root, "a.md", page("A", "English a"));
        put(root, "de/a.md", page("a-de", "Deutsch a"));
        expect((await importWith(sql, root)).errors).toEqual([]);
        const rows = async (): Promise<number> => Number((await sql`select count(*)::int as n from document_localized`)[0]!["n"]);
        const before = await rows();
        await sql`update migrations set applied_at = now() - interval '31 days'`;
        put(root, "de/a.md", page("a-de-2", "Deutsch a zwei"));
        await expect(importWith(sql, root)).rejects.toBeInstanceOf(LicenceError);
        expect(await rows()).toBe(before);
      });
    } finally {
      if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
    }
  });

  it("a one-off failure of the licence read costs one file, and the guard is retried by the next", async () => {
    const saved = process.env.MOGGING_LICENSE_KEY;
    delete process.env.MOGGING_LICENSE_KEY;
    try {
      await withTestDb(async (sql) => {
        await migrate(sql);
        let reads = 0;
        // Intercepts only the tagged-template call; `begin` and the rest pass through to the real connection.
        const flaky = new Proxy(sql, {
          apply(target, thisArg, args) {
            const strings = args[0] as unknown;
            const text = Array.isArray(strings) ? (strings as string[]).join("?") : "";
            if (/from migrations/i.test(text)) {
              reads++;
              if (reads === 1) throw new Error("boom");
            }
            return Reflect.apply(target, thisArg, args);
          },
        });
        const root = project({});
        for (const s of ["a", "b", "c"]) put(root, `${s}.md`, page(s.toUpperCase(), `English ${s}`));
        const r = await importFolder(ctxFor(flaky), { dir: root, publish: true, starlight: { layout } });
        const byOutcome = (o: string) => r.files.filter((f) => f.outcome === o).map((f) => f.file);
        expect(byOutcome("error")).toEqual([`${D}/a.md`]);
        expect(r.errors.map((e) => e.message)).toEqual([expect.stringContaining("boom")]);
        expect(byOutcome("created")).toEqual([`${D}/b.md`, `${D}/c.md`]);
        expect(reads, "one failed read, one successful read").toBe(2);
      });
    } finally {
      if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
    }
  });

  it("an actor with U+0000 on a locale-only import makes each changed locale file an error and writes nothing", async () => {
    const saved = process.env.MOGGING_LICENSE_KEY;
    delete process.env.MOGGING_LICENSE_KEY;
    try {
      await withTestDb(async (sql) => {
        await migrate(sql);
        const root = project({});
        for (const s of ["a", "b"]) {
          put(root, `${s}.md`, page(s.toUpperCase(), `English ${s}`));
          put(root, `de/${s}.md`, page(`${s}-de`, `Deutsch ${s}`));
        }
        expect((await importWith(sql, root)).errors).toEqual([]);
        const rows = async (): Promise<number> => Number((await sql`select count(*)::int as n from document_localized`)[0]!["n"]);
        const before = await rows();
        for (const s of ["a", "b"]) put(root, `de/${s}.md`, page(`${s}-de-2`, `Deutsch ${s} zwei`));
        const r = await importFolder(ctxFor(sql, "bad\u0000actor"), { dir: root, publish: true, starlight: { layout } });
        expect(r.files.filter((f) => f.outcome === "error").map((f) => f.file)).toEqual([`${D}/de/a.md`, `${D}/de/b.md`]);
        expect(r.errors).toHaveLength(2);
        expect(await rows()).toBe(before);
      });
    } finally {
      if (saved !== undefined) process.env.MOGGING_LICENSE_KEY = saved;
    }
  });
});
