import { formatCents } from "@/lib/format";
import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dayMonth, isPeriodKey } from "@/domain/commissions/week";
import { can } from "@/lib/permissions";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { officerSuggestions } from "@/server/commissions/officers";
import { staffOptions } from "@/server/commissions/queries";
import { bankNotCoveredMessage, getWeek } from "@/server/commissions/service";
import { CloseWeekButton, RosterForm, SuggestedOfficers, WalletLinks } from "../commission-forms";

export const metadata: Metadata = { title: "Commission week" };


export default async function CommissionWeekPage({ params }: PageProps<"/commissions/[week]">) {
  const viewer = await requireCapabilityPage("commissions.view_all");
  const { week: key } = await params;
  if (!isPeriodKey(key)) notFound();
  const w = await getWeek(key);
  const [officers, staff] = w.catchUp && w.status === "open" ? await Promise.all([officerSuggestions(), staffOptions()]) : [null, []];
  const manage = can(viewer.role, "commissions.manage");
  const c = w.calculation;
  const total = [...c.totals.values()].reduce((s, v) => s + v, 0);

  // Per person: totals by kind.
  const people = [...new Set(c.lines.filter((l) => l.staffId).map((l) => l.staffId!))];
  const sum = (id: string, kind: string) => c.lines.filter((l) => l.staffId === id && l.kind === kind).reduce((s, l) => s + l.amountCents, 0);
  const included = w.roster.filter((r) => r.included).length;

  const disabledReason =
    w.status === "closed"
      ? "Closed."
      : !w.ended
        ? w.catchUp
          ? "Can be closed from Monday 12 October, once the last receipts before the scheme are in."
          : "The week hasn't ended yet."
        : !w.bankCovers
          ? bankNotCoveredMessage(w)
          : !w.rosterLocked
            ? "Lock the pool roster first."
            : c.problems.length
              ? "Fix the items above first."
              : null;

  return (
    <>
      <PageHeader
        title={w.catchUp ? "Catch-up before 12 October" : `Week of ${w.label}`}
        crumbs={[{ label: "Commissions", href: "/commissions" }]}
        description={
          <span className="flex items-center gap-2">
            {w.status === "closed" ? <StatusBadge tone="success">Closed</StatusBadge> : w.ended ? <StatusBadge tone="warning">Ended, not closed</StatusBadge> : <StatusBadge tone="info">In progress (estimate)</StatusBadge>}
            {w.catchUp ? <span>{w.label.replace("Catch-up · ", "")} · loan interest no earlier commission payment covered</span> : null}
          </span>
        }
      />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          {c.problems.length ? (
            <Alert variant="warning">
              <TriangleAlert aria-hidden />
              <AlertTitle>Can&rsquo;t be paid yet</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-5">
                  {c.problems.map((p, i) => (
                    <li key={i}>
                      {p.loanId ? (
                        <Link href={`/loans/${p.loanId}`} className="underline underline-offset-4">
                          {p.label}
                        </Link>
                      ) : p.mortgageId ? (
                        <Link href={`/mortgages/${p.mortgageId}`} className="underline underline-offset-4">
                          {p.label}
                        </Link>
                      ) : (
                        p.label
                      )}{" "}
                      · {p.kind === "no_officer" ? "no officer assigned" : "banker fee unknown (paste it from the tablet)"}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {w.catchUp ? (
            <StatStrip cols={3}>
              <Kpi label={w.status === "closed" ? "Commission booked" : "Commission so far"}>
                <Money cents={total} />
              </Kpi>
              <Kpi label="Receipts to pay" hint="Interest since 25 Aug no earlier payment covered">
                <span className="num">{c.lines.length}</span>
              </Kpi>
              <Kpi label="Already paid" hint="Listed in an old commission payment, so left out">
                <span className="num">{w.paidBefore.length}</span>
              </Kpi>
            </StatStrip>
          ) : (
            <StatStrip cols={3}>
              <Kpi label={w.status === "closed" ? "Commission booked" : "Commission so far"}>
                <Money cents={total} />
              </Kpi>
              <Kpi label="Mortgage pool" hint={
                  c.pool.members
                    ? `${c.pool.members} ${c.pool.members === 1 ? "person" : "people"} · ${formatCents(c.pool.perPersonCents)} each`
                    : "Nobody confirmed yet"
                }>
                <Money cents={c.pool.totalCents} />
              </Kpi>
              <Kpi label="Company keeps" hint="50% of banker fees, plus any pool not shared out">
                <Money cents={c.companyShareCents} />
              </Kpi>
            </StatStrip>
          )}

          <Card>
            <CardHeader>
              <CardTitle>By person</CardTitle>
              <CardDescription>Each person&rsquo;s total is rounded to whole dollars.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {people.length === 0 ? (
                <p className="px-6 text-sm text-muted-foreground">Nothing earned {w.catchUp ? "yet" : "this week"}.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Person</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Loan interest</TableHead>
                      {w.catchUp ? null : <TableHead className="hidden text-right sm:table-cell">Banker fees</TableHead>}
                      {w.catchUp ? null : <TableHead className="hidden text-right sm:table-cell">Pool</TableHead>}
                      <TableHead className="pr-6 text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {people.map((id) => (
                      <TableRow key={id}>
                        <TableCell className="pl-6">{w.names[id] ?? "Former staff"}</TableCell>
                        <TableCell className="hidden text-right sm:table-cell">
                          <Money cents={sum(id, "loan_interest")} />
                        </TableCell>
                        {w.catchUp ? null : (
                          <TableCell className="hidden text-right sm:table-cell">
                            <Money cents={sum(id, "mortgage_originator")} />
                          </TableCell>
                        )}
                        {w.catchUp ? null : (
                          <TableCell className="hidden text-right sm:table-cell">
                            <Money cents={sum(id, "mortgage_pool")} />
                          </TableCell>
                        )}
                        <TableCell className="pr-6 text-right font-medium">
                          <Money cents={c.totals.get(id) ?? 0} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Lines</CardTitle>
              <CardDescription>Every receipt that earned commission {w.catchUp ? "in this period" : "this week"}.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">What</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Of</TableHead>
                    <TableHead className="pr-6 text-right">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {c.lines.map((l, i) => (
                    <TableRow key={i}>
                      <TableCell className="pl-6 whitespace-normal">{l.label}</TableCell>
                      <TableCell>{l.staffId ? (w.names[l.staffId] ?? "Former staff") : <span className="text-warning">No officer</span>}</TableCell>
                      <TableCell className="hidden text-right sm:table-cell">
                        <Money cents={l.baseCents} />
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <Money cents={l.amountCents} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {w.paidBefore.length ? (
            <Card>
              <CardHeader>
                <CardTitle>Already paid before the scheme</CardTitle>
                <CardDescription>
                  Listed in an old &ldquo;Commission Pay&rdquo; payment (same borrower, within a day), so left out. If one of these wasn&rsquo;t really paid, tell
                  the officer and pay it by hand.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <details>
                  <summary className="cursor-pointer px-6 pb-2 text-sm font-medium">Show the {w.paidBefore.length} receipts</summary>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-6">Receipt</TableHead>
                        <TableHead className="hidden text-right sm:table-cell">Net interest</TableHead>
                        <TableHead className="text-right">Paid</TableHead>
                        <TableHead className="pr-6">On</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {w.paidBefore.map((p) => (
                        <TableRow key={p.txId}>
                          <TableCell className="pl-6 whitespace-normal">
                            <Link href={`/loans/${p.loanId}`} className="underline-offset-4 hover:underline">
                              {p.label}
                            </Link>
                          </TableCell>
                          <TableCell className="hidden text-right sm:table-cell">
                            <Money cents={p.netCents} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Money cents={p.paidCents} />
                          </TableCell>
                          <TableCell className="pr-6">{dayMonth(p.paidAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </details>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          {w.catchUp ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>How the catch-up works</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    Commission on loan interest was last paid by hand on 27 September. This period pays 50% of every loan interest receipt (after tax) since 25
                    August that no old payment listed, to the loan&rsquo;s officer. Banker fees aren&rsquo;t included: they were paid under the old scheme.
                  </p>
                  <p>Close it from 12 October, then pay each person; their payouts settle it like any week.</p>
                </CardContent>
              </Card>
              {officers && manage ? (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle>Suggested officers</CardTitle>
                      <CardDescription>From who was paid commission on each borrower before. Untick any that aren&rsquo;t right.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <SuggestedOfficers
                        key={officers.suggestions.filter((s) => s.staffId).map((s) => s.loanId).join()}
                        suggestions={officers.suggestions
                          .filter((s) => s.staffId)
                          .map((s) => ({ loanId: s.loanId, borrower: s.borrower, status: s.status, staffName: w.names[s.staffId!] ?? "", basis: s.basis, inCatchUp: s.inCatchUp }))}
                        waiting={officers.suggestions.filter((s) => !s.staffId).length}
                      />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Who was paid before</CardTitle>
                      <CardDescription>
                        Wallets the old commission payments went to. Link each to its person and their later payouts match by themselves.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <WalletLinks
                        wallets={officers.wallets.map((x) => ({ wallet: x.wallet, staffName: x.staffName, payouts: x.payouts, borrowers: x.borrowers, lastPaid: dayMonth(x.lastPaidAt) }))}
                        staff={staff.filter((s) => !s.walletId)}
                      />
                    </CardContent>
                  </Card>
                </>
              ) : null}
            </>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Mortgage pool roster</CardTitle>
                <CardDescription>
                  Ticked people share the pool equally. The app suggests anyone active this week; you confirm and lock it once the week has ended.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {manage && w.status === "open" ? (
                  <RosterForm
                    weekKey={w.key}
                    roster={w.roster}
                    locked={w.rosterLocked}
                    ended={w.ended}
                    perPersonHint={`${included} ticked. Pool so far: ${formatCents(c.pool.totalCents)}.`}
                  />
                ) : (
                  <ul className="space-y-1 text-sm">
                    {w.roster
                      .filter((r) => r.included)
                      .map((r) => (
                        <li key={r.staffId}>{r.name}</li>
                      ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
          {manage && w.status === "open" ? (
            <Card>
              <CardHeader>
                <CardTitle>{w.catchUp ? "Close the catch-up" : "Close the week"}</CardTitle>
                <CardDescription>
                  Freezes these figures and books them: commission expense, owed to staff until paid. Closed weeks can&rsquo;t be changed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CloseWeekButton weekKey={w.key} totalCents={total} disabledReason={disabledReason} label={w.catchUp ? "Close catch-up" : "Close week"} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </PageBody>
    </>
  );
}
