/**
 * The parts of the Better Auth configuration that shape the database schema.
 * Shared by the runtime config (`auth.ts`) and the schema-generation config
 * (`scripts/auth-cli.config.ts`) so the generated tables can never drift from
 * what the app actually uses. Must not import `server-only`, `db` or `env`.
 */
import type { BetterAuthOptions } from "better-auth";
import { twoFactor, username } from "better-auth/plugins";
import { SESSION_IDLE_SECONDS, SESSION_REFRESH_SECONDS } from "../../lib/session-policy";

export const schemaPlugins = [
  username({ minUsernameLength: 3, maxUsernameLength: 32 }),
  twoFactor({
    issuer: "Litt's Loans",
    skipVerificationOnEnable: false,
    backupCodeOptions: { amount: 10, length: 10 },
  }),
] as const; // tuple type keeps Better Auth's per-plugin type inference

export const sessionOptions = {
  expiresIn: SESSION_IDLE_SECONDS,
  updateAge: SESSION_REFRESH_SECONDS,
  cookieCache: { enabled: false },
  freshAge: 5 * 60,
  additionalFields: {
    /** Last successful step-up (fresh 2FA) — gates sensitive actions (ADR 0002). */
    stepUpAt: { type: "date", required: false, input: false },
  },
} satisfies BetterAuthOptions["session"];

export const rateLimitOptions = {
  enabled: true,
  storage: "database",
  window: 60,
  max: 100,
  customRules: {
    "/sign-in/username": { window: 60, max: 5 },
    "/two-factor/verify-totp": { window: 60, max: 5 },
    "/two-factor/verify-backup-code": { window: 300, max: 5 },
    "/change-password": { window: 300, max: 5 },
    "/passkey/generate-authenticate-options": { window: 60, max: 20 },
    "/passkey/verify-authentication": { window: 60, max: 10 },
  },
} satisfies BetterAuthOptions["rateLimit"];

export const advancedDatabaseOptions = {
  generateId: () => crypto.randomUUID(),
} satisfies NonNullable<BetterAuthOptions["advanced"]>["database"];
