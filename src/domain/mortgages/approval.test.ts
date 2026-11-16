import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { approvalFlag, approvedTermsChanged, EXECUTIVE_APPROVAL_FROM, mortgageApproval, needsExecutiveApproval, quoteApproval, type ApprovalEvidence } from "./approval";

const g = DEFAULT_SETTINGS.mortgages;
const after = new Date(EXECUTIVE_APPROVAL_FROM.getTime() + 86_400_000);
const before = new Date(EXECUTIVE_APPROVAL_FROM.getTime() - 1);
/** $1,250,000 down payment + loan. */
const big = { downPaymentCents: 12_500_000, loanCents: 112_500_000, originatedAt: after };
const none: ApprovalEvidence = { officerIsExecutive: false, quote: null, approvedAfter: null };
const approvedQuote = (at: Date, differences: string[] = []) => ({ number: 7, approvedAt: at, differences });

describe("executive approval over $1,000,000 (owner, 2026-10-15)", () => {
  it("is needed strictly above the line", () => {
    expect(needsExecutiveApproval(100_000_000, g)).toBe(false);
    expect(needsExecutiveApproval(100_000_100, g)).toBe(true);
    expect(needsExecutiveApproval(null, g)).toBe(false);
    expect(needsExecutiveApproval(150_000_000, { ...g, executiveApprovalAboveDollars: 2_000_000 })).toBe(false);
  });

  it("quotes: not needed, needed, approved", () => {
    expect(quoteApproval({ baseCents: 90_000_000, approvedAt: null }, g)).toBe("not_needed");
    expect(quoteApproval({ baseCents: 125_000_000, approvedAt: null }, g)).toBe("needed");
    expect(quoteApproval({ baseCents: 125_000_000, approvedAt: after }, g)).toBe("approved");
  });

  it("an approval covers the terms, not the buyer's spelling or the notes", () => {
    const terms = { buyerStateId: 1, address: "1 A St", priceCents: 1, agencyCommissionCents: 0, downPaymentBp: 1000, termMonths: 12, fedRateBp: 300, brokerRateBp: 600, bankerFeeBp: 300, primaryResidence: true, companyFunded: false };
    expect(approvedTermsChanged(terms, { ...terms })).toBe(false);
    expect(approvedTermsChanged(terms, { ...terms, bankerFeeBp: 200 })).toBe(true);
    expect(approvedTermsChanged(terms, { ...terms, companyFunded: true })).toBe(true);
    expect(approvedTermsChanged(terms, { ...terms, buyerName: "Other spelling", notes: "x" } as typeof terms)).toBe(false);
  });

  it("mortgages under the line, before the rule or not yet pasted don't need it", () => {
    expect(mortgageApproval({ ...big, downPaymentCents: 10_000_000, loanCents: 90_000_000 }, none, g)).toEqual({ required: false });
    expect(mortgageApproval({ ...big, originatedAt: before }, none, g)).toEqual({ required: false });
    expect(mortgageApproval({ ...big, loanCents: null }, none, g)).toEqual({ required: false });
    // Not in the bank yet: treated as new.
    expect(mortgageApproval({ ...big, originatedAt: null }, none, g)).toMatchObject({ required: true, approved: false });
  });

  it("approved: an executive's own, an approved quote matching the agreement, or after the fact", () => {
    expect(mortgageApproval(big, { ...none, officerIsExecutive: true }, g)).toMatchObject({ approved: true, how: "executive_officer" });
    expect(mortgageApproval(big, { ...none, quote: approvedQuote(EXECUTIVE_APPROVAL_FROM) }, g)).toMatchObject({ approved: true, how: "quote" });
    expect(mortgageApproval(big, { ...none, approvedAfter: { at: after, byName: "Kieran Jones" } }, g)).toMatchObject({ approved: true, how: "after_the_fact" });
  });

  it("not approved: no quote, an unapproved quote, approved too late, or different terms", () => {
    expect(mortgageApproval(big, none, g)).toMatchObject({ approved: false, reason: "it wasn’t made from a quote" });
    expect(mortgageApproval(big, { ...none, quote: { number: 7, approvedAt: null, differences: [] } }, g)).toMatchObject({ approved: false, reason: "quote #7 wasn’t approved" });
    expect(mortgageApproval(big, { ...none, quote: approvedQuote(new Date(after.getTime() + 1)) }, g)).toMatchObject({ approved: false, reason: expect.stringMatching(/only after/) });
    expect(mortgageApproval(big, { ...none, quote: approvedQuote(EXECUTIVE_APPROVAL_FROM, ["Loan is $1 on the agreement, $2 in the quote"]) }, g)).toMatchObject({
      approved: false,
      reason: "the agreement differs from approved quote #7",
    });
  });

  it("flags the unapproved one as a breach", () => {
    expect(approvalFlag(big, none, g)).toEqual({
      level: "breach",
      rule: "executive_approval",
      text: "Not approved by an executive: $1,250,000 down payment + loan is over $1,000,000, and it wasn’t made from a quote",
    });
    expect(approvalFlag(big, { ...none, officerIsExecutive: true }, g)).toBeNull();
  });
});
