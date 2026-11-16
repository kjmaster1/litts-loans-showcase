import { canCollectOn } from "@/server/authz/rules";
import { and, eq, isNull, ne } from "drizzle-orm";
import { Info, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { RecentlyViewed } from "@/components/app-shell/recently-viewed";
import { CollectionsPanel } from "@/components/data/collections-panel";
import { GameQuirkBadge } from "@/components/data/game-quirk-badge";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LoanStatusBadge } from "@/components/data/loan-status-badge";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { LinkRole } from "@/domain/loans/link";
import { dateFormat, formatCents } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requireViewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { loan as loanTable } from "@/server/db/schema";
import { loanCollections, serializeCollections } from "@/server/loans/collections";
import { activeStaffOptions, getLoan, mergedLoanInto } from "@/server/loans/queries";
import { proposeRelink } from "@/server/loans/relink";
import { REPAID_TOLERANCE_CENTS } from "@/server/loans/service";
import { offerForLoan } from "@/server/origination/loan-offers";
import { loanProfits } from "@/server/profit";
import { dataFreshness } from "@/server/freshness";
import { CollateralPanel, MarkRepaidPanel, OfficerPanel, RetireCardOnlyLoanPanel, WriteOffPanel } from "./loan-panels";
import { RelinkPanel } from "./relink-panel";
import { HistoryCard, LoanDetailsCard, PaymentsCard, PhoneCardsCard, principalReceived, ROLE_LABEL, ScheduleCard } from "./sections";

export const metadata: Metadata = { title: "Loan" };

const dayMonth = dateFormat({ day: "numeric", month: "short", timeZone: "Europe/London" });

