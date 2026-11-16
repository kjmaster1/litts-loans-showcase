# Security controls

Target: OWASP ASVS 5.0 Level 2, NIST SP 800-63B-4 AAL2. This file lists what is
**implemented and tested** (✅), and what is **planned** (⏳) with its phase.

## Authentication

| Control | Status | Where / test |
|---|---|---|
| Invite-only accounts; public sign-up route disabled | ✅ | `auth.ts` `disabledPaths`; `auth.test.ts` |
| Account creation also requires an invite context (defence in depth) | ✅ | `invite-context.ts`, `user.create.before`; `auth.test.ts` |
| Invite tokens: 256-bit, SHA-256 stored, single-use, 48 h, re-issue revokes old | ✅ | `staff/invites.ts`; `invites.test.ts` |
| Passwords 12–128 chars, no composition rules, breached-password check (HIBP k-anonymity) | ✅ | `auth.ts` |
| TOTP 2FA mandatory before any app page or action | ✅ | `authz/viewer.ts` (`requireViewer`, `authorize`) |
| 2FA cannot be disabled; TOTP secret never re-retrievable | ✅ | `disabledPaths` (`/two-factor/disable`, `/get-totp-uri`) |
| 10 single-use backup codes; regeneration requires password | ✅ | enrolment + Security page |
| Generic sign-in errors (no username enumeration) | ✅ | `auth.test.ts` |
| Rate limiting (DB-backed, works across serverless instances) | ✅ | `shared-options.ts`; `auth.test.ts` |
| Login blocked for suspended/departed staff | ✅ | `session.create.before`; `auth.test.ts` |
| Passkeys (instead of password + code); must verify the person (UV); adding one needs a fresh step-up | ✅ | `auth.ts`, `audit-hook.ts`; `phase6.test.ts` |
| Executive 2FA reset for another user (step-up + reason; their sessions and passkeys removed) | ✅ | `staff/service.ts`; `phase6.test.ts` |
| Executive one-time password reset link (step-up + reason; signs them out) | ✅ | `staff/password-reset.ts`; `phase6.test.ts` |
| Step-up re-authentication for sensitive actions (fresh code, 5 min, this session only): write-off, mark repaid, merge/retire records, ledger adjustments, settings, full export, 2FA/password reset, adding a passkey | ✅ | `auth/step-up.ts`, `step-up-guard.ts`; `staff.test.ts`, `loans.test.ts` |
| Step-up attempts share the 2FA lockout (5 wrong → 5 min); checked with the 2FA row locked so parallel attempts each count; a code can't be used for two step-ups | ✅ | `auth/step-up.ts`; `staff.test.ts` (review 2026-10-13) |

## Sessions

| Control | Status |
|---|---|
| HttpOnly, Secure (prod), SameSite=Lax cookies, `litts.` prefix | ✅ |
| 60 min sliding idle timeout (server; 15 min until 2026-10-11, raised for officers switching between the game and the app) + warning dialog with countdown 5 min before (client, cross-tab) | ✅ |
| 12 h absolute lifetime | ✅ `viewer.ts` |
| No cookie cache → revocation is immediate | ✅ |
| Session list without exposing tokens; revoke one/all others | ✅ `account/sessions.ts` (Better Auth's token-returning endpoints disabled) |
| Suspend/depart revokes all sessions immediately | ✅ `staff/service.ts` |

## Authorization

- One capability table (`src/lib/permissions.ts`), mirrored by an exhaustive test of
  the SPEC §2 matrix (`permissions.test.ts`: every role × capability).
- Every Server Action calls `authorize(capability)`; every page calls
  `requireViewer()` / `requireCapabilityPage()`. Role changes can only target roles
  strictly below the actor's (Owner excepted); nobody can modify themselves.

## Web hardening

- Strict CSP with per-request nonce (`script-src 'nonce-…' 'strict-dynamic'`), no
  inline styles except by nonce or pinned hash (Sonner, test-guarded), `frame-ancestors 'none'`.
- HSTS (preload), `X-Content-Type-Options`, `X-Frame-Options: DENY`, strict
  Referrer-Policy, Permissions-Policy, COOP/CORP, `Cache-Control: no-store`.
- Server Actions: Next.js origin check; Zod validation; errors sanitised (`server/action.ts`).
- Post-login redirect accepts same-site relative paths only.

## Audit trail

- Append-only `audit_event`: UPDATE/DELETE/TRUNCATE rejected by trigger for every
  role (`drizzle/0001_audit_event_immutable.sql`).
- HMAC-SHA256 hash chain keyed by `AUDIT_HMAC_KEY` (separate from the auth
  secret); verified on the Audit page for executives; tampering test in `audit.test.ts`.
- Written in the same transaction as the change it records.
- Auth events: sign-in success/failure, 2FA pending/verified/failed/enabled,
  backup codes, password change, sign-out, session revocation.

## Data & infrastructure

- Secrets only in environment variables, validated at boot (`server/env.ts`).
- Neon: encryption at rest, TLS, point-in-time restore.
- Dependencies pinned via lockfile; new packages are provenance-checked before adoption.
- CI runs `pnpm audit --prod --audit-level high` before anything else; Dependabot proposes action
  and package updates weekly; third-party actions are pinned to a commit (review 2026-10-13).
  `xlsx` comes from the SheetJS CDN, outside both: its releases are checked by hand.
- Least-privilege database roles (migration 0030): the app connects as `litts_app`, which can't
  change or delete append-only rows, truncate, or alter tables (so it can't switch the triggers
  off); backups and checks use `litts_readonly`; only migrations use the owner. Pinned by
  `database-roles.test.ts`. Switch-over steps: `docs/operations/DEPLOYING.md`.

## Audit anchoring (2026-10-11)

The HMAC key that signs the audit chain lives beside the database credentials, so the chain
alone is tamper-evident only against someone without the key. Since the code review, the
newest entry's hash is anchored nightly on the `audit-anchors` branch in GitHub and checked
daily (`docs/operations/MONITORING.md`): rewriting history now also needs write access to the
repository's history, and would be noticed within a day.
