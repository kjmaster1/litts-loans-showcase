import type { LoanStatus } from "@/domain/loans/status";
import { StatusBadge, type Tone } from "./status-badge";

export const LOAN_STATUS: Record<LoanStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  overdue: { label: "Overdue", tone: "warning" },
  defaulted: { label: "Defaulted", tone: "danger" },
  written_off: { label: "Written off", tone: "neutral" },
  completed: { label: "Completed", tone: "info" },
};

export function LoanStatusBadge({ status }: { status: LoanStatus }) {
  const s = LOAN_STATUS[status];
  return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
}
