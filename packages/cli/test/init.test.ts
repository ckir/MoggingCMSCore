import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Sql } from "postgres";
import { run } from "../src/run.js";
import { withTestDb } from "./db.js";
import { connectionOver, testDeps } from "./fixtures.js";

// Not under os.tmpdir(): the written config imports `@mogging/core`, which resolves only from inside a package that
// depends on it (pnpm links workspace packages into packages/*/node_modules; the repository root has no
// node_modules/@mogging).
const CLI_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(CLI_DIR, ".tmp-init-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** `testDeps` minus its `loadModule`, so `run` loads the written file through the real jiti loader. */
function realLoader(sql: Sql, cwd: string, overrides: Parameters<typeof testDeps>[1] = {}) {
  const base = testDeps(sql, { cwd, ...overrides });
  const { loadModule: _stub, ...deps } = base;
  void _stub;
  return { base, deps };
}

const appliedNames = async (sql: Sql) =>
  (await sql`select name from migrations order by name`).map((r) => r.name as string);

describe("mogging init", () => {
  test("init writes mogging.config.ts, runs migrations and prints the applied names", async () => {
    await withTestDb(async (sql) => {
      vi.stubEnv("MOGGING_LICENSE_KEY", "");
      const dir = tempDir();
      const end = vi.fn(async () => {});
      const t = realLoader(sql, dir, { connect: () => connectionOver(sql, end) });
      expect(await run(["init"], t.deps)).toBe(0);

      const file = join(dir, "mogging.config.ts");
      expect(existsSync(file)).toBe(true);
      expect(readdirSync(dir)).toEqual(["mogging.config.ts"]);
      const names = await appliedNames(sql);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(t.base.stdout()).toContain(name);
      expect(t.base.stdout()).toContain(file);
      expect(t.base.stderr()).toContain("MoggingCMS evaluation: 30 days left");
      expect(end).toHaveBeenCalledTimes(1);
    });
  });

  test("the written file loads through the real jiti loader and passes defineConfig", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      const t = realLoader(sql, dir);
      expect(await run(["init"], t.deps)).toBe(0);

      const file = join(dir, "mogging.config.ts");
      const mod = (await createJiti(import.meta.url).import(file)) as {
        config: { collections: Array<{ name: string }>; locales: { source: string; chains: Record<string, string[]> } };
        ai?: unknown;
      };
      expect(mod.config.collections.map((c) => c.name)).toEqual(["docs"]);
      expect(mod.config.locales).toEqual({ source: "en", chains: { de: ["en"] } });
      expect(mod.ai).toBeUndefined();

      const text = readFileSync(file, "utf8");
      expect(text).toContain("defineAiConfig");
      expect(text).toContain("OPENROUTER_API_KEY");
      expect(text).toContain("MOGGING_LICENSE_KEY");
      expect(text).toContain("monthlyCapUsd");
    });
  });

  test("init with an existing mogging.config.ts leaves it byte-identical, says so, and still migrates", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      const file = join(dir, "mogging.config.ts");
      // CRLF, no trailing newline and a non-ASCII byte: any rewrite or normalisation would change the bytes.
      const original = Buffer.from(
        'export const config = { collections: [], locales: { source: "en" } };\r\n// héllo',
        "utf8",
      );
      writeFileSync(file, original);
      const t = realLoader(sql, dir);

      expect(await run(["init"], t.deps)).toBe(0);

      expect(Buffer.compare(readFileSync(file), original)).toBe(0);
      expect(readdirSync(dir)).toEqual(["mogging.config.ts"]);
      expect(t.base.stdout()).toContain("already exists");
      expect(t.base.stdout()).toContain("left unchanged");
      const names = await appliedNames(sql);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(t.base.stdout()).toContain(name);
    });
  });

  test("init --json data is { configCreated, applied } and its licence member is the evaluation state", async () => {
    await withTestDb(async (sql) => {
      vi.stubEnv("MOGGING_LICENSE_KEY", "");
      const dir = tempDir();
      const created = realLoader(sql, dir);
      expect(await run(["init", "--json"], created.deps)).toBe(0);
      const names = await appliedNames(sql);
      const doc = JSON.parse(created.base.stdout()) as {
        ok: boolean; partial: boolean; data: unknown; licence: Record<string, unknown> | null;
      };
      expect(doc.ok).toBe(true);
      expect(doc.partial).toBe(false);
      expect(doc.data).toEqual({ configCreated: true, applied: names });
      expect(doc.licence).toEqual({
        state: "evaluation", daysLeft: 30, warn: false, plan: null, licensee: null, keyError: null,
      });
      expect(created.base.stderr()).toContain("MoggingCMS evaluation: 30 days left");

      const again = realLoader(sql, dir);
      expect(await run(["init", "--json"], again.deps)).toBe(0);
      const second = JSON.parse(again.base.stdout()) as { data: unknown; licence: { state: string } };
      expect(second.data).toEqual({ configCreated: false, applied: [] });
      expect(second.licence.state).toBe("evaluation");
    });
  });

  test("init with no database URL exits 2, writes no file and never connects", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      const connect = vi.fn(() => connectionOver(sql));
      const t = realLoader(sql, dir, { env: {}, connect });
      expect(await run(["init"], t.deps)).toBe(2);
      expect(readdirSync(dir)).toEqual([]);
      expect(connect).not.toHaveBeenCalled();
      expect(t.base.stderr()).toContain("no database URL: set DATABASE_URL");
    });
  });

  test("a dangling mogging.config.ts symlink is not written through; its load failure exits 1", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      const link = join(dir, "mogging.config.ts");
      const target = join(dir, "nowhere.ts");
      symlinkSync(target, link);
      expect(existsSync(link)).toBe(false); // the link really dangles
      const t = realLoader(sql, dir);

      expect(await run(["init"], t.deps)).toBe(1);

      expect(existsSync(target)).toBe(false);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
      expect(readdirSync(dir).sort()).toEqual(["mogging.config.ts"]);
      expect(t.base.stderr()).toMatch(/^error: .+/m);
    });
  });

  test("an existing config that fails to load is that load's own error and is never overwritten", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      const file = join(dir, "mogging.config.ts");
      const original = "export const nothing = 1;\n";
      writeFileSync(file, original);
      const t = realLoader(sql, dir);

      expect(await run(["init"], t.deps)).toBe(2);

      expect(readFileSync(file, "utf8")).toBe(original);
      expect(t.base.stderr()).toContain(file);
      const [row] = await sql`select to_regclass('migrations') as t`;
      expect(row!.t).toBeNull(); // nothing migrated either
    });
  });

  test("--config <path> with no such file writes the template there; an existing one is left alone", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      const custom = join(dir, "site.config.ts");
      const t = realLoader(sql, dir);
      expect(await run(["init", "--config", "site.config.ts", "--json"], t.deps)).toBe(0);
      expect(readdirSync(dir)).toEqual(["site.config.ts"]);
      expect((JSON.parse(t.base.stdout()) as { data: { configCreated: boolean } }).data.configCreated).toBe(true);

      const before = readFileSync(custom);
      const again = realLoader(sql, dir);
      expect(await run(["init", "--config", "site.config.ts", "--json"], again.deps)).toBe(0);
      expect((JSON.parse(again.base.stdout()) as { data: { configCreated: boolean } }).data.configCreated).toBe(false);
      expect(Buffer.compare(readFileSync(custom), before)).toBe(0);
    });
  });

  test("with another config flavour present (mogging.config.mjs) no mogging.config.ts is written", async () => {
    await withTestDb(async (sql) => {
      const dir = tempDir();
      writeFileSync(join(dir, "mogging.config.mjs"), 'export const config = { collections: [], locales: { source: "en" } };\n');
      const t = realLoader(sql, dir);
      expect(await run(["init"], t.deps)).toBe(0);
      expect(readdirSync(dir)).toEqual(["mogging.config.mjs"]);
    });
  });
});
