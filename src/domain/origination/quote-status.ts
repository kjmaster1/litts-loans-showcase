/** Mortgage quote statuses (research/19). Pure and client-safe. */
export const QUOTE_STATUSES = ["draft", "confirmed", "matched", "cancelled"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** A quote still in play: not yet matched to a mortgage, not cancelled. */
export const LIVE_QUOTE_STATUSES = ["draft", "confirmed"] as const;
export type LiveQuoteStatus = (typeof LIVE_QUOTE_STATUSES)[number];

export function isLiveQuote(status: QuoteStatus): status is LiveQuoteStatus {
  return (LIVE_QUOTE_STATUSES as readonly QuoteStatus[]).includes(status);
}
