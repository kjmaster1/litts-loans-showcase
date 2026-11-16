# ADR 0003 — Dynamic rendering with nonce-based strict CSP; Cache Components off

Status: **Accepted** (2026-10-09)

## Context

`create-next-app@16.4` enables `cacheComponents` (Partial Prerendering) and
`partialPrefetching` by default. Next's own docs (bundled in
`node_modules/next/dist/docs`) state:

- A nonce-based CSP requires every page to be dynamically rendered, and
  "Partial Prerendering (PPR) is incompatible with nonce-based CSP".
- With Cache Components, the recommended way to read the session is
  `use cache: private`, which caches the resolved user in the browser for the
  `default` profile (5 min stale).

This app handles financial records, uses a short idle timeout (15 minutes at the time; 60 since 2026-10-11) and must honour
session revocation immediately (suspended staff, 2FA reset).

## Decision

- Turn **off** `cacheComponents` and `partialPrefetching`. All routes are
  dynamically rendered.
- Strict CSP with a per-request nonce, generated in `src/proxy.ts`:
  `script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-inline` for scripts in
  production, `frame-ancestors 'none'`, `object-src 'none'`.
- The session is resolved once per request with React `cache()` in the data access
  layer (`src/server/authz/viewer.ts`), never cached across requests.
- `Cache-Control: no-store` on all non-static responses.

## Consequences

- Slightly slower navigations than a prerendered shell. Irrelevant at our scale
  (≈ a dozen staff) and acceptable for a finance app.
- Simpler mental model: no Suspense requirement around every session read.
- If we ever need static marketing pages, they can live outside the authenticated
  app without changing this decision.
