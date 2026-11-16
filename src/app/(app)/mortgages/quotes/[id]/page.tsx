import { formatCents } from "@/lib/format";
import { eq } from "drizzle-orm";
import { BadgeCheck, CalendarCheck, CircleAlert, Clock, Info, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { CopyValue } from "@/components/data/copy-value";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { approvalLineCents, quoteApproval } from "@/domain/mortgages/approval";
import { quoteDifferences } from "@/domain/origination/mortgage-quote";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { mortgage } from "@/server/db/schema";
import { canSeeMortgage } from "@/server/mortgages/queries";
import { canApproveQuote, canReviewQuote } from "@/server/authz/rules";
import { canActOnQuote, getQuote, inputOf, mortgageCandidates, quoteChecks, quoteMortgage } from "@/server/origination/mortgage-quotes";
import { quoteNotes } from "@/server/origination/quote-review";
import { MatchControls } from "@/components/data/match-controls";
import { dateFormat } from "@/lib/dates";
import { isLiveQuote } from "@/domain/origination/quote-status";
import { quoteAllowance } from "@/server/mortgages/allowance-outlook";
import { getSettings } from "@/server/settings";
import { AllowanceWorking, VerdictAlert } from "../allowance-working";
import { QuoteActions, SigningPassedActions, type ActionQuote } from "../quote-actions";
import { ApprovalNeeded, ReviewNotesCard } from "../review";
import { APPROVAL_STATUS, QUOTE_STATUS, signingTimeHref, VERDICT } from "../status";

export const metadata: Metadata = { title: "Mortgage quote" };

const day = dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });

const dollars = (cents: number) => String(cents / 100);

