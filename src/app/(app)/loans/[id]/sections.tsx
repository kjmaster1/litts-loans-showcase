import Link from "next/link";
import { LOAN_EVENT_LABEL } from "@/lib/loan-event-labels";
import { Fact } from "@/components/data/fact";
import { GameQuirkBadge } from "@/components/data/game-quirk-badge";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LinkRole } from "@/domain/loans/link";
import { dateFormat, formatBp, formatCents } from "@/lib/format";
import { cn } from "@/lib/utils";
import { COLLECTION_LABEL, type CollectionKind } from "@/server/loans/collections";
import type { getLoan } from "@/server/loans/queries";
import { NoteForm } from "./loan-panels";

/** The loan page's sections (owner review 2026-10-11: the page was 550 lines). Server components. */

export type LoanData = NonNullable<Awaited<ReturnType<typeof getLoan>>>;

export const ROLE_LABEL: Record<LinkRole, string> = {
  disbursement: "Loan paid out",
  fee: "Broker fee",
  principal: "Instalment (principal)",
  interest: "Instalment (interest)",
  early_principal: "Early repayment (principal)",
  early_interest: "Early repayment (interest)",
  late_principal: "Late payment (principal)",
  late_fee: "Late payment (fee)",
  recovery: "Recovery after default",
  refund: "Refund to the borrower (game error)",
};

const METHOD_LABEL: Record<string, string> = {
  agreement: "Identified by the loan amount in the comment",
  instalments: "Identified by its number of payments (k/N)",
  paired: "Paid in the same second as an identified payment",
  reference: "Identified by the agreement ID in the comment",
  timing: "Matched by time (paid with the loan)",
  open_loan: "Inferred: the borrower's loan open at the time",
  borrower_named: "A recovery naming the borrower, after this loan defaulted",
  borrower_wallet: "Paid to the borrower's wallet; their latest loan at the time",
  disbursement: "The loan itself",
};

const EVENT_LABEL = LOAN_EVENT_LABEL;

const pct = (bp: number | null) => (bp === null ? "—" : formatBp(bp));
const day = dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });

