import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { can } from "@/lib/permissions";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { activeStaffOptions } from "@/server/loans/queries";
import { canActOnOffer, getOffer } from "@/server/origination/loan-offers";
import { getSettings } from "@/server/settings";
import { OfferForm, type OfferDraft } from "./offer-form";

export const metadata: Metadata = { title: "New loan" };

const iso = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);

/** New private loan (docs/design/ORIGINATION.md): price it, check it, issue the contract. `?offer=` edits a draft. */
export default async function NewLoanPage({ searchParams }: PageProps<"/loans/new">) {
  const viewer = await requireCapabilityPage("loans.originate");
  const sp = await searchParams;
  const offerId = typeof sp.offer === "string" ? sp.offer : null;
  const settings = await getSettings();
  const existing = offerId ? await getOffer(viewer, offerId) : null;
  if (offerId && (!existing || existing.status !== "draft")) notFound();
  // A colleague's draft opens read-only on its own page.
  if (existing && !canActOnOffer(viewer, existing)) redirect(`/loans/offers/${existing.id}`);
  const officers = can(viewer.role, "loans.reassign_officer") ? await activeStaffOptions() : null;
  const s = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

  const initial: OfferDraft = existing
    ? {
        id: existing.id,
        kind: existing.kind,
        borrowerStateId: String(existing.borrowerStateId),
        borrowerName: existing.borrowerName,
        amount: String(existing.amountCents / 100),
        rate: String(existing.rateBp / 100),
        stateRate: String(existing.stateRateBp / 100),
        weeks: String(existing.weeks),
        startsOn: iso(existing.startsOn) < iso(new Date()) ? iso(new Date()) : iso(existing.startsOn),
        collateral: existing.collateral ?? "",
        collateralValue: s(existing.collateralValueCents === null ? null : existing.collateralValueCents / 100),
        purpose: existing.purpose ?? "",
        weeklyIncome: s(existing.weeklyIncomeCents === null ? null : existing.weeklyIncomeCents / 100),
        defaultFee: String(existing.defaultFeePerDayCents / 100),
        notes: existing.notes,
        officerStaffId: existing.officerStaffId,
      }
    : {
        id: null,
        kind: "vehicle",
        borrowerStateId: typeof sp.stateId === "string" && /^\d{1,7}$/.test(sp.stateId) ? sp.stateId : "",
        borrowerName: "",
        amount: "",
        rate: "",
        stateRate: String(settings.loans.stateRatePct),
        weeks: "",
        startsOn: iso(new Date()),
        collateral: "",
        collateralValue: "",
        purpose: "",
        weeklyIncome: "",
        defaultFee: "",
        notes: "",
        officerStaffId: viewer.staffId,
      };

  return (
    <>
      <PageHeader
        title={existing ? `Loan offer ${existing.number}` : "New loan"}
        crumbs={[{ label: "Loans", href: "/loans" }, { label: "Offers", href: "/loans/offers" }]}
        description="Price the loan with the borrower, check it against the handbook, then issue the contract to copy and send."
      />
      <PageBody>
        <OfferForm initial={initial} settings={settings.loans} officers={officers} />
      </PageBody>
    </>
  );
}
