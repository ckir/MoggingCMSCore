import { expect, test } from "vitest";
import postgres from "postgres";
import { withTestDb } from "./db.js";

test("connects and runs inside an isolated schema, and drops it afterwards", async () => {
  let name = "";
  await withTestDb(async (sql) => {
    const [{ schema }] = await sql`select current_schema() as schema`;
    expect(schema).toMatch(/^t_[a-z0-9]{8}$/);
    name = schema;
  });
  const sql = postgres(process.env.DATABASE_URL!);
  const rows = await sql`select 1 from pg_namespace where nspname = ${name}`;
  expect(rows).toHaveLength(0);
  await sql.end();
});
