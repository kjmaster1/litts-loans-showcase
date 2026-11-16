import type { Standing } from "./directory";

export const STANDING_LABEL: Record<Standing, { label: string; tone: "danger" | "warning" | "info" | "success" | "neutral" }> = {
  do_not_lend: { label: "Do not lend", tone: "danger" },
  defaulted: { label: "Defaulted", tone: "danger" },
  overdue: { label: "Overdue", tone: "warning" },
  late_mortgage: { label: "Mortgage late", tone: "warning" },
  active: { label: "Paying", tone: "info" },
  paid_up: { label: "Paid up", tone: "success" },
};
