import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

const DEFAULT_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/**
 * Applies `*.sql` files in name order that are not yet recorded in `migrations`, each in its own
 * transaction. The runner creates `migrations` itself (idempotent) before reading it; 0001 also
 * declares it with `if not exists`, so there is no circularity.
 */
export async function migrate(sql: Sql, dir: string = DEFAULT_DIR): Promise<string[]> {
  await sql`create table if not exists migrations (
    name text primary key,
    applied_at timestamptz not null default clock_timestamp()
  )`;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    const body = await readFile(join(dir, name), "utf8");
    const done = await sql.begin(async (tx) => {
      // Serialize concurrent runners; the second sees the row and skips.
      await tx`select pg_advisory_xact_lock(hashtext('mogging_migrate'))`;
      const [row] = await tx`select 1 as x from migrations where name = ${name}`;
      if (row) return false;
      await tx.unsafe(body);
      await tx`insert into migrations (name) values (${name})`;
      return true;
    });
    if (done) applied.push(name);
  }
  return applied;
}
