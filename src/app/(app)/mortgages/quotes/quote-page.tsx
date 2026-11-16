import { notFound, redirect } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import type { Viewer } from "@/server/authz/viewer";
import { approvalLineCents } from "@/domain/mortgages/approval";
import { allowanceLine } from "@/domain/mortgages/allowance-outlook";
import { canApproveQuote } from "@/server/authz/rules";
import { getAllowanceOutlook } from "@/server/mortgages/allowance-outlook";
import { canActOnQuote, getQuote } from "@/server/origination/mortgage-quotes";
import { quoteNotes } from "@/server/origination/quote-review";
import { isLiveQuote } from "@/domain/origination/quote-status";
import { getSettings } from "@/server/settings";
import { QuoteForm, type QuoteDraft } from "./quote-form";
import { OpenNotesReminder } from "./review";

/** New quote, or editing a live one (shared by /mortgages/quotes/new and /[id]/edit). */
export async function QuoteFormPage({ viewer, id, stateId }: { viewer: Viewer; id: string | null; stateId?: string }) {
  const settings = await getSettings();
  const now = new Date();
  const q = id ? await getQuote(viewer, id) : null;
  if (id && (!q || !isLiveQuote(q.status))) notFound();
  // A colleague's quote opens read-only on its own page.
  if (q && !canActOnQuote(viewer, q)) redirect(`/mortgages/quotes/${q.id}`);
  const openNotes = q ? (await quoteNotes(viewer, q.id)).filter((n) => !n.done) : [];
  // The projected allowance without this quote (research/19 §4); a quote signed in game has already drawn on it.
  const outlook = q?.signedAt ? null : await getAllowanceOutlook(viewer, now);
  const allowance = outlook ? { line: allowanceLine(outlook, now, q?.status === "confirmed" ? q.number : null), rule: outlook.rule } : null;
  const initial: QuoteDraft = q
    ? {
        id: q.id,
        buyerStateId: String(q.buyerStateId),
        buyerName: q.buyerName,
        address: q.address,
        price: String(q.priceCents / 100),
        agencyCommission: String(q.agencyCommissionCents / 100),
        downPayment: String(q.downPaymentBp / 100),
        termMonths: String(q.termMonths),
        fedRate: String(q.fedRateBp / 100),
        brokerRate: String(q.brokerRateBp / 100),
        bankerFee: String(q.bankerFeeBp / 100),
        primaryResidence: q.primaryResidence,
        companyFunded: q.companyFunded,
        notes: q.notes,
        expectedSigningAt: q.expectedSigningAt?.toISOString() ?? null,
        status: q.status === "confirmed" ? (q.signedAt ? "signed" : "confirmed") : "draft",
      }
    : {
        id: null,
        buyerStateId: stateId && /^\d{1,7}$/.test(stateId) ? stateId : "",
        buyerName: "",
        address: "",
        price: "",
        agencyCommission: "",
        downPayment: String(settings.mortgages.downPaymentMinPct),
        termMonths: "",
        fedRate: String(settings.mortgages.fedRateMinPct),
        brokerRate: String(settings.mortgages.brokerRateStartPct),
        // Empty: the federal maximum for the mortgage's band, once the price is in.
        bankerFee: "",
        primaryResidence: true,
        companyFunded: false,
        notes: "",
        expectedSigningAt: null,
        status: "draft",
      };
  return (
    <>
      <PageHeader
        title={q ? `Mortgage quote ${q.number}` : "New mortgage quote"}
        crumbs={[
          { label: "Mortgages", href: "/mortgages" },
          { label: "Quotes", href: "/mortgages/quotes" },
        ]}
        description="Work the terms out with the buyer, check them against the handbook, then type them into the tablet."
      />
      <PageBody className="space-y-6">
        <OpenNotesReminder notes={openNotes.map((n) => ({ ...n, at: n.at.toISOString(), done: null }))} />
        <QuoteForm
          initial={initial}
          settings={settings.mortgages}
          originatorPct={settings.commission.mortgageOriginatorPct}
          allowance={allowance}
          approval={{ lineCents: approvalLineCents(settings.mortgages), approvesOwn: canApproveQuote(viewer), approvedBy: q?.approvedAt ? (q.approvedByName ?? "an executive") : null }}
        />
      </PageBody>
    </>
  );
}
