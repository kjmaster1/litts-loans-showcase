import type { PaymentState } from "@/domain/mortgages/schedule";
import { StatusBadge } from "./status-badge";

/** Payment state of a mortgage; `null` when its terms haven't been pasted from the tablet. */
/** `pasted`: whether the tablet agreement is on record, when the caller knows. */
export function MortgageStateBadge({ status, state, pasted }: { status: "active" | "completed" | "defaulted"; state: PaymentState | null; pasted?: boolean }) {
  if (status === "completed") return <StatusBadge tone="info">Completed</StatusBadge>;
  if (status === "defaulted") return <StatusBadge tone="danger">Defaulted</StatusBadge>;
  // Say what's missing and so what fixes it (UX review 2026-10-12): "Not pasted" matches the list's tab.
  if (!state) return <StatusBadge tone="neutral">{pasted === false ? "Not pasted" : pasted ? "Terms incomplete" : "Terms unknown"}</StatusBadge>;
  switch (state.kind) {
    case "completed":
      return <StatusBadge tone="info">All paid</StatusBadge>;
    case "on_track":
      return <StatusBadge tone="success">On track</StatusBadge>;
    case "late":
      return <StatusBadge tone="warning">{state.overdue} missed · in grace</StatusBadge>;
    case "behind":
      return <StatusBadge tone="danger">Behind · {state.overdue} missed</StatusBadge>;
  }
}
