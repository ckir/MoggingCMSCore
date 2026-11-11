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
