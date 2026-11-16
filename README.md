# Litt's Loans Platform (public showcase copy)

> **This is a read-only showcase copy, not the production repository.** It is a one-commit
> snapshot of the private production code, published so the code can be read. It has no
> deploy job, no production settings or runbooks, and no history. Character names, State IDs
> and wallet numbers from the game have been replaced with made-up ones (the CEO character,
> Kieran Jones, is the author's own). Changes are never made here or copied back.
> Links to `docs/research/` and `docs/operations/` point to files that stay private.

Internal servicing and finance platform for **Litt's Loans**, a lending business on
a GTA V roleplay (FiveM) server. Staff-only, invite-only, 2FA enforced.

> In use by the business's staff since October 2026: bank import and
> double-entry ledger, loans, mortgages, commissions, reports, loan offers with contracts and
> mortgage quotes, collections, borrower directory, staff admin and a tamper-evident audit log.
> What's been built and why: [`docs/CLAUDE-production-notes.md`](docs/CLAUDE-production-notes.md)
> (status + conventions), [`docs/SPEC.md`](docs/SPEC.md), [`docs/design/`](docs/design),
> [`docs/decisions/`](docs/decisions), [`docs/qa/`](docs/qa).

## How it was built

Built with Claude Code. The author is the product owner: decides what gets built from what
staff ask for, tests each change in the running app, and reads the changes to money and
sign-in logic. Tests and CI are part of every change (unit, integration against a real
Postgres, and Playwright browser tests).

## Stack

Next.js 16 (App Router, all routes dynamic) · TypeScript strict · PostgreSQL
(Neon in production) · Drizzle ORM · Better Auth (username + password + mandatory
TOTP) · Tailwind CSS 4 + shadcn/ui on Base UI · Vitest · Playwright.

Rationale for every choice is in [`docs/decisions/`](docs/decisions).

## Local development

Prerequisites: Node 22+, pnpm 10+, Docker Desktop. Local Postgres is 18, matching Neon.

```bash
pnpm install
cp .env.example .env.local      # then fill the two secrets (command in the file)
pnpm db:up                      # Postgres 18 on localhost:54329
pnpm db:migrate
pnpm dev                        # http://localhost:3000
```

### First account (bootstrap)

Nobody exists to invite the first person, so issue an invite from the CLI (anyone
who can run this already has database credentials; it is audited as `system`):

```bash
pnpm staff:invite --state-id 3454 --name "Kieran Jones" --role ceo
```

Open the printed link, choose a username and password, then scan the QR code with
an authenticator app. After that, invite everyone else from **Staff** in the sidebar.

The CLI is also the break-glass path if no executive can sign in.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js dev / production build / serve |
| `pnpm typecheck` | Route type generation + `tsc` |
| `pnpm lint` | ESLint |
| `pnpm test` | Unit + integration tests (integration needs `pnpm db:up`; uses database `litts_loans_test`) |
| `pnpm check` | Everything CI runs: lint, typecheck, tests, build |
| `pnpm test:e2e` | Browser tests (`tests/e2e`) against a running `pnpm build && pnpm start` |
| `pnpm db:generate` / `db:migrate` / `db:studio` | Drizzle migrations / Studio |
| `pnpm auth:generate` | Regenerate Better Auth tables after changing `src/server/auth/shared-options.ts` |
| `pnpm staff:invite` | Issue an invite from the command line |
| `pnpm staff:reset-password` | Break-glass password reset link from the command line |

The integration test database must exist once: `docker compose exec db psql -U litts -c "create database litts_loans_test"`.

## Production

The live deployment, its infrastructure and its operations docs are not part of this copy.

## Repository map

```
src/app/(auth)        sign-in, 2FA, invite acceptance, 2FA enrolment, password reset
src/app/(app)         the app: dashboard, my work, loans (+ offers), mortgages (+ quotes),
                      borrowers, collections, finance, commissions, staff, settings, audit
src/domain/           pure business logic (parsing, classification, ledger, schedules, maths)
src/server/           server-only: db, auth, authz (viewer + record rules), audit, services
src/lib/              pure shared code: roles, permissions, formatting, money, CSP
src/instrumentation.ts  records server errors for the daily health check
drizzle/              SQL migrations (incl. audit immutability trigger)
tests/integration/    tests against a real Postgres
tests/e2e/            browser tests (Playwright): crawl, odd URLs, accessibility, flows
tests/fixtures/       anonymised copies of the real data, used by tests
scripts/              CLI (invites, resets), audit scripts
.github/workflows/    CI (checks + browser tests); no deploy
docs/                 spec, ADRs, design, QA, security, Claude Code notes
reference/            real owner data — gitignored; see reference/README.md
```
