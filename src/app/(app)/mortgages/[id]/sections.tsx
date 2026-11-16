import Link from "next/link";
import { Fact } from "@/components/data/fact";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { bankerFeeBasis } from "@/domain/mortgages/schedule";
import { formatBp } from "@/lib/format";
import type { getMortgage } from "@/server/mortgages/queries";
import { MortgageNoteForm } from "./mortgage-panels";

/** The mortgage page's sections (owner review 2026-10-11: the page was 470 lines). Server components. */

export type MortgageData = NonNullable<Awaited<ReturnType<typeof getMortgage>>>;

const EVENT_LABEL: Record<string, string> = {
  originated: "Down payment received",
  origination_linked: "Linked to its down payment",
  created_from_tablet: "Added from the tablet",
  terms_set: "Details read from the tablet",
  terms_changed: "Tablet details changed",
  tablet_seen: "Tablet details re-pasted",
  officer_assigned: "Officer assigned",
  officer_changed: "Officer changed",
  completed: "All payments made",
  company_funded_booked: "Booked as a loan from company funds",
  merged: "Duplicate record merged in",
  merged_into: "Merged into another record",
  note: "Note",
  collection_logged: "Collections action logged",
  executive_approved: "Approved by an executive after the fact",
  address_changed: "Address changed in the game",
};

const pct = (bp: number | null) => (bp === null ? "—" : formatBp(bp));
const money = (c: number | null) => (c === null ? <span className="text-muted-foreground">—</span> : <Money cents={c} />);

/** The next instalment not yet paid, if any. */
export const nextInstalment = (data: MortgageData) => data.analysis?.matched.find((x) => !x.payment);

export function AgreementCard({ data }: { data: MortgageData }) {
  const m = data.mortgage;
  const company = m.funding === "company";
  const feeBasis = bankerFeeBasis(m);
  const ltv = m.loanCents !== null && m.priceCents ? Math.round((m.loanCents / m.priceCents) * 1000) / 10 : null;
  const next = nextInstalment(data);
  // Before the tablet paste every term is unknown: say so once instead of a grid of dashes (UX review 2026-10-12).
  if (!m.lastTabletAt) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agreement</CardTitle>
          <CardDescription>Not pasted from the tablet yet. Price, terms, rates and parties appear here once it is; the bank&rsquo;s figures are below.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="divide-y md:w-1/2">
            <Fact labelWidth="9.5rem" label="Started">
              <LocalTime value={m.originatedAt} />
            </Fact>
          </dl>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agreement</CardTitle>
        <CardDescription>
          Terms and parties from the tablet
          {m.lastTabletAt ? (
            <>
              {" "}
              (<LocalTime value={m.lastTabletAt} format="relative" />)
            </>
          ) : null}
          ; money from the bank.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-x-8 md:grid-cols-2">
        <dl className="divide-y">
          <Fact labelWidth="9.5rem" label="Price">
            {money(m.priceCents)}
          </Fact>
          <Fact labelWidth="9.5rem" label="Down payment">
            {money(m.downPaymentCents)}
          </Fact>
          <Fact labelWidth="9.5rem" label={company ? "Loan (from Litt's)" : "Loan (from the State)"}>
            {money(m.loanCents)}
            {ltv !== null ? <span className="text-muted-foreground"> · LTV {ltv}%</span> : null}
          </Fact>
          <Fact labelWidth="9.5rem" label="Banker fee">
            {money(m.brokerFeeCents)}
            {m.brokerFeeCents !== null && feeBasis ? (
              <span className="text-muted-foreground"> · {Math.round((m.brokerFeeCents / feeBasis) * 1000) / 10}% of down payment + loan</span>
            ) : null}
          </Fact>
          <Fact labelWidth="9.5rem" label="Agency commission">
            {money(m.agencyCommissionCents)}
          </Fact>
          <Fact labelWidth="9.5rem" label="Broker interest">
            {money(m.brokerInterestCents)}
            {m.brokerRateBp !== null ? <span className="text-muted-foreground"> ({pct(m.brokerRateBp)})</span> : null}
          </Fact>
          <Fact labelWidth="9.5rem" label="Federal interest">
            {company ? (
              <span className="text-muted-foreground">None (company funds)</span>
            ) : (
              <>
                {money(m.federalInterestCents)}
                {m.fedRateBp !== null ? <span className="text-muted-foreground"> ({pct(m.fedRateBp)})</span> : null}
              </>
            )}
          </Fact>
        </dl>
        <dl className="divide-y">
          <Fact labelWidth="9.5rem" label="Term">
            {m.instalments ? `${m.instalments} weekly payments` : "—"}
            {m.termMonths ? ` (${m.termMonths} months)` : ""}
          </Fact>
          <Fact labelWidth="9.5rem" label="Late fee · grace">
            {m.lateFeeCents === null && m.gracePeriodDays === null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <>
                {money(m.lateFeeCents)} · {m.gracePeriodDays ?? "—"} days
              </>
            )}
          </Fact>
          <Fact labelWidth="9.5rem" label="Started">
            <LocalTime value={m.originatedAt} />
          </Fact>
          <Fact labelWidth="9.5rem" label="Next payment">
            {next ? <LocalTime value={next.instalment.dueAt} /> : "—"}
          </Fact>
          <Fact labelWidth="9.5rem" label="Agency">
            {m.agencyName ?? "—"}
            {m.agentName ? (
              <span className="text-muted-foreground">
                {" "}
                · {m.agentName} <span className="ident">#{m.agentStateId}</span>
              </span>
            ) : null}
          </Fact>
          <Fact labelWidth="9.5rem" label="Seller">
            {m.ownerName ?? "—"}
          </Fact>
        </dl>
      </CardContent>
    </Card>
  );
}