export default async function QuotePage({ params }: PageProps<"/mortgages/quotes/[id]">) {
  const viewer = await requireCapabilityPage("loans.originate");
  const { id } = await params;
  const q = await getQuote(viewer, id);
  if (!q) notFound();
  const settings = await getSettings();
  const input = inputOf(q);
  const f = quoteMortgage(input);
  const [m] = q.mortgageId ? await db.select().from(mortgage).where(eq(mortgage.id, q.mortgageId)) : [];
  // A closed quote is judged by the rules when its mortgage was arranged; an open one by today's.
  const checks = quoteChecks(input, f, settings.mortgages, isLiveQuote(q.status) ? null : (m?.originatedAt ?? q.createdAt));
  const differences = m ? quoteDifferences({ ...f, brokerRateBp: q.brokerRateBp, fedRateBp: q.fedRateBp }, m) : [];
  const status = QUOTE_STATUS[q.status];
  const now = new Date();
  const live = isLiveQuote(q.status);
  // Signing (research/19 §1–2): confirmed with a time; possibly signed in game, awaiting the tablet.
  const confirmed = q.status === "confirmed";
  const signed = confirmed && q.signedAt !== null;
  const passed = confirmed && !signed && q.expectedSigningAt !== null && q.expectedSigningAt.getTime() < now.getTime();
  // Allowance on signing day: State-funded live quotes not yet signed.
  const onAllowance = live && !q.companyFunded && !signed;
  const working = onAllowance ? await quoteAllowance(viewer, q, now) : null;
  const actionQuote: ActionQuote | null =
    q.status === "draft" || q.status === "confirmed"
      ? {
          id: q.id,
          number: q.number,
          address: q.address,
          buyerName: q.buyerName,
          loanCents: f.loanCents,
          companyFunded: q.companyFunded,
          status: q.status,
          expectedSigningAt: q.expectedSigningAt?.toISOString() ?? null,
          signedAt: q.signedAt?.toISOString() ?? null,
        }
      : null;
  const notes = await quoteNotes(viewer, q.id);
  // Over the executive-approval line (research/18): the officer waits for an executive before using the tablet.
  const approval = quoteApproval({ baseCents: f.baseCents, approvedAt: q.approvedAt }, settings.mortgages);
  const waiting = isLiveQuote(q.status) && approval === "needed";
  const canReview = canReviewQuote(viewer, q) && isLiveQuote(q.status);
  // Everyone sees every quote; only its officer or management changes it.
  const mayAct = canActOnQuote(viewer, q);
  const seeMortgage = m ? canSeeMortgage(viewer, m) : false;
  // Correcting the automatic match: the buyer's mortgages, for the officer or management.
  const canMatch = mayAct && (isLiveQuote(q.status) || q.status === "matched");
  const candidates = canMatch
    ? (await mortgageCandidates(viewer, q.id)).map((c) => ({
        id: c.id,
        label: `${c.address}${c.loanCents !== null ? `, ${formatCents(c.loanCents)} loan` : ""}${c.originatedAt ? `, ${day.format(c.originatedAt)}` : ""}`,
        takenBy: c.linkedQuoteNumber !== null && c.linkedQuoteNumber !== q.number ? `quote #${c.linkedQuoteNumber}` : null,
      }))
    : [];

  const tablet: [string, string, React.ReactNode?][] = [
    ["Buyer State ID", String(q.buyerStateId)],
    ["Total value", dollars(q.priceCents), <Money key="p" cents={q.priceCents} />],
    ["Agency commission", dollars(q.agencyCommissionCents), <Money key="a" cents={q.agencyCommissionCents} />],
    ["Down payment", dollars(f.downPaymentCents), <span key="d"><Money cents={f.downPaymentCents} /> <span className="text-muted-foreground">({q.downPaymentBp / 100}%)</span></span>],
    ["Loan amount", dollars(f.loanCents), <Money key="l" cents={f.loanCents} />],
    ["Term (months)", String(q.termMonths)],
    q.companyFunded ? ["Fed rate (%)", "", "None: company-funded"] : ["Fed rate (%)", String(q.fedRateBp / 100)],
    ["Broker rate (%)", String(q.brokerRateBp / 100)],
    ["Broker fee", dollars(f.bankerFeeCents), <span key="b"><Money cents={f.bankerFeeCents} /> <span className="text-muted-foreground">({q.bankerFeeBp / 100}%)</span></span>],
  ];

  return (
    <>
      <PageHeader
        title={`Mortgage quote ${q.number}`}
        crumbs={[
          { label: "Mortgages", href: "/mortgages" },
          { label: "Quotes", href: "/mortgages/quotes" },
        ]}
        meta={
          <span className="flex flex-wrap gap-1.5">
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            {signed ? <StatusBadge tone="info">Signed, awaiting tablet</StatusBadge> : null}
            {working ? <StatusBadge tone={VERDICT[working.quote.verdict].tone}>{VERDICT[working.quote.verdict].label}</StatusBadge> : null}
            {isLiveQuote(q.status) && approval !== "not_needed" ? <StatusBadge tone={APPROVAL_STATUS[approval].tone}>{APPROVAL_STATUS[approval].label}</StatusBadge> : null}
          </span>
        }
        description={
          <>
            {q.address} for {q.buyerName} #{q.buyerStateId}
            {q.officerName ? ` · officer ${q.officerName}` : ""}
          </>
        }
        actions={actionQuote && mayAct ? <QuoteActions quote={actionQuote} /> : null}
      />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <StatStrip cols={4}>
            <Kpi label="Loan" hint={`${Math.round(f.ltvPct)}% of down + loan`}>
              <Money cents={f.loanCents} />
            </Kpi>
            <Kpi label="Weekly payment" hint={`${f.instalments} weeks`}>
              <Money cents={f.weeklyCents} />
            </Kpi>
            <Kpi label="Buyer pays at signing" hint="incl. 5% tax">
              <Money cents={f.dueAtSigningCents} />
            </Kpi>
            <Kpi label="Litt’s earns" hint="fee + broker interest">
              <Money cents={f.littsEarnsCents} />
            </Kpi>
          </StatStrip>

          {passed ? (
            <Alert variant="warning">
              <Clock aria-hidden />
              <AlertTitle>Signing time passed: did it sign?</AlertTitle>
              <AlertDescription>
                <p>
                  Bidding was due to close <LocalTime value={q.expectedSigningAt} />.
                  {q.companyFunded ? null : " Until someone answers, it counts against the State allowance as if it signs now."}
                </p>
                {actionQuote && mayAct ? <SigningPassedActions quote={actionQuote} /> : <p>Only {q.officerName ?? "its officer"} or management can answer.</p>}
              </AlertDescription>
            </Alert>
          ) : signed ? (
            <Alert variant="info">
              <CalendarCheck aria-hidden />
              <AlertTitle>
                Signed in game <LocalTime value={q.signedAt} /> · waiting for the tablet agreement
              </AlertTitle>
              <AlertDescription>
                {q.signedByName ? `Marked by ${q.signedByName}. ` : null}
                {can(viewer.role, "imports.paste") ? (
                  <>
                    Paste the sale agreement on{" "}
                    <Link href="/mortgages/import" className="underline underline-offset-4">
                      Paste from tablet
                    </Link>{" "}
                    and this quote links itself.
                  </>
                ) : (
                  "Once the sale agreement is pasted, this quote links itself."
                )}
              </AlertDescription>
            </Alert>
          ) : confirmed ? (
            <Alert variant="info">
              <CalendarCheck aria-hidden />
              <AlertTitle>
                Confirmed{q.confirmedByName ? ` by ${q.confirmedByName}` : ""} · signing <LocalTime value={q.expectedSigningAt} />
              </AlertTitle>
              <AlertDescription>
                {q.companyFunded ? "Company-funded, so it doesn’t use the State allowance." : "It draws on the State allowance at that time."} Changing its figures moves it
                back to Draft; moving the signing time doesn&rsquo;t.
              </AlertDescription>
            </Alert>
          ) : null}

          {waiting ? (
            <ApprovalNeeded
              quoteId={q.id}
              canApprove={canApproveQuote(viewer)}
              canAskForChanges={canReview}
              over={`Down payment + loan ${formatCents(f.baseCents)} is over ${formatCents(approvalLineCents(settings.mortgages))}`}
            />
          ) : null}
          {isLiveQuote(q.status) && approval === "approved" ? (
            <Alert variant="success">
              <BadgeCheck aria-hidden />
              <AlertTitle>Approved{q.approvedByName ? ` by ${q.approvedByName}` : ""}</AlertTitle>
              <AlertDescription>
                <LocalTime value={q.approvedAt} />. It can go on the tablet. Changing its terms clears the approval.
              </AlertDescription>
            </Alert>
          ) : null}

          {!mayAct && isLiveQuote(q.status) ? (
            <Alert variant="info">
              <Info aria-hidden />
              <AlertTitle>{q.officerName ?? "Another officer"}&rsquo;s quote</AlertTitle>
              <AlertDescription>You can see it to help out; only {q.officerName ?? "its officer"} or management can change or cancel it.</AlertDescription>
            </Alert>
          ) : null}

          {q.status === "cancelled" ? (
            <Alert variant="info">
              <Info aria-hidden />
              <AlertTitle>Cancelled</AlertTitle>
              <AlertDescription>
                <LocalTime value={q.cancelledAt} />: {q.cancelReason}
              </AlertDescription>
            </Alert>
          ) : null}

          {m ? (
            <Alert variant={differences.length ? "danger" : "success"}>
              {differences.length ? <TriangleAlert aria-hidden /> : <Info aria-hidden />}
              <AlertTitle>
                Became the mortgage on{" "}
                {seeMortgage ? (
                  <Link href={`/mortgages/${m.id}`} className="underline underline-offset-4">
                    {m.address}
                  </Link>
                ) : (
                  m.address
                )}
              </AlertTitle>
              {canMatch ? (
                <div className="col-start-2 mt-2">
                  <MatchControls kind="quote" id={q.id} linked={m.address} candidates={candidates} />
                </div>
              ) : null}
              <AlertDescription>
                {differences.length ? (
                  <ul className="list-disc pl-5">
                    {differences.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                ) : m.loanCents === null ? (
                  "Its terms are compared with the quote once the sale agreement is pasted."
                ) : (
                  "The sale agreement matches the quote."
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          {notes.length || canReview ? (
            <ReviewNotesCard
              quoteId={q.id}
              notes={notes.map((n) => ({ ...n, at: n.at.toISOString(), done: n.done ? { ...n.done, at: n.done.at.toISOString() } : null }))}
              canAdd={canReview}
              canResolve={mayAct && isLiveQuote(q.status)}
              officerName={q.officerName ?? "the officer"}
              isOfficer={q.officerStaffId === viewer.staffId}
            />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{waiting ? "Terms, waiting for approval" : isLiveQuote(q.status) ? "Enter on the tablet" : "Quoted terms"}</CardTitle>
              <CardDescription>
                {waiting
                  ? "Don’t type these into the tablet until an executive approves the quote."
                  : isLiveQuote(q.status)
                    ? "Fill in the Sale Agreement – Financed form with these figures. Paste the agreement into the app afterwards and this quote links itself to the mortgage."
                    : "As quoted to the buyer."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="divide-y text-sm">
                {tablet.map(([k, v, display]) => (
                  <div key={k} className="flex items-center justify-between gap-3 py-1.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="num">{isLiveQuote(q.status) && !waiting && v ? <CopyValue value={v} display={display} label={k} /> : (display ?? v)}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>The figures</CardTitle>
              <CardDescription>What the tablet works out from these terms.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-8 text-sm sm:grid-cols-2">
                {(
                  [
                    ["Down payment + loan", f.baseCents],
                    ["Broker interest", f.brokerInterestCents],
                    ["Federal interest", f.federalInterestCents],
                    ["Weekly payment", f.weeklyCents],
                    ["Final payment", f.lastWeeklyCents],
                    ["Tax at signing (5%)", f.taxCents],
                    ["Price after tax", f.afterTaxCents],
                    ["Banker fee", f.bankerFeeCents],
                  ] as [string, number][]
                ).map(([k, c]) => (
                  <div key={k} className="flex justify-between gap-3 border-b py-1.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd>
                      <Money cents={c} />
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {onAllowance ? (
            <Card id="allowance">
              <CardHeader>
                <CardTitle>Allowance on signing day</CardTitle>
                <CardDescription>
                  {!q.expectedSigningAt ? (
                    <>
                      No signing time yet.{" "}
                      {mayAct ? (
                        <>
                          <Link href={signingTimeHref(q.id)} className="underline underline-offset-4 hover:text-foreground">
                            Set when the bidding closes
                          </Link>{" "}
                          to see whether it fits on the day.
                        </>
                      ) : (
                        "Once it has one, this shows whether it fits on the day."
                      )}
                    </>
                  ) : working?.quote.passed ? (
                    "The signing time has passed, so this is as if it signs now."
                  ) : working ? (
                    <>
                      {confirmed ? "Signing" : "If it signs"} <LocalTime value={working.quote.signingAt} />
                      {confirmed ? "." : ". Drafts don’t draw on the allowance until they’re confirmed."}
                    </>
                  ) : (
                    "No State allowance reading yet, so there’s nothing to project from."
                  )}
                </CardDescription>
              </CardHeader>
              {working ? (
                <CardContent className="space-y-3">
                  <AllowanceWorking view={working} />
                  <VerdictAlert view={working} context={confirmed ? "confirmed" : "draft"} />
                </CardContent>
              ) : null}
            </Card>
          ) : null}

          {canMatch && isLiveQuote(q.status) ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>On the tablet already?</CardTitle>
                <CardDescription>
                  The app links this quote when the sale agreement is pasted: same buyer, and the same loan or address, within 30 days. If it hasn&rsquo;t, link the mortgage by hand.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MatchControls kind="quote" id={q.id} linked={null} candidates={candidates} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Checks</CardTitle>
              <CardDescription>Federal maximums (owner, 15 Oct 2026) are enforced: a quote over them can&rsquo;t be saved. The rest is handbook §4A guidance.</CardDescription>
            </CardHeader>
            <CardContent>
              {checks.length ? (
                <ul className="space-y-2 text-sm">
                  {checks.map((c, i) => {
                    const Icon = c.level === "breach" ? CircleAlert : TriangleAlert;
                    return (
                      <li key={i} className="flex items-start gap-2">
                        <Icon className={cn("mt-0.5 size-4 shrink-0", c.level === "breach" ? "text-danger" : "text-warning")} aria-hidden />
                        <span>{c.text}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Within the federal maximums and the handbook.</p>
              )}
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
                    ["Funding", q.companyFunded ? "Company-funded (Litt’s lends the money)" : "State"],
                    ["Primary residence", q.primaryResidence ? "Yes" : "No"],
                    [
                      "Executive approval",
                      approval === "not_needed" ? (
                        `Not needed (${formatCents(approvalLineCents(settings.mortgages))} or less)`
                      ) : q.approvedAt ? (
                        <span key="ap">
                          {q.approvedByName ?? "An executive"}, <LocalTime value={q.approvedAt} />
                        </span>
                      ) : (
                        "Not approved"
                      ),
                    ],
                    ["Made", <LocalTime key="m" value={q.createdAt} />],
                    ...(q.matchedAt ? [["Matched", <LocalTime key="x" value={q.matchedAt} />] as [string, React.ReactNode]] : []),
                  ] as [string, React.ReactNode][]
                ).map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 py-1.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="min-w-0">{v}</dd>
                  </div>
                ))}
              </dl>
              {q.notes ? <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{q.notes}</p> : null}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
