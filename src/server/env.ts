import "server-only";
import { z } from "zod";

/**
 * Validated server environment. This is the only module that reads `process.env`
 * for secrets (Next.js data-security guidance), so a misconfigured deployment
 * fails fast at boot instead of at the first request that needs a value.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url(),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  AUDIT_HMAC_KEY: z.string().min(32, "AUDIT_HMAC_KEY must be at least 32 characters"),
});

export const env = schema.parse(process.env);
export const isProduction = env.NODE_ENV === "production";
