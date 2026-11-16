import type { QuoteStatus } from "@/domain/origination/quote-status";
import type { Tone } from "@/components/data/status-badge";
import type { Verdict } from "@/domain/mortgages/allowance-outlook";

export const QUOTE_STATUS: Record<QuoteStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  confirmed: { label: "Confirmed", tone: "info" },
  matched: { label: "Became a mortgage", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** Executive approval of a quote over the line (research/18). */
export const APPROVAL_STATUS: Record<"needed" | "approved", { label: string; tone: Tone }> = {
  needed: { label: "Needs approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
};

/** The quote form, scrolled to its signing time. */
export const signingTimeHref = (id: string) => `/mortgages/quotes/${id}/edit#expected-signing`;

/** Allowance on signing day (research/19): the badge, and the text colour of "$X left after". */
export const VERDICT: Record<Verdict, { label: string; tone: Tone; text: string }> = {
  fits: { label: "Fits", tone: "success", text: "text-success" },
  tight: { label: "Tight", tone: "warning", text: "text-warning" },
  short: { label: "Short", tone: "danger", text: "text-danger" },
};
