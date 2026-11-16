import type { Tone } from "@/components/data/status-badge";

export const OFFER_STATUS: Record<"draft" | "issued" | "funded" | "cancelled", { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  issued: { label: "Contract issued", tone: "info" },
  funded: { label: "Paid out", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