export function MortgagePaymentsCard({ data }: { data: MortgageData }) {
  const { analysis } = data;
  if (!analysis) return null;
  const company = data.mortgage.funding === "company";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
        <CardDescription>
          {analysis.paidCount} of {analysis.schedule.length} paid · <Money cents={analysis.principalRemainingCents} /> still owed to {company ? "Litt's" : "the State"} ·{" "}
          <Money cents={analysis.brokerInterestRemainingCents} /> broker interest to come
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="max-h-[32rem] overflow-y-auto focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" tabIndex={0} role="region" aria-label="Payment schedule">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead className="pl-6">#</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Principal</TableHead>
                <TableHead className="hidden text-right md:table-cell">Broker</TableHead>
                <TableHead className="text-right">Weekly</TableHead>
                <TableHead className="pr-6">Paid</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analysis.matched.map(({ instalment: r, payment, differenceCents }) => (
                <TableRow key={r.number}>
                  <TableCell className="num pl-6">{r.number}</TableCell>
                  <TableCell>
                    <LocalTime value={r.dueAt} format="date" />
                  </TableCell>
                  <TableCell className="hidden text-right sm:table-cell">
                    <Money cents={r.principalCents} />
                  </TableCell>
                  <TableCell className="hidden text-right md:table-cell">
                    <Money cents={r.brokerInterestCents} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={r.totalCents} />
                  </TableCell>
                  <TableCell className="pr-6 whitespace-normal">
                    {payment ? (
                      <span className="flex flex-wrap items-center gap-1">
                        <StatusBadge tone="success">Paid</StatusBadge>
                        <span className="text-xs text-muted-foreground">
                          <LocalTime value={payment.occurredAt} format="date" />
                        </span>
                        {differenceCents !== null && Math.abs(differenceCents) > 100 ? (
                          <span className="text-xs text-warning">
                            {differenceCents > 0 ? "+" : "−"}
                            <Money cents={Math.abs(differenceCents)} />
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function BankMovementsCard({ data, canFinance }: { data: MortgageData; canFinance: boolean }) {
  const { mortgage: m, payments, origination } = data;
  const company = m.funding === "company";
  const brokerFeeKept = origination && origination.outCents !== null ? origination.inCents - origination.taxCents - origination.outCents : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bank movements</CardTitle>
        <CardDescription>
          {company
            ? "What actually passed through the business wallet. Litt's paid the State the down payment and the loan from its own money; repayments come back to Litt's."
            : "What actually passed through the business wallet. Federal interest is withheld as tax."}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">When</TableHead>
              <TableHead>What</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="hidden text-right sm:table-cell">To the State</TableHead>
              <TableHead className="pr-6 text-right">Litt&rsquo;s keeps</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {origination ? (
              <TableRow>
                <TableCell className="pl-6 text-sm">
                  <LocalTime value={origination.at} />
                </TableCell>
                <TableCell>
                  Down payment &amp; fees
                  <div className="text-xs text-muted-foreground">
                    tax <Money cents={origination.taxCents} />
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={origination.inCents} />
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">{money(origination.outCents)}</TableCell>
                <TableCell className="pr-6 text-right">
                  {brokerFeeKept === null ? (
                    <span className="text-xs text-muted-foreground">waiting for the transfer</span>
                  ) : company && m.loanCents !== null ? (
                    <>
                      <Money cents={brokerFeeKept + m.loanCents} />
                      <div className="text-xs text-muted-foreground">
                        fee; lent <Money cents={m.loanCents} />
                      </div>
                    </>
                  ) : (
                    <Money cents={brokerFeeKept} />
                  )}
                </TableCell>
              </TableRow>
            ) : null}
            {payments.map((p, i) => (
              <TableRow key={p.txId}>
                <TableCell className="pl-6 text-sm">
                  {canFinance ? (
                    <Link href={`/finance/transactions/${p.txId}`} className="underline-offset-4 hover:underline">
                      <LocalTime value={p.occurredAt} />
                    </Link>
                  ) : (
                    <LocalTime value={p.occurredAt} />
                  )}
                </TableCell>
                <TableCell>
                  Payment {i + 1}
                  <div className="text-xs text-muted-foreground">
                    federal interest <Money cents={p.taxCents} />
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={p.grossCents} />
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">{money(p.toStateCents)}</TableCell>
                <TableCell className="pr-6 text-right">
                  {company ? (
                    <Money cents={p.grossCents - p.taxCents} />
                  ) : p.toStateCents !== null ? (
                    <Money cents={p.grossCents - p.taxCents - p.toStateCents} />
                  ) : (
                    <span className="text-xs text-muted-foreground">waiting for the transfer</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!origination && payments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="px-6 text-sm text-muted-foreground">
                  No bank movements yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function TabletPastesCard({ data }: { data: MortgageData }) {
  if (!data.snapshots.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tablet pastes</CardTitle>
        <CardDescription>Exactly as pasted, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.snapshots.map((s) => (
          <details key={s.id} className="rounded-lg border px-3 py-2 text-sm">
            <summary className="cursor-pointer">
              <LocalTime value={s.capturedAt} />
            </summary>
            <pre className="mt-2 overflow-x-auto text-xs whitespace-pre-wrap text-muted-foreground">{s.raw}</pre>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}

export function MortgageHistoryCard({ data }: { data: MortgageData }) {
  const m = data.mortgage;
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>
          {data.otherMortgages.length ? (
            <>
              The buyer has {data.otherMortgages.length} other mortgage{data.otherMortgages.length === 1 ? "" : "s"}.{" "}
              {m.buyerStateId ? (
                <Link href={`/loans/borrowers/${m.buyerStateId}`} className="text-primary underline underline-offset-4">
                  Borrower history
                </Link>
              ) : null}
            </>
          ) : (
            "The buyer's only mortgage with Litt's."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MortgageNoteForm mortgageId={m.id} />
        <ol className="space-y-3 border-l pl-4">
          {data.events.map((e) => (
            <li key={e.id} className="relative text-sm">
              <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-border" aria-hidden />
              <div className="font-medium">{EVENT_LABEL[e.kind] ?? e.kind}</div>
              {e.kind === "note" ? (
                <div className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{String(e.detail.text)}</div>
              ) : Array.isArray(e.detail.changes) && e.detail.changes.length ? (
                <div className="text-muted-foreground">Changed: {(e.detail.changes as string[]).join(", ")}</div>
              ) : e.kind === "executive_approved" && typeof e.detail.reason === "string" ? (
                <div className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{e.detail.reason}</div>
              ) : e.kind === "address_changed" && typeof e.detail.from === "string" && typeof e.detail.to === "string" ? (
                <div className="text-muted-foreground [overflow-wrap:anywhere]">
                  From {e.detail.from} to {e.detail.to}: the buyer&rsquo;s repayment came in under the new address
                </div>
              ) : e.kind === "merged" && typeof e.detail.fromAddress === "string" ? (
                <div className="text-muted-foreground [overflow-wrap:anywhere]">
                  From the record &ldquo;{e.detail.fromAddress}&rdquo;{typeof e.detail.reason === "string" ? `: ${e.detail.reason}` : ""}
                </div>
              ) : null}
              <div className="text-xs text-muted-foreground">
                <LocalTime value={e.at} />
                {e.staffName ? ` · ${e.staffName}` : ""}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