/** One loan: figures, warnings and game quirks, then the sections (./sections.tsx) and the side panels. */
export default async function LoanPage({ params }: PageProps<"/loans/[id]">) {
  const viewer = await requireViewer();
  const { id } = await params;
  const data = await getLoan(viewer, id);
  if (!data) {
    // A duplicate card-only loan merged into the real one: old links go there.
    const into = await mergedLoanInto(id);
    if (into) redirect(`/loans/${into}`);
    notFound();
  }
  const { loan: l, analysis } = data;
  const manager = can(viewer.role, "loans.reassign_officer");
  const canWriteOff = can(viewer.role, "loans.charge_off");
  const canFinance = can(viewer.role, "finance.view");
  const collectable = l.status === "overdue" || l.status === "defaulted" || l.status === "written_off";
  const canCollect = canCollectOn(viewer, l);
  const canRelink = can(viewer.role, "loans.edit_metadata") && data.otherLoans > 0;
  // A loan known only from a phone card can be retired by Management+ (merged or removed).
  const cardOnly = !l.disbursementTxId && can(viewer.role, "records.merge");
  const [net, staff, collections, moves, offer, sameBorrower, freshness] = await Promise.all([
    canFinance ? loanProfits().then((p) => p.get(l.id) ?? 0) : null,
    manager ? activeStaffOptions({ finished: l.status === "completed" || l.status === "written_off" }) : [],
    collectable ? loanCollections([l.id]).then((c) => c.get(l.id) ?? []) : [],
    canRelink ? proposeRelink(l.borrowerStateId) : [],
    offerForLoan(viewer, l.id),
    cardOnly
      ? db
          .select({ id: loanTable.id, principalCents: loanTable.principalCents, openedAt: loanTable.openedAt, status: loanTable.status })
          .from(loanTable)
          .where(and(isNull(loanTable.retiredAt), eq(loanTable.borrowerStateId, l.borrowerStateId), ne(loanTable.id, l.id)))
      : [],
    dataFreshness(),
  ]);
  const siblings = moves.length
    ? await db.select({ id: loanTable.id, principalCents: loanTable.principalCents, openedAt: loanTable.openedAt }).from(loanTable).where(eq(loanTable.borrowerStateId, l.borrowerStateId))
    : [];
  const loanLabel = (lid: string) => {
    const s = siblings.find((x) => x.id === lid);
    return `${lid === l.id ? "This" : "The"} ${formatCents(s?.principalCents ?? 0)} loan (opened ${s?.openedAt ? dayMonth.format(s.openedAt) : "?"})`;
  };
  const staffNames = new Map(staff.map((s) => [s.id, s.name]));
  if (l.officerStaffId && data.officerName) staffNames.set(l.officerStaffId, data.officerName);
  const staffName = (sid: unknown) => (typeof sid === "string" ? (staffNames.get(sid) ?? "a former officer") : "—");
  const gameFlags = analysis?.flags.filter((f) => f.source === "game") ?? [];
  const setupFlags = analysis?.flags.filter((f) => f.source === "setup") ?? [];
  const title = l.borrowerName ?? `State ID ${l.borrowerStateId}`;
  const open = l.status === "active" || l.status === "overdue" || l.status === "defaulted";
  const penalised = (analysis?.penaltyCents ?? 0) > 0 || /OVERDUE|DEFAULTED/.test(data.cards[0]?.raw ?? "");

  return (
    <>
      <PageHeader
        title={title}
        crumbs={[{ label: "Loans", href: "/loans" }]}
        meta={<LoanStatusBadge status={l.status} />}
        description={
          <>
            <Money cents={l.principalCents} /> loan · State ID <span className="ident">{l.borrowerStateId}</span>
            {data.officerName ? <> · {data.officerName}</> : null}
            {l.status === "defaulted" || l.status === "written_off" ? (
              <>
                {" · "}
                <Link href={`/loans/legal/${l.id}`} className="text-primary underline underline-offset-4">
                  Legal case
                </Link>
              </>
            ) : null}
            {offer ? (
              <>
                {" · "}
                <Link href={`/loans/offers/${offer.id}`} className="text-primary underline underline-offset-4">
                  Contract (offer #{offer.number})
                </Link>
              </>
            ) : null}
          </>
        }
      />
      <RecentlyViewed item={{ kind: "loan", title, detail: `Loan · #${l.borrowerStateId}`, href: `/loans/${l.id}` }} />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <StatStrip cols={net !== null ? 5 : 4}>
            <Kpi
              label="Still owed"
              hint={
                // The phone's own figure, to check against (QA 2026-10-13). After a missed payment it includes the
                // game's +2% penalty on every instalment still to come; the books count principal only.
                open && l.lastRemainingCents !== null && l.lastCardAt ? (
                  <>
                    Phone: <Money cents={l.lastRemainingCents} /> on <LocalTime value={l.lastCardAt} format="date" />
                    {penalised && l.lastRemainingCents > Math.max(0, data.outstandingCents ?? 0) ? ", with the overdue penalty" : null}
                  </>
                ) : undefined
              }
            >
              {data.outstandingCents === null ? <span className="text-muted-foreground">—</span> : <Money cents={Math.max(0, data.outstandingCents)} />}
            </Kpi>
            <Kpi label="Principal received" hint={<>of <Money cents={l.principalCents} /></>}>
              <Money cents={principalReceived(data)} />
            </Kpi>
            <Kpi label="Progress" tone={l.lastMissed ? "warn" : undefined} hint={l.lastMissed ? `${l.lastMissed} missed` : l.instalments ? "payments made" : "Terms unknown"}>
              {l.instalments ? `${l.lastCompleted ?? 0}/${l.instalments}` : "—"}
            </Kpi>
            <Kpi label="Next payment" hint={l.status === "completed" ? "Completed" : l.nextPaymentDueAt ? undefined : "Not known yet"}>
              {l.nextPaymentDueAt && l.status !== "completed" ? <LocalTime value={l.nextPaymentDueAt} format="date" /> : "—"}
            </Kpi>
            {net !== null ? (
              <Kpi label="Net to Litt’s" tone={net < 0 ? "bad" : undefined} hint={l.status === "completed" || l.status === "written_off" ? "final, before commission" : "so far, before commission"}>
                <Money cents={net} />
              </Kpi>
            ) : null}
          </StatStrip>

          {moves.length ? (
            <RelinkPanel
              stateId={l.borrowerStateId}
              moves={moves.map((m) => ({
                txId: m.txId,
                at: m.at.toISOString(),
                what: ROLE_LABEL[m.role as LinkRole] ?? m.role,
                amountCents: m.amountCents,
                from: loanLabel(m.fromLoanId),
                to: loanLabel(m.toLoanId),
              }))}
            />
          ) : null}

          {setupFlags.map((f) => (
            <Alert key={f.kind} variant="danger">
              <TriangleAlert aria-hidden />
              <AlertTitle>Check this loan&rsquo;s rates</AlertTitle>
              <AlertDescription>
                {f.detail} Over the loan that&rsquo;s about <Money cents={f.cents} /> more to the State than Litt&rsquo;s earns in interest.
              </AlertDescription>
            </Alert>
          ))}

          {gameFlags.length ? (
            <Alert variant="info">
              <Info aria-hidden />
              <AlertTitle className="flex flex-wrap items-center gap-2">
                Game quirks on this loan <GameQuirkBadge />
              </AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-5">
                  {gameFlags.map((f) => (
                    <li key={f.kind}>
                      {f.detail}: <Money cents={f.cents} />
                    </li>
                  ))}
                </ul>
                <p className="mt-1">
                  Known bugs in the game&rsquo;s loan system, not mistakes by staff or the borrower. The books record what was actually paid; nothing needs
                  doing.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          <LoanDetailsCard data={data} />
          <ScheduleCard data={data} now={new Date()} bankTo={freshness.bankTo} />
          <PaymentsCard data={data} canFinance={canFinance} />
          <PhoneCardsCard data={data} />
        </div>

        <div className="space-y-6">
          <OfficerPanel
            loanId={l.id}
            officer={l.officerStaffId ? { id: l.officerStaffId, name: data.officerName ?? "Unknown" } : null}
            staff={manager ? staff : null}
            viewer={{ id: viewer.staffId, name: viewer.characterName }}
          />

          {can(viewer.role, "loans.edit_metadata") &&
          (l.status === "overdue" || l.status === "defaulted") &&
          data.outstandingCents !== null &&
          data.outstandingCents <= REPAID_TOLERANCE_CENTS ? (
            <MarkRepaidPanel loanId={l.id} owedCents={Math.max(0, data.outstandingCents)} />
          ) : null}

          {canWriteOff && (l.status === "defaulted" || l.status === "written_off") ? (
            <WriteOffPanel
              loanId={l.id}
              status={l.status}
              outstandingCents={data.outstandingCents}
              eligibleAt={data.writeOffEligibleAt?.toISOString() ?? null}
              writtenOffAt={l.writtenOffAt?.toISOString() ?? null}
            />
          ) : null}

          {collectable ? <CollectionsPanel target={{ loanId: l.id }} canLog={canCollect} items={serializeCollections(collections)} /> : null}

          <CollateralPanel
            loanId={l.id}
            items={data.collateral.map((c) => ({ id: c.id, description: c.description, valueCents: c.estimatedValueCents, status: c.status }))}
          />

          <HistoryCard data={data} staffName={staffName} />

          {cardOnly ? (
            <RetireCardOnlyLoanPanel
              loanId={l.id}
              targets={sameBorrower.map((t) => ({ id: t.id, label: `${formatCents(t.principalCents)} loan · opened ${t.openedAt ? dayMonth.format(t.openedAt) : "?"} · ${t.status.replace("_", " ")}` }))}
            />
          ) : null}
        </div>
      </PageBody>
    </>
  );
}
