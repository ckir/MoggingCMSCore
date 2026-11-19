import postgres, { type Sql } from "postgres";
import { randomBytes } from "node:crypto";

export async function withTestDb(fn: (sql: Sql) => Promise<void>): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. See docs/dev-setup.md to create the test database.");
  }
  const schema = "t_" + randomBytes(4).toString("hex");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`set search_path to ${schema}`);
    await fn(sql);
  } finally {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  }
}

/**
 * Like {@link withTestDb} but on a pool of up to `max` connections, so a test can write concurrently. The schema is
 * created on a separate admin connection (`max: 1`); the pool pins it with the `search_path` connection parameter,
 * which every pooled connection gets. Migrations are not applied: call `migrate(sql)` as with `withTestDb`. The pool
 * is ended before the schema is dropped.
 *
 * @param max - The pool size.
 * @param fn - The test body, given the pool.
 * @returns A promise that settles after the pool is ended and the schema dropped.
 */
export async function withPooledTestDb(max: number, fn: (sql: Sql) => Promise<void>): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. See docs/dev-setup.md to create the test database.");
  }
  const schema = "t_" + randomBytes(4).toString("hex");
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  let pool: Sql | null = null;
  try {
    await admin.unsafe(`create schema ${schema}`);
    pool = postgres(url, { max, connection: { search_path: schema }, onnotice: () => {} });
    await fn(pool);
  } finally {
    try {
      if (pool !== null) await pool.end();
    } finally {
      try {
        await admin.unsafe(`drop schema if exists ${schema} cascade`);
      } finally {
        await admin.end();
      }
    }
  }
}
