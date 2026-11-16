import { canCollectOn } from "@/server/authz/rules";
import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { RecentlyViewed } from "@/components/app-shell/recently-viewed";
import { CollectionsPanel } from "@/components/data/collections-panel";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { MortgageStateBadge } from "@/components/data/mortgage-state-badge";
import { StatusBadge } from "@/components/data/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { looksLikeAddress } from "@/domain/mortgages/parse-tablet";
import { can } from "@/lib/permissions";
import { requireViewer } from "@/server/authz/viewer";
import { mortgageCollections, serializeCollections } from "@/server/loans/collections";
import { activeStaffOptions } from "@/server/loans/queries";
import { getMortgage, mergedInto, mergeTargets } from "@/server/mortgages/queries";
import { quoteForMortgage } from "@/server/origination/mortgage-quotes";
import { mortgageProfits } from "@/server/profit";
import { MergeMortgagePanel, MortgageApprovalPanel, MortgageOfficerPanel } from "./mortgage-panels";
import { AgreementCard, BankMovementsCard, MortgageHistoryCard, MortgagePaymentsCard, nextInstalment, TabletPastesCard } from "./sections";

export const metadata: Metadata = { title: "Mortgage" };

/** One mortgage: figures and warnings, then the sections (./sections.tsx) and the side panels. */
export default async function MortgagePage({ params }: PageProps<"/mortgages/[id]">) {
  const viewer = await requireViewer();
  const { id } = await params;
  const data = await getMortgage(viewer, id);
  if (!data) {
    // A duplicate merged into the real record: old links go to that one.
    const into = await mergedInto(id);
    if (into) redirect(`/mortgages/${into}`);
    notFound();
  }
  const { mortgage: m, analysis } = data;
  const manager = can(viewer.role, "loans.reassign_officer");
  const canFinance = can(viewer.role, "finance.view");
  const canMerge = can(viewer.role, "records.merge");
  const [net, staff, collections, quote, targets] = await Promise.all([
    canFinance ? mortgageProfits().then((p) => p.get(m.id) ?? 0) : null,
    manager ? activeStaffOptions({ finished: m.status === "completed" }) : null,
    mortgageCollections([m.id]).then((c) => c.get(m.id) ?? []),
    quoteForMortgage(viewer, m.id),
    canMerge ? mergeTargets(m) : null,
  ]);
  const hasBankMoney = m.originationTxId !== null || m.fundingEntryId !== null || data.payments.length > 0;
  const late = m.status === "active" && (analysis?.state.kind === "late" || analysis?.state.kind === "behind");
  const canCollect = canCollectOn(viewer, m);
  const company = m.funding === "company";
  const next = nextInstalment(data);
  const approval = data.approval;
  const ev = data.approvalEvidence;
  const approvalSummary: React.ReactNode = !approval.required ? null : approval.approved ? (
    approval.how === "executive_officer" ? (
      "Arranged by an executive, so approved by them."
    ) : approval.how === "quote" && ev?.quote?.approvedAt ? (
      <>
        Approved on quote #{ev.quote.number}
        {ev.quote.approvedByName ? ` by ${ev.quote.approvedByName}` : ""}, <LocalTime value={ev.quote.approvedAt} />.
      </>
    ) : ev?.approvedAfter ? (
      <>
        Approved after the fact{ev.approvedAfter.byName ? ` by ${ev.approvedAfter.byName}` : ""}, <LocalTime value={ev.approvedAfter.at} />.
      </>
    ) : (
      "Approved."
    )
  ) : (
    <>Not approved: down payment + loan is over the executive-approval line, and {approval.reason}.</>
  );

  return (
    <>
      <PageHeader
        title={m.address}
        crumbs={[{ label: "Mortgages", href: "/mortgages" }]}
        meta={
          <span className="flex flex-wrap gap-1.5">
            <MortgageStateBadge status={m.status} state={analysis?.state ?? null} pasted={m.lastTabletAt !== null} />
            {company ? <StatusBadge tone="info">Funded by Litt&rsquo;s</StatusBadge> : null}
          </span>
        }
        description={
          <>
            {m.buyerName ?? "Unknown buyer"}
            {m.buyerStateId ? <span className="ident"> #{m.buyerStateId}</span> : null}
            {m.propertyType ? ` · ${m.propertyType}` : ""}
            {m.addressAliases.length ? ` · formerly ${m.addressAliases.join(", ")}` : ""}
            {quote ? (
              <>
                {" · "}
                <Link href={`/mortgages/quotes/${quote.id}`} className="text-primary underline underline-offset-4">
                  Quote #{quote.number}
                </Link>
              </>
            ) : null}
          </>
        }
      />
      <RecentlyViewed item={{ kind: "mortgage", title: m.address, detail: m.buyerName ?? "Mortgage", href: `/mortgages/${m.id}` }} />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {analysis ? (
            <StatStrip cols={net !== null ? 5 : 4}>
              <Kpi label={company ? "Owed to Litt’s" : "Owed to the State"} hint="Principal still to repay">
                <Money cents={analysis.principalRemainingCents} />
              </Kpi>
              <Kpi label="Broker interest to come" hint="Litt’s share">
                <Money cents={analysis.brokerInterestRemainingCents} />
              </Kpi>
              <Kpi label="Paid" tone={analysis.state.kind === "behind" ? "bad" : analysis.state.kind === "late" ? "warn" : undefined} hint="weekly instalments">
                {analysis.paidCount}/{analysis.schedule.length}
              </Kpi>
              <Kpi label="Next payment" hint={next ? undefined : "All paid"}>
                {next ? <LocalTime value={next.instalment.dueAt} format="date" /> : "—"}
              </Kpi>
              {net !== null ? (
                <Kpi label="Net to Litt’s" hint="fee and interest kept so far">
                  <Money cents={net} />
                </Kpi>
              ) : null}
            </StatStrip>
          ) : null}
          {!looksLikeAddress(m.address) ? (
            <Alert variant="danger">
              <TriangleAlert aria-hidden />
              <AlertTitle>This doesn&rsquo;t look like a real mortgage record</AlertTitle>
              <AlertDescription>
                <p>
                  &ldquo;{m.address}&rdquo; isn&rsquo;t a property address, so this record probably came from a paste copied from too high up on the tablet.
                  {canMerge ? " If it duplicates another mortgage, use “Merge…” in the Duplicate record panel to merge it into that one." : " Ask Management to merge it into the real mortgage."}
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
          {!m.lastTabletAt ? (
            <Alert variant="warning">
              <TriangleAlert aria-hidden />
              <AlertTitle>Details not pasted yet</AlertTitle>
              <AlertDescription>
                <p>
                  Paste this agreement from the tablet to see its schedule, rates and officer.{" "}
                  <Link href="/mortgages/import" className="font-medium text-foreground underline underline-offset-4">
                    Paste from tablet
                  </Link>
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
          {data.flags.length ? (
            <Alert variant="warning">
              <TriangleAlert aria-hidden />
              <AlertTitle>Outside the company guidelines</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-5">
                  {data.flags.map((f) => (
                    <li key={f.text} className={f.level === "breach" ? "text-danger" : undefined}>
                      {f.level === "breach" ? "Breach: " : ""}
                      {f.text}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <AgreementCard data={data} />
          <MortgagePaymentsCard data={data} />
          <BankMovementsCard data={data} canFinance={canFinance} />
          <TabletPastesCard data={data} />
        </div>

        <div className="space-y-6">
          <MortgageOfficerPanel
            mortgageId={m.id}
            officer={m.officerStaffId ? { id: m.officerStaffId, name: data.officerName ?? "Unknown" } : null}
            tabletOfficer={m.officerName}
            staff={staff}
            viewer={{ id: viewer.staffId }}
          />
          {approvalSummary ? (
            <MortgageApprovalPanel mortgageId={m.id} approved={approval.required && approval.approved} summary={approvalSummary} canApprove={can(viewer.role, "mortgages.approve_large")} />
          ) : null}
          {late || collections.length ? <CollectionsPanel target={{ mortgageId: m.id }} canLog={canCollect} items={serializeCollections(collections)} /> : null}
          <MortgageHistoryCard data={data} />
          {/* Only a record without bank money can be merged away; on the real one the panel had nothing to offer. */}
          {targets && !hasBankMoney ? (
            <MergeMortgagePanel
              mortgageId={m.id}
              address={m.address}
              hasBankMoney={hasBankMoney}
              targets={targets.map((t) => ({ ...t, originatedAt: t.originatedAt?.toISOString() ?? null }))}
            />
          ) : null}
        </div>
      </PageBody>
    </>
  );
}
