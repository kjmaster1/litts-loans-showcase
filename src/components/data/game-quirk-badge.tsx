import { StatusBadge } from "./status-badge";

/**
 * Marks something caused by the game's loan system rather than by anyone at Litt's
 * (research/02, research/14). The books record what actually happened; this says why
 * it differs from the agreement.
 */
export function GameQuirkBadge({ className }: { className?: string }) {
  return (
    <StatusBadge tone="info" className={className}>
      Game quirk
    </StatusBadge>
  );
}
