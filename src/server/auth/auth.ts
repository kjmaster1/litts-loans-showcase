import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { haveIBeenPwned } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import * as schema from "@/server/db/schema";
import { env, isProduction } from "@/server/env";
import { authAuditAfterHook, authAuditBeforeHook } from "./audit-hook";
import { currentInviteContext } from "./invite-context";
import { advancedDatabaseOptions, rateLimitOptions, schemaPlugins, sessionOptions } from "./shared-options";

export const AUTH_COOKIE_PREFIX = "litts";

/**
 * Better Auth handles credentials, TOTP and sessions only. Authorization (roles,
 * ownership) lives in `src/server/authz` against the `staff` table.
 *
 * Security posture (SPEC §8, OWASP ASVS L2 / NIST 800-63B-4 AAL2):
 * - invite-only: public sign-up and every self-service route we don't use are
 *   disabled at the router; account creation also requires an invite context.
 * - passwords: 12–128 chars, no composition rules, breached-password check.
 * - sessions: 60 min sliding idle timeout (absolute 12 h enforced in
 *   `session.ts`), no cookie cache so revocation is immediate.
 * - TOTP is mandatory: enforced by `requireStaff()` before any app page/action.
 */
export const auth = betterAuth({
  appName: "Litt's Loans",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(db, { provider: "pg", schema }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    // Invite acceptance creates the user, links + activates the staff record,
    // then signs in explicitly — so the session hook below sees an active member.
    autoSignIn: false,
  },

  // Routes this app never exposes over HTTP. Server-side `auth.api.*` calls are
  // unaffected (verified in better-auth's router: the check lives in onRequest).
  disabledPaths: [
    "/sign-up/email",
    "/sign-in/email",
    "/sign-in/social",
    "/forget-password",
    "/request-password-reset",
    "/reset-password",
    "/change-email",
    "/update-user",
    "/delete-user",
    "/send-verification-email",
    "/verify-email",
    "/is-username-available",
    // Session listing returns raw tokens to the browser; we expose our own
    // token-free session management via Server Actions instead.
    "/list-sessions",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
    // 2FA is mandatory: it can't be switched off, and the secret is only shown at enrolment.
    "/two-factor/disable",
    "/two-factor/get-totp-uri",
    "/two-factor/send-otp",
    "/two-factor/verify-otp",
  ],

  session: sessionOptions,
  rateLimit: rateLimitOptions,

  advanced: {
    cookiePrefix: AUTH_COOKIE_PREFIX,
    useSecureCookies: isProduction,
    defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
    database: advancedDatabaseOptions,
  },

  hooks: { before: authAuditBeforeHook, after: authAuditAfterHook },

  databaseHooks: {
    user: {
      create: {
        async before() {
          if (!currentInviteContext()) {
            throw new APIError("FORBIDDEN", { message: "Accounts can only be created from an invite." });
          }
        },
      },
    },
    session: {
      create: {
        // A login only succeeds for an *active* staff record, so suspending or
        // marking someone departed blocks new sessions even before revocation.
        async before(session) {
          const member = await db.query.staff.findFirst({
            columns: { id: true },
            where: and(eq(schema.staff.userId, session.userId), eq(schema.staff.status, "active")),
          });
          if (!member) {
            throw new APIError("FORBIDDEN", { message: "This account is not active." });
          }
        },
      },
    },
  },

  plugins: [
    ...schemaPlugins,
    // Passkeys: an alternative to password + authenticator code (research/09). They
    // must verify the person (fingerprint, face or PIN) — enforced in audit-hook.ts —
    // and adding one needs a fresh step-up.
    passkey({
      rpID: new URL(env.BETTER_AUTH_URL).hostname,
      rpName: "Litt's Loans",
      origin: env.BETTER_AUTH_URL,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    }),
    haveIBeenPwned({
      enabled: env.NODE_ENV !== "test",
      customPasswordCompromisedMessage:
        "This password has appeared in a known data breach. Please choose a different one.",
    }),
    nextCookies(), // must stay last
  ],
});

export type AuthSession = typeof auth.$Infer.Session;
