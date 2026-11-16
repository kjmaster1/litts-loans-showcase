# ADR 0001 — Foundational decisions

Status: **Accepted** (2026-10-09, confirmed by owner)

## Context

Litt's Loans needs an internal, staff-only web app for a GTA V RP lending business
that behaves like enterprise finance software: secure auth, role hierarchy,
auditable financial records, and import from in-game bank data (xlsx export and
copy-paste from the phone/tablet UIs). See `docs/research/01-source-data-analysis.md`.

## Decisions

| # | Decision | Chosen | Alternatives considered |
|---|----------|--------|-------------------------|
| 1 | Hosting | **Vercel + Neon Postgres** | Self-hosted Docker VPS; both |
| 2 | Authentication | **Username + password + mandatory TOTP 2FA**, optional passkeys, backup codes; invite-only | Discord OAuth + TOTP; passkeys-only |
| 3 | Scope of loan process | **Servicing + records only.** Loans are agreed and created in-game; the app imports, tracks, collects, reports and runs the legal pipeline. No origination/approval workflow. | Full origination with approval limits; light approvals |
| 4 | Time display | **Store UTC, display in viewer's browser timezone**; show source timezone on hover. Import converts bank export from UTC-5 and copy-paste dates from GMT+1. *(2026-10-13: the export's times are UTC despite its `UTC-5` label; see ADR 0004.)* | Fixed GMT+1; fixed UTC-5 |

## Proposed stack (to be confirmed by further research before scaffolding)

- Next.js 16 (LTS, App Router, TypeScript strict), React Server Components.
- PostgreSQL on Neon; Drizzle ORM (SQL-first, low serverless cold-start, TS schema).
- Better Auth (two-factor TOTP, passkey, admin plugins) — self-owned user table.
- Tailwind + shadcn/ui; TanStack Table for data grids.
- Money stored as integer whole-dollar `bigint` (the game has no cents except one
  float artefact in a copy-paste, which is rounded on import and flagged).
- Double-entry ledger + append-only audit log.

## Consequences

- No approval workflow means role permissions focus on *who can import, edit,
  reclassify, write off, and see what* rather than lending authority limits.
- Serverless hosting: no long-running workers; scheduled jobs (overdue checks,
  reports) use Vercel Cron.
