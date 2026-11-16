import { formatCents } from "@/lib/format";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { CopyBlock } from "@/components/data/copy-block";
import { CopyValue } from "@/components/data/copy-value";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { contractDifferences, LOAN_KIND_LABEL, offerFigures } from "@/domain/origination/loan-offer";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { loan } from "@/server/db/schema";
import { canSeeLoan } from "@/server/loans/queries";
import { canActOnOffer, checksFor, getOffer, loanCandidates, termsOf } from "@/server/origination/loan-offers";
import { MatchControls } from "@/components/data/match-controls";
import { dateFormat } from "@/lib/dates";
import { getSettings } from "@/server/settings";
import { eq } from "drizzle-orm";
import { OfferActions } from "../offer-actions";
import { OFFER_STATUS } from "../status";

export const metadata: Metadata = { title: "Loan offer" };

const day = dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });

const FLAG = { danger: { icon: CircleAlert, className: "text-danger" }, warning: { icon: TriangleAlert, className: "text-warning" }, info: { icon: Info, className: "text-muted-foreground" } } as const;

export default async function OfferPage({ params }: PageProps<"/loans/offers/[id]">) {
  const viewer = await requireCapabilityPage("loans.originate");
  const { id } = await params;
  const o = await getOffer(viewer, id);
  if (!o) notFound();
  const settings = await getSettings();
  const f = offerFigures(termsOf(o));
  const checks = checksFor(o, settings.loans);
  const [paid] = o.loanId ? await db.select().from(loan).where(eq(loan.id, o.loanId)) : [];
  // Everyone sees every offer; only its officer or management changes it, and the loan page
  // itself stays with the people who manage that loan.
  const mayAct = canActOnOffer(viewer, o);
  const seeLoan = paid ? canSeeLoan(viewer, paid) : false;
  // Correcting the automatic match: the borrower's loans, for the officer or management.
  const canMatch = mayAct && (o.status === "issued" || o.status === "funded");
  const candidates = canMatch
    ? (await loanCandidates(viewer, o.id)).map((c) => ({
        id: c.id,
        label: `${formatCents(c.principalCents)} loan, opened ${c.openedAt ? day.format(c.openedAt) : "?"} (${c.status.replace("_", " ")})`,
        takenBy: c.linkedOfferNumber !== null && c.linkedOfferNumber !== o.number ? `offer #${c.linkedOfferNumber}` : null,
      }))
    : [];
  const linkedLabel = paid ? `the ${formatCents(paid.principalCents)} loan opened ${paid.openedAt ? day.format(paid.openedAt) : "?"}` : null;
  const differences = paid ? contractDifferences(o, paid) : [];
  const status = OFFER_STATUS[o.status];

  return (
    <>
      <PageHeader
        title={`Loan offer ${o.number}`}
        crumbs={[{ label: "Loans", href: "/loans" }, { label: "Offers", href: "/loans/offers" }]}
        meta={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
        description={
          <>
            {LOAN_KIND_LABEL[o.kind]} for{" "}
            <Link href={`/loans/borrowers/${o.borrowerStateId}`} className="text-primary underline underline-offset-4">
              {o.borrowerName} #{o.borrowerStateId}
            </Link>
            {o.officerName ? ` · officer ${o.officerName}` : ""}
          </>
        }
        actions={mayAct ? <OfferActions id={o.id} status={o.status} /> : null}
      />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <StatStrip cols={5}>
            <Kpi label="Loan">
              <Money cents={o.amountCents} />
            </Kpi>
            <Kpi label="Interest rate" hint={`State ${o.stateRateBp / 100}%`}>
              <span className="num">{o.rateBp / 100}%</span>
            </Kpi>
            <Kpi label="Weekly payment" hint={f.lastCents !== f.weeklyCents ? `final ${formatCents(f.lastCents)}` : undefined}>
              <Money cents={f.weeklyCents} />
            </Kpi>
            <Kpi label="Total to repay" hint={`${o.weeks} weeks`}>
              <Money cents={f.totalCents} />
            </Kpi>
            <Kpi label="Litt’s earns" hint="before tax & commission">
              <Money cents={f.littsEarnsCents} />
            </Kpi>
          </StatStrip>

          {!mayAct && (o.status === "draft" || o.status === "issued") ? (
            <Alert variant="info">
              <Info aria-hidden />
              <AlertTitle>{o.officerName ?? "Another officer"}&rsquo;s offer</AlertTitle>
              <AlertDescription>You can see it to help out; only {o.officerName ?? "its officer"} or management can change, issue or cancel it.</AlertDescription>
            </Alert>
          ) : null}

          {o.status === "cancelled" ? (
            <Alert variant="info">
              <Info aria-hidden />
              <AlertTitle>Cancelled</AlertTitle>
              <AlertDescription>
                <LocalTime value={o.cancelledAt} />: {o.cancelReason}
              </AlertDescription>
            </Alert>
          ) : null}

          {paid ? (
            <Alert variant={differences.length ? "danger" : "success"}>
              {differences.length ? <TriangleAlert aria-hidden /> : <Info aria-hidden />}
              <AlertTitle>
                Paid out <LocalTime value={paid.openedAt} format="date" />
                {seeLoan ? (
                  <>
                    {" · "}
                    <Link href={`/loans/${paid.id}`} className="underline underline-offset-4">
                      view the loan
                    </Link>
                  </>
                ) : null}
              </AlertTitle>
              {canMatch ? (
                <div className="col-start-2 mt-2">
                  <MatchControls kind="offer" id={o.id} linked={linkedLabel} candidates={candidates} />
                </div>
              ) : null}
              <AlertDescription>
                {differences.length ? (
                  <ul className="list-disc pl-5">
                    {differences.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                ) : paid.brokerRateBp === null ? (
                  "Its terms will be compared with the contract once its phone card is pasted."
                ) : (
                  "The phone card matches the contract."
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          {o.contractText ? (
            <Card>
              <CardHeader>
                <CardTitle>Contract</CardTitle>
                <CardDescription>
                  Issued <LocalTime value={o.issuedAt} />. Copy it into a Google Doc or message for the borrower to sign.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CopyBlock text={o.contractText} label="contract" />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Repayment schedule</CardTitle>
                <CardDescription>The contract is written when the offer is issued.</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  {f.schedule.map((s) => (
                    <li key={s.number} className="flex justify-between gap-3 border-b py-1">
                      <span>
                        {s.number}. <LocalTime value={s.dueOn} format="date" />
                      </span>
                      <Money cents={s.cents} />
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {canMatch && o.status === "issued" ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Paid out already?</CardTitle>
                <CardDescription>
                  The app links this offer when the game pays it out: same borrower and amount, within three weeks of the contract date. If it hasn&rsquo;t, link the loan by hand.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MatchControls kind="offer" id={o.id} linked={null} candidates={candidates} />
              </CardContent>
            </Card>
          ) : null}

          {o.status === "issued" || o.status === "draft" ? (
            <Card>
              <CardHeader>
                <CardTitle>Enter in the phone</CardTitle>
                <CardDescription>Set the loan up in the game exactly like this.</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="divide-y text-sm">
                  {(
                    [
                      ["Borrower State ID", String(o.borrowerStateId)],
                      ["Loan amount", String(o.amountCents / 100)],
                      ["Broker interest rate", `${o.rateBp / 100}`],
                      ["State interest rate", `${o.stateRateBp / 100}`],
                      ["Payments", String(o.weeks)],
                      ["Every", "7 days"],
                    ] as [string, string][]
                  ).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-3 py-1.5">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="num">
                        <CopyValue value={v} label={k} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Checks</CardTitle>
              <CardDescription>Handbook §4B–C. Warnings only.</CardDescription>
            </CardHeader>
            <CardContent>
              {checks.length ? (
                <ul className="space-y-2 text-sm">
                  {checks.map((c, i) => {
                    const s = FLAG[c.level];
                    return (
                      <li key={i} className="flex items-start gap-2">
                        <s.icon className={cn("mt-0.5 size-4 shrink-0", s.className)} aria-hidden />
                        <span>{c.text}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Within the handbook.</p>
              )}
              {o.suggestedRateBp !== null ? (
                <p className="mt-3 text-xs text-muted-foreground">The rate guide suggested {o.suggestedRateBp / 100}%.</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y text-sm">
                {(
                  [
                    ["Collateral", o.collateral ?? "None"],
                    ["Collateral value", o.collateralValueCents === null ? "—" : <Money key="v" cents={o.collateralValueCents} />],
                    ["Loan-to-value", f.ltvPct === null ? "—" : `${Math.round(f.ltvPct)}%`],
                    ["Weekly income", o.weeklyIncomeCents === null ? "—" : <Money key="i" cents={o.weeklyIncomeCents} />],
                    ["Payment / income", f.paymentToIncomePct === null ? "—" : `${Math.round(f.paymentToIncomePct)}%`],
                    ["Defaulted Account Fee", <span key="d"><Money cents={o.defaultFeePerDayCents} /> a day</span>],
                    ["Contract date", <LocalTime key="c" value={o.startsOn} format="date" />],
                    ...(o.purpose ? [["Purpose", o.purpose] as [string, React.ReactNode]] : []),
                    ["Made", <LocalTime key="m" value={o.createdAt} />],
                  ] as [string, React.ReactNode][]
                ).map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 py-1.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
                  </div>
                ))}
              </dl>
              {o.notes ? <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{o.notes}</p> : null}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
