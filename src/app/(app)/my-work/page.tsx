import { ArrowRight, CircleCheck, FilePlus2, FileSignature } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { DataAsOf } from "@/components/data/data-as-of";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { RowLink, linkedRow } from "@/components/data/row-link";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { COLLECTION_LABEL } from "@/server/loans/collections";
import { dataFreshness } from "@/server/freshness";
import { myWork } from "@/server/my-work";
import { inputOf, quoteMortgage } from "@/server/origination/mortgage-quotes";
import { OFFER_STATUS } from "../loans/offers/status";
import { QUOTE_STATUS } from "../mortgages/quotes/status";

export const metadata: Metadata = { title: "My work" };

const CHASE_STATUS = {
  overdue: { label: "Overdue", tone: "warning" },
  defaulted: { label: "Defaulted", tone: "danger" },
  written_off: { label: "Written off", tone: "neutral" },
  late: { label: "Mortgage late", tone: "warning" },
  behind: { label: "Mortgage behind", tone: "danger" },
} as const;

/** An officer's day (owner, 2026-10-11): what's due in, who to chase, deals in progress, commission. */
export default async function MyWorkPage() {
  const viewer = await requireCapabilityPage("loans.originate");
  const [w, freshness] = await Promise.all([myWork(viewer), dataFreshness()]);
  const dueCents = w.dueThisWeek.reduce((s, l) => s + (l.weeklyCents ?? 0), 0);
  const chaseNow = w.toChase.filter((r) => r.due).length;

  return (
    <>
      <PageHeader
        title="My work"
        description="Your loans, mortgages and open deals."
        actions={
          <>
            <Button variant="outline" render={<Link href="/mortgages/quotes/new" />}>
              <FileSignature aria-hidden /> New quote
            </Button>
            <Button render={<Link href="/loans/new" />}>
              <FilePlus2 aria-hidden /> New loan
            </Button>
          </>
        }
      />
      <PageBody className="space-y-6">
        <StatStrip cols={5}>
          <Kpi label="My open loans" hint={<Money cents={w.loans.owedCents} />} href="/loans?officer=mine">
            {w.loans.open}
          </Kpi>
          <Kpi label="Due in this week" hint={`${w.dueThisWeek.length} payment${w.dueThisWeek.length === 1 ? "" : "s"}`}>
            <Money cents={dueCents} />
          </Kpi>
          <Kpi label="To chase" tone={chaseNow ? "warn" : undefined} hint={chaseNow ? `${chaseNow} need action now` : w.toChase.length ? "none need action now" : "nobody behind"}>
            {w.toChase.length}
          </Kpi>
          <Kpi label="My mortgages" tone={w.mortgages.late ? "warn" : undefined} hint={w.mortgages.late ? `${w.mortgages.late} late` : "all on track"} href="/mortgages">
            {w.mortgages.open}
          </Kpi>
          <Kpi label="Commission this week" hint={w.commission.started ? (w.commission.owedCents ? <>owed to you <Money cents={w.commission.owedCents} /></> : "so far, before closing") : "scheme not started"} href="/commissions">
            <Money cents={w.commission.estimateCents} />
          </Kpi>
        </StatStrip>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card>
            <CardHeader>
              <CardTitle>To chase</CardTitle>
              <CardDescription>Your borrowers who are behind, most urgent first.</CardDescription>
              <CardAction>
                <Button size="sm" variant="ghost" render={<Link href="/loans/collections" />}>
                  Collections <ArrowRight aria-hidden />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              {w.toChase.length ? (
                <Table scrollLabel="To chase">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Borrower</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Owed</TableHead>
                      <TableHead className="hidden pr-6 sm:table-cell">Last action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {w.toChase.slice(0, 10).map((r) => {
                      const st = CHASE_STATUS[r.status];
                      return (
                        <TableRow key={`${r.type}-${r.id}`} className={linkedRow}>
                          <TableCell className="pl-6">
                            <RowLink href={r.href}>{r.borrower}</RowLink>
                            {r.stateId ? <div className="ident text-xs text-muted-foreground">#{r.stateId}</div> : null}
                          </TableCell>
                          <TableCell>
                            <span className="flex flex-wrap gap-1">
                              <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                              {r.due ? <StatusBadge tone="warning">Action due</StatusBadge> : null}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <Money cents={r.owedCents} />
                          </TableCell>
                          <TableCell className="hidden pr-6 text-sm sm:table-cell">
                            {r.last ? (
                              <>
                                {COLLECTION_LABEL[r.last.kind]}
                                <div className="text-xs text-muted-foreground">
                                  <LocalTime value={r.last.at} format="relative" />
                                </div>
                              </>
                            ) : (
                              <span className="text-muted-foreground">Not contacted</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="flex items-center gap-2 px-6 text-sm text-muted-foreground">
                  <CircleCheck className="size-4 text-success" aria-hidden /> None of your borrowers is behind.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Due in the next 7 days</CardTitle>
              <CardDescription>Your loans’ next payments, from the latest phone cards.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {w.dueThisWeek.length ? (
                <ul className="divide-y border-t">
                  {w.dueThisWeek.map((l) => (
                    <li key={l.id}>
                      <Link href={`/loans/${l.id}`} className="flex items-center gap-3 px-6 py-2.5 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{l.borrowerName ?? `State ID ${l.borrowerStateId}`}</span>
                          <span className="block text-xs text-muted-foreground">
                            Payment {(l.lastCompleted ?? 0) + 1} of {l.instalments ?? "?"} · <LocalTime value={l.nextPaymentDueAt} format="date" />
                          </span>
                        </span>
                        {l.status === "overdue" ? <StatusBadge tone="warning">Overdue</StatusBadge> : null}
                        <span className="text-right">{l.weeklyCents !== null ? <Money cents={l.weeklyCents} /> : <span className="text-muted-foreground">—</span>}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-6 text-sm text-muted-foreground">No payments due on your loans this week.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Deals in progress</CardTitle>
            <CardDescription>Loan offers not yet paid out and mortgage quotes not yet on the tablet.</CardDescription>
            <CardAction className="flex gap-1">
              <Button size="sm" variant="ghost" render={<Link href="/loans/offers" />}>
                Offers
              </Button>
              <Button size="sm" variant="ghost" render={<Link href="/mortgages/quotes" />}>
                Quotes
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            {w.offers.length || w.quotes.length ? (
              <ul className="divide-y border-t">
                {w.offers.map((o) => (
                  <li key={o.id}>
                    <Link href={`/loans/offers/${o.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2.5 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">Loan offer #{o.number}</span> · {o.borrowerName}
                        <span className="block text-xs text-muted-foreground">
                          {o.rateBp / 100}% over {o.weeks} weeks · made <LocalTime value={o.createdAt} format="relative" />
                        </span>
                      </span>
                      <StatusBadge tone={OFFER_STATUS[o.status].tone}>{OFFER_STATUS[o.status].label}</StatusBadge>
                      <Money cents={o.amountCents} />
                    </Link>
                  </li>
                ))}
                {w.quotes.map((q) => (
                  <li key={q.id}>
                    <Link href={`/mortgages/quotes/${q.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2.5 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">Mortgage quote #{q.number}</span> · {q.address}
                        <span className="block text-xs text-muted-foreground">
                          {q.buyerName} · made <LocalTime value={q.createdAt} format="relative" />
                        </span>
                      </span>
                      {q.expectedSigningAt ? (
                        <span className="text-xs text-muted-foreground">
                          Signing <LocalTime value={q.expectedSigningAt} />
                        </span>
                      ) : null}
                      <StatusBadge tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</StatusBadge>
                      <Money cents={quoteMortgage(inputOf(q)).loanCents} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-6 text-sm text-muted-foreground">
                Nothing open. Start a <Link href="/loans/new" className="text-primary underline underline-offset-4">new loan</Link> or a{" "}
                <Link href="/mortgages/quotes/new" className="text-primary underline underline-offset-4">mortgage quote</Link>.
              </p>
            )}
          </CardContent>
        </Card>
        <DataAsOf freshness={freshness} sources={["cards", "tablet", "bank"]} />
      </PageBody>
    </>
  );
}
