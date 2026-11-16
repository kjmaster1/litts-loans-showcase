# ADR 0002 — No four-eyes approvals; step-up auth + reason + reversibility instead

Status: **Accepted** (2026-10-09)

## Context

SPEC v0.1 proposed maker-checker (second-person approval) for charge-offs, import
reversals, settings changes and 2FA resets. The CEO will mainly be the sole operator,
so a second approver would deadlock routine work.

## Decision

Sensitive actions are protected by three single-user controls instead:

1. **Step-up re-authentication** — a fresh TOTP/passkey check (≤ 5 min old) before
   the action executes.
2. **Mandatory reason** — free-text justification stored in the audit event.
3. **Reversibility** — every such action is itself reversible by posting a reversal
   (ledger) or restoring a prior effective-dated value (settings); nothing is deleted.

Plus: a "Sensitive actions" feed on the dashboard for Owner/CEO/COO so actions by
others are visible after the fact (detective control in place of preventive).

2FA reset of another user: Owner/CEO/COO only, step-up, reason, and the affected user
is forced to re-enrol on next login with all their sessions revoked.

## Consequences

- Simpler operations for a small team. Weaker preventive control is accepted;
  the hash-chained audit log and the sensitive-actions feed provide detection.
- The policy module keeps an `approvalRequired` hook (currently a no-op) so
  four-eyes can be switched on later per action without redesign.
