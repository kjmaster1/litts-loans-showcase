import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hardenConnectionString } from "@/lib/db-url";
import { env } from "@/server/env";
import * as schema from "./schema";

/**
 * One pool per server instance. On Vercel Fluid compute, `attachDatabasePool`
 * releases idle clients before the instance is suspended so Neon connections
 * are not leaked. In production DATABASE_URL must be Neon's *pooled* endpoint.
 *
 * We use TCP (node-postgres) rather than Neon's HTTP driver because the ledger
 * needs interactive transactions (SELECT … FOR UPDATE, advisory locks).
 */
const globalForDb = globalThis as unknown as { pgPool?: Pool };

const pool =
  globalForDb.pgPool ??
  new Pool({
    connectionString: hardenConnectionString(env.DATABASE_URL),
    max: 10,
    idleTimeoutMillis: 5_000,
  });

if (env.NODE_ENV !== "production") globalForDb.pgPool = pool;
attachDatabasePool(pool);

export const db = drizzle({ client: pool, schema, casing: "snake_case" });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
