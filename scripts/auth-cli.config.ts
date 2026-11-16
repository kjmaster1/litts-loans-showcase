/**
 * Schema-generation-only Better Auth config for `pnpm auth:generate`.
 * The Better Auth CLI cannot load modules that import `server-only`, so this
 * mirrors the runtime config using the shared schema-shaping options.
 */
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  advancedDatabaseOptions,
  rateLimitOptions,
  schemaPlugins,
  sessionOptions,
} from "../src/server/auth/shared-options";

export const auth = betterAuth({
  database: drizzleAdapter(drizzle.mock(), { provider: "pg" }),
  emailAndPassword: { enabled: true },
  session: sessionOptions,
  rateLimit: rateLimitOptions,
  advanced: { database: advancedDatabaseOptions },
  plugins: [...schemaPlugins, passkey()],
});
