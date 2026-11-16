import { StatusBadge, type Tone } from "@/components/data/status-badge";
import type { CaseState } from "@/server/legal/cases";

export const CASE_STATE: Record<CaseState, { label: string; tone: Tone }> = {
  needs_details: { label: "Needs details", tone: "warning" },
  ready: { label: "Ready", tone: "info" },
  with_legal: { label: "With Legal", tone: "neutral" },
  closed: { label: "Closed", tone: "neutral" },
};

export function CaseStateBadge({ state }: { state: CaseState }) {
  return <StatusBadge tone={CASE_STATE[state].tone}>{CASE_STATE[state].label}</StatusBadge>;
}