function eventText(kind: string, d: Record<string, unknown>, staffName: (id: unknown) => string): React.ReactNode {
  switch (kind) {
    case "status_changed":
      return `${String(d.from).replace("_", " ")} → ${String(d.to).replace("_", " ")} (seen in the ${String(d.tab)} tab)`;
    case "terms_set":
      return [
        d.instalments ? `${d.instalments} payment${d.instalments === 1 ? "" : "s"}${d.periodDays ? ` every ${d.periodDays} days` : ""}` : null,
        d.brokerRatePct !== null && d.brokerRatePct !== undefined ? `broker ${d.brokerRatePct}%` : null,
        d.stateRatePct !== null && d.stateRatePct !== undefined ? `State ${d.stateRatePct}%` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "officer_assigned":
    case "officer_changed":
      return `${d.from ? `${staffName(d.from)} → ` : ""}${d.to ? staffName(d.to) : "Unassigned"}${d.reason ? `: “${String(d.reason)}”` : ""}`;
    case "written_off":
      return `${formatCents(Number(d.amountCents))} charged off: “${String(d.reason)}”`;
    case "default_date_corrected":
      // Was "09/10/2026" — now the app's own date style.
      return `${day.format(new Date(String(d.from)))} → ${day.format(new Date(String(d.to)))} (worked out from missed payments)`;
    case "marked_repaid":
      return `Was ${String(d.from)} in the game: “${String(d.reason)}”`;
    case "collection_logged":
      return COLLECTION_LABEL[d.kind as CollectionKind] ?? String(d.kind);
    case "collateral_added":
      return String(d.description);
    case "collateral_status":
      return `${String(d.description)}: ${String(d.from)} → ${String(d.to)}${d.note ? ` · “${String(d.note)}”` : ""}`;
    case "note":
      return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{String(d.text)}</span>;
    case "disbursed":
      return d.principalCents ? formatCents(Number(d.principalCents)) : null;
    case "legal_terms_set":
      return [d.feePerDayCents ? `${formatCents(Number(d.feePerDayCents))} per day in default` : "No fee per day", d.unsecured ? "unsecured" : null].filter(Boolean).join(" · ");
    case "handed_to_legal":
      return `Case LC${String(d.caseNumber)}${d.totalCents ? `: ${formatCents(Number(d.totalCents))}` : ""}`;
    default:
      return null;
  }
}

/** Principal received: the analysis when there is one, else the principal rows from the bank. */
export function principalReceived(data: LoanData): number {
  return data.analysis?.principalReceivedCents ?? data.payments.filter((p) => p.role.includes("principal")).reduce((s, p) => s + p.amountCents, 0);
}

export function LoanDetailsCard({ data }: { data: LoanData }) {
  const { loan: l, payments } = data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>
          Amounts come from the bank; terms and progress from the latest phone card
          {l.lastCardAt ? (
            <>
              {" "}
              (<LocalTime value={l.lastCardAt} format="relative" />)
            </>
          ) : null}
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-x-8 md:grid-cols-2">
        <dl className="divide-y">
          <Fact label="Principal">
            <Money cents={l.principalCents} />
          </Fact>
          <Fact label="Still owed (books)">
            {data.outstandingCents === null ? <span className="text-muted-foreground">—</span> : <Money cents={data.outstandingCents} />}
          </Fact>
          <Fact label="Principal received">
            <Money cents={principalReceived(data)} />
          </Fact>
          <Fact label="Interest & fees received">
            <Money cents={payments.filter((p) => ["interest", "early_interest", "late_fee", "fee"].includes(p.role)).reduce((s, p) => s + p.amountCents, 0)} />
          </Fact>
          <Fact label="State's share">
            <Money cents={payments.reduce((s, p) => s + p.levyCents, 0)} />
          </Fact>
        </dl>
        <dl className="divide-y">
          <Fact label="Terms">
            {l.instalments ? (
              <>
                {l.instalments} payment{l.instalments === 1 ? "" : "s"}
                {l.periodDays ? ` every ${l.periodDays} day${l.periodDays === 1 ? "" : "s"}` : ""}
              </>
            ) : (
              <span className="text-muted-foreground">Unknown until a phone card is pasted</span>
            )}
          </Fact>
          <Fact label="Rates">
            Broker {pct(l.brokerRateBp)} · State {pct(l.stateRateBp)}
          </Fact>
          <Fact label="Progress">
            {l.instalments ? (
              <>
                <span className="num">
                  {l.lastCompleted ?? 0}/{l.instalments}
                </span>
                {l.lastMissed ? <span className="text-warning"> · {l.lastMissed} missed</span> : null}
              </>
            ) : (
              "—"
            )}
          </Fact>
          <Fact label="Opened">
            <LocalTime value={l.openedAt} />
          </Fact>
          {l.status === "completed" ? (
            <Fact label="Completed">
              <LocalTime value={l.completedAt} />
              {l.statusLocked ? <div className="text-xs text-muted-foreground">Marked repaid by staff: {l.statusLockReason}</div> : null}
            </Fact>
          ) : (
            <Fact label="Next payment">
              <LocalTime value={l.nextPaymentDueAt} />
            </Fact>
          )}
          {l.firstDefaultAt ? (
            <Fact label="Defaulted">
              <LocalTime value={l.firstDefaultAt} format="date" />
            </Fact>
          ) : null}
          {l.agreementRef ? (
            <Fact label="Agreement ID">
              <span className="ident text-xs">{l.agreementRef}</span>
            </Fact>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}

const DAY_MS = 86_400_000;

/**
 * `now`: the request time, from the page (server components render once per request);
 * `bankTo`: the newest bank row on record — nothing after it can be called unpaid.
 */
export function ScheduleCard({ data, now, bankTo }: { data: LoanData; now: Date; bankTo: Date | null }) {
  const { loan: l, analysis } = data;
  if (!analysis) return null;
  // Paid: instalments paid on time or late (a late repayment pays a missed one), or the phone's own
  // count when its card is newer than the bank export (QA 2026-10-13).
  const paid = Math.max(analysis.instalmentsPaid, l.lastCompleted ?? 0);
  // On a loan still being repaid, an instalment past its due date with no payment is shown as such,
  // not with the same dash as one that isn't due yet (UX review 2026-10-12). Only where the data is
  // sure: due dates are the game's (a period after the previous payment, not the contract's), the bank
  // must reach a day past the due date (the game charges a few minutes after it), and an early
  // repayment (which pays ahead unevenly) turns the marker off.
  const open = l.status === "active" || l.status === "overdue" || l.status === "defaulted";
  const paidEarly = data.payments.some((p) => p.role === "early_principal");
  const asOf = Math.min(now.getTime(), bankTo?.getTime() ?? 0);
  const due = (r: { number: number; dueAt: Date }) => analysis.gameDueAt[r.number - 1] ?? r.dueAt;
  const unpaid = (r: { number: number; dueAt: Date }) => open && !paidEarly && r.number > paid && due(r).getTime() + DAY_MS < asOf;
  const next = open ? analysis.schedule.find((r) => r.number > paid && due(r).getTime() >= now.getTime())?.number : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contract schedule</CardTitle>
        <CardDescription>
          What the loan agreement says, from the disbursement date. The borrower pays principal plus {pct(l.brokerRateBp)} on each instalment.
          {l.periodDays === null ? " Due dates assume weekly payments (the phone card doesn't say)." : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">#</TableHead>
              <TableHead>Due</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Principal</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Interest</TableHead>
              <TableHead className="text-right">Borrower pays</TableHead>
              <TableHead className="pr-6">Paid</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {analysis.schedule.map((r) => (
              <TableRow key={r.number}>
                <TableCell className="num pl-6">{r.number}</TableCell>
                <TableCell>
                  <LocalTime value={r.dueAt} format="date" />
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  <Money cents={r.principalCents} />
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  {r.interestCharged ? (
                    <Money cents={r.interestCents} />
                  ) : (
                    <span className="inline-flex flex-col items-end gap-0.5">
                      <s className="text-muted-foreground" aria-hidden>
                        <Money cents={r.interestCents} />
                      </s>
                      <span className="sr-only">Never charged by the game.</span>
                      <GameQuirkBadge />
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={r.borrowerPaysCents} />
                </TableCell>
                <TableCell className="pr-6">
                  {r.number <= paid ? (
                    <StatusBadge tone="success">Paid</StatusBadge>
                  ) : unpaid(r) ? (
                    <StatusBadge tone={l.status === "defaulted" ? "danger" : "warning"}>Not paid</StatusBadge>
                  ) : r.number === next ? (
                    <span className="text-xs font-medium">
                      Next
                      {Math.abs(due(r).getTime() - r.dueAt.getTime()) >= DAY_MS ? (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · due <LocalTime value={due(r)} format="date" />
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
        <p className="px-6 pt-3 text-xs text-muted-foreground">
          &ldquo;Paid&rdquo; counts instalments paid on time or late, as the phone does; early repayments are listed under payments. The game sets each due
          date one period after the previous payment, so dates move on after a late payment: &ldquo;Not paid&rdquo; and &ldquo;Next&rdquo; follow the
          game&rsquo;s dates, and &ldquo;Not paid&rdquo; means due over a day before the latest bank export with no payment. The game never charges
          interest on the final instalment, so the agreement&rsquo;s total is one instalment&rsquo;s interest more than borrowers actually pay.
        </p>
      </CardContent>
    </Card>
  );
}

export function PaymentsCard({ data, canFinance }: { data: LoanData; canFinance: boolean }) {
  const { payments } = data;
  // Several rows when a later receipt or a rounding correction re-closed the loan; show the net.
  const closing = data.adjustments.reduce((sum, a) => sum + a.amountCents, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
        <CardDescription>Bank rows linked to this loan, oldest first. The State&rsquo;s share is booked as an expense, not taken from cash.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {payments.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">No bank rows are linked to this loan yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">When</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="hidden pr-6 text-right sm:table-cell">State&rsquo;s share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.txId}>
                  <TableCell className="pl-6 align-top text-sm">
                    <LocalTime value={p.occurredAt} />
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    {canFinance ? (
                      <Link href={`/finance/transactions/${p.txId}`} className="underline-offset-4 hover:underline">
                        {ROLE_LABEL[p.role] ?? p.role}
                      </Link>
                    ) : (
                      (ROLE_LABEL[p.role] ?? p.role)
                    )}
                    <div className={cn("text-xs", p.method === "open_loan" ? "text-warning" : "text-muted-foreground")}>
                      {METHOD_LABEL[p.method] ?? p.method}
                      {p.recovery ? " · recovery after write-off" : ""}
                    </div>
                    {p.penaltyCents ? (
                      <div className="text-xs text-muted-foreground">
                        Includes <Money cents={p.penaltyCents} /> overdue penalty (late fee)
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Money cents={p.amountCents} direction={p.role === "disbursement" || p.role === "refund" ? "out" : "in"} />
                  </TableCell>
                  <TableCell className="hidden pr-6 text-right align-top sm:table-cell">
                    {p.levyCents ? <Money cents={p.levyCents} /> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {closing !== 0 ? (
          <div className="mx-6 mt-4 rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              Closing adjustment <GameQuirkBadge />
            </p>
            <p className="text-muted-foreground">
              When the game marked the loan complete, <Money cents={Math.abs(closing)} />{" "}
              {closing > 0 ? "was still on the books (shortfall)" : "more had been collected than lent (surplus)"}. It was cleared so the
              loan closes at zero. Usually the game&rsquo;s whole-dollar rounding or its early-repayment bugs; a large one can mean a payment
              sits on another of the borrower&rsquo;s loans.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PhoneCardsCard({ data }: { data: LoanData }) {
  if (!data.cards.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Phone cards</CardTitle>
        <CardDescription>Exactly as pasted, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.cards.map((c) => (
          <details key={c.pasteId} className="rounded-lg border px-3 py-2 text-sm">
            <summary className="cursor-pointer">
              <span className="capitalize">{c.tab}</span> tab · <LocalTime value={c.capturedAt} />
            </summary>
            <pre className="mt-2 overflow-x-auto text-xs whitespace-pre-wrap text-muted-foreground">{c.raw}</pre>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}

export function HistoryCard({ data, staffName }: { data: LoanData; staffName: (id: unknown) => string }) {
  const l = data.loan;
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>
          {data.otherLoans > 0 ? (
            <>
              This borrower has {data.otherLoans} other loan{data.otherLoans === 1 ? "" : "s"}.{" "}
              <Link href={`/loans/borrowers/${l.borrowerStateId}`} className="text-primary underline underline-offset-4">
                Borrower history
              </Link>
            </>
          ) : (
            "This borrower's only loan."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <NoteForm loanId={l.id} />
        <ol className="space-y-3 border-l pl-4">
          {data.events.map((e) => (
            <li key={e.id} className="relative text-sm">
              <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-border" aria-hidden />
              <div className="font-medium">{EVENT_LABEL[e.kind] ?? e.kind}</div>
              <div className="text-muted-foreground">{eventText(e.kind, e.detail, staffName)}</div>
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
