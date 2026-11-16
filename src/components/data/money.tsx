import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * Money with tabular figures. `direction` renders a signed bank movement
 * (+ in, − out); `accounting` renders negatives in parentheses for statements.
 */
export function Money({
  cents,
  direction,
  accounting,
  className,
}: {
  cents: number;
  direction?: "in" | "out";
  accounting?: boolean;
  className?: string;
}) {
  if (direction) {
    return (
      <span className={cn("num whitespace-nowrap", direction === "in" && "text-success", className)}>
        <span aria-hidden>{direction === "in" ? "+" : "−"}</span>
        <span className="sr-only">{direction === "in" ? "received " : "paid "}</span>
        {formatCents(cents)}
      </span>
    );
  }
  return (
    // In statements (`accounting`) a bracketed balance is normal (contra accounts), so no alarm colour.
    <span className={cn("num whitespace-nowrap", cents < 0 && !accounting && "text-danger", className)}>
      {formatCents(cents, { parenthesesForNegative: accounting })}
    </span>
  );
}
