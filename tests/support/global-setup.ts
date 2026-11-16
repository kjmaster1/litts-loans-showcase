import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Rebuilds the integration test database from the real migrations, so tests
 * exercise exactly the schema (including triggers) that production runs.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://litts:litts_dev_password@localhost:54329/litts_loans_test";
  if (!url.includes("_test")) throw new Error(`Refusing to reset a non-test database: ${url}`);

  const pool = new Pool({ connectionString: url });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}
