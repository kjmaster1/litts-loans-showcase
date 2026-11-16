import { CalendarClock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { CopyValue } from "@/components/data/copy-value";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { bookmarklet, phoneList } from "@/lib/pay-helper";
import { can } from "@/lib/permissions";
import { requireViewer } from "@/server/authz/viewer";
import { balances, myCommission, paySheet, payouts, schemeStarted, staffOptions, weeksOverview } from "@/server/commissions/queries";
import { AssignPayout } from "./commission-forms";
import { PhoneHelper } from "@/components/data/phone-helper";

export const metadata: Metadata = { title: "Commissions" };

const KIND_LABEL: Record<string, string> = {
  loan_interest: "Loan interest (50%)",
  mortgage_originator: "Banker fee for arranging (20%)",
  mortgage_pool: "Mortgage pool share",
};

function NotStarted() {
  return (
    <Alert variant="info">
      <CalendarClock aria-hidden />
      <AlertTitle>The new commission scheme starts on Monday 12 October</AlertTitle>
      <AlertDescription>
        <p>
          From then: 50% of loan interest received (after tax) to the loan&rsquo;s officer, and each mortgage banker fee split 20% to the officer who
          arranged it, 30% to the weekly staff pool (equal shares) and 50% to the company. Loan interest received since 25 August that
          no earlier commission payment covered is in a one-off catch-up period, paid the same way.
        </p>
      </AlertDescription>
    </Alert>
  );
}

export default async function CommissionsPage() {
  const viewer = await requireViewer();
  const manager = can(viewer.role, "commissions.view_all");
  const started = schemeStarted();

  if (!manager) {
    const mine = await myCommission(viewer.staffId);
    return (
      <>
        <PageHeader title="Commissions" description="What you've earned, been paid and are owed." />
        <PageBody className="max-w-4xl space-y-6">
          {!started ? <NotStarted /> : null}
          <StatStrip cols={3}>
            <Kpi label="This week so far" hint={mine.current ? mine.current.label : "No week open"}>
              <Money cents={mine.current?.estimateCents ?? 0} />
            </Kpi>
            <Kpi label="Owed to you" hint="Closed weeks, less what's been paid">
              <Money cents={mine.balance?.owedCents ?? 0} />
            </Kpi>
            <Kpi label="Paid to you" hint="Since the scheme started">
              <Money cents={mine.balance?.paidCents ?? 0} />
            </Kpi>
          </StatStrip>
          {mine.current?.lines.length ? (
            <Card>
              <CardHeader>
                <CardTitle>This week</CardTitle>
                <CardDescription>An estimate until management closes the week; the pool share depends on who&rsquo;s confirmed.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableBody>
                    {mine.current.lines.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell className="pl-6">
                          {l.label}
                          <div className="text-xs text-muted-foreground">{KIND_LABEL[l.kind]}</div>
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
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              {mine.history.length === 0 && mine.payouts.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {mine.history.map((h) => (
                    <li key={h.key} className="flex justify-between py-2">
                      <span>Earned · {h.label}</span>
                      <Money cents={h.amountCents} />
                    </li>
                  ))}
                  {mine.payouts.map((p) => (
                    <li key={p.txId} className="flex justify-between py-2">
                      <span>
                        Paid · <LocalTime value={p.at} format="date" />
                      </span>
                      <Money cents={p.amountCents} direction="in" />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </PageBody>
      </>
    );
  }

  const [weeks, owed, recent, staff, sheet] = await Promise.all([weeksOverview(), balances(), payouts(30), staffOptions(), paySheet()]);
  const unmatched = recent.filter((p) => p.status === "unmatched");
  const current = weeks.find((w) => w.current);
  const toClose = weeks.filter((w) => w.ended && w.status === "open");
  const totalOwed = owed.reduce((s, b) => s + b.owedCents, 0);

  return (
    <>
      <PageHeader title="Commissions" description="Weekly commission: earned from interest and banker fees, booked when the week is closed, settled when paid." />
      <PageBody className="space-y-6">
        {!started ? <NotStarted /> : null}
        <StatStrip cols={4}>
          <Kpi label="Owed to staff" hint="Closed weeks, less payouts">
            <Money cents={totalOwed} />
          </Kpi>
          <Kpi label="This week so far" hint={current ? current.label : "Starts Monday 12 Oct"}>
            <Money cents={current?.totalCents ?? 0} />
          </Kpi>
          <Kpi
            label="Weeks to close"
            tone={toClose.length ? "warn" : undefined}
            hint={toClose.length ? `Next: ${toClose[0].label}` : "Ended, waiting for the roster and close"}
            href={toClose.length ? `/commissions/${toClose[0].key}` : undefined}
          >
            <span className="num">{toClose.length}</span>
          </Kpi>
          <Kpi
            label="Payouts to assign"
            tone={unmatched.length ? "warn" : undefined}
            hint="Commission payments not yet matched to a person"
            href={unmatched.length ? "#payouts" : undefined}
          >
            <span className="num">{unmatched.length}</span>
          </Kpi>
        </StatStrip>

        <Card>
          <CardHeader>
            <CardTitle>Pay sheet</CardTitle>
            <CardDescription>
              One payment per person: on the phone, the Litt&rsquo;s Loans card&rsquo;s ⋯ menu → Pay Employee, to their State ID, with the amount and
              comment shown (a Transfer can&rsquo;t pay a personal wallet from the business one). The next bank import matches it to them by wallet and
              settles what&rsquo;s owed.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {sheet.rows.length === 0 ? (
              <p className="px-6 text-sm text-muted-foreground">Nobody is owed anything. Amounts appear here once a week (or the catch-up) is closed.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Person</TableHead>
                    <TableHead>State ID</TableHead>
                    <TableHead className="text-right">Pay</TableHead>
                    <TableHead>Wallet</TableHead>
                    <TableHead className="pr-6">Comment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sheet.rows.map((r) => (
                    <TableRow key={r.staffId}>
                      <TableCell className="pl-6 align-top">
                        {r.name}
                        {r.status !== "active" ? <span className="ml-1 text-xs text-muted-foreground">({r.status === "invited" ? "invite pending" : r.status})</span> : null}
                        <div className="text-xs text-muted-foreground">{r.periods.map((x) => x.label).join(" · ")}</div>
                      </TableCell>
                      <TableCell className="align-top">
                        <CopyValue value={String(r.stateId)} display={<span className="ident">{r.stateId}</span>} label={`State ID for ${r.name}`} />
                      </TableCell>
                      <TableCell className="text-right align-top font-medium">
                        <CopyValue value={String(Math.round(r.owedCents / 100))} display={<Money cents={r.owedCents} />} label={`amount for ${r.name}`} />
                      </TableCell>
                      <TableCell className="align-top">
                        {r.wallet ? (
                          <span className="ident text-sm text-muted-foreground">{r.wallet}</span>
                        ) : (
                          <span className="text-sm text-warning">Not known yet</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-xs pr-6 align-top">
                        <CopyValue value={r.comment} display={<span className="text-sm">{r.comment}</span>} label={`comment for ${r.name}`} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {sheet.rows.some((r) => !r.wallet) ? (
              <p className="px-6 pt-3 text-xs text-muted-foreground">
                Wallet &ldquo;Not known yet&rdquo;: pay them as usual, then assign that payout to them below. Their wallet is remembered from then on.
              </p>
            ) : null}
            {sheet.paidAhead.length ? (
              <p className="px-6 pt-3 text-xs text-muted-foreground">
                Paid ahead (more than earned so far, comes off their next pay):{" "}
                {sheet.paidAhead.map((p, i) => (
                  <span key={p.name}>
                    {i ? ", " : ""}
                    {p.name} <Money cents={p.cents} />
                  </span>
                ))}
              </p>
            ) : null}
            <PhoneHelper list={sheet.rows.length ? phoneList(sheet.rows) : null} bookmarklet={bookmarklet()} />
          </CardContent>
        </Card>

        <div className={owed.length ? "grid gap-6 xl:grid-cols-2" : undefined}>
          <Card>
            <CardHeader>
              <CardTitle>Weeks</CardTitle>
              <CardDescription>Monday to Sunday, UK time, plus the one-off catch-up for loan interest before the scheme.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {weeks.length === 0 ? (
                <p className="px-6 text-sm text-muted-foreground">The first week starts on Monday 12 October.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Week</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="pr-6 text-right">Commission</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {weeks.map((w) => (
                      <TableRow key={w.key}>
                        <TableCell className="pl-6">
                          <Link href={`/commissions/${w.key}`} className="font-medium underline-offset-4 hover:underline">
                            {w.label}
                          </Link>
                          {w.catchUp ? <div className="text-xs text-muted-foreground">Loan interest no earlier payment covered</div> : null}
                        </TableCell>
                        <TableCell>
                          {w.status === "closed" ? (
                            <StatusBadge tone="success">Closed</StatusBadge>
                          ) : w.ended ? (
                            <StatusBadge tone="warning">{w.problems ? `${w.problems} to fix` : w.rosterLocked ? "Ready to close" : "Confirm roster"}</StatusBadge>
                          ) : w.catchUp ? (
                            <StatusBadge tone="info">{w.problems ? `${w.problems} to fix` : "Until 12 Oct"}</StatusBadge>
                          ) : (
                            <StatusBadge tone="info">In progress</StatusBadge>
                          )}
                        </TableCell>
                        <TableCell className="pr-6 text-right">
                          <Money cents={w.totalCents} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {owed.length ? (
            <Card>
              <CardHeader>
                <CardTitle>Owed to staff</CardTitle>
                <CardDescription>Earned in closed weeks, less payouts matched to them.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Person</TableHead>
                      <TableHead className="text-right">Earned</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="pr-6 text-right">Owed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {owed.map((b) => (
                      <TableRow key={b.staffId}>
                        <TableCell className="pl-6">{b.name}</TableCell>
                        <TableCell className="text-right">
                          <Money cents={b.awardedCents} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={b.paidCents} />
                        </TableCell>
                        <TableCell className="pr-6 text-right font-medium">
                          <Money cents={b.owedCents} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card id="payouts" className="scroll-mt-16">
          <CardHeader>
            <CardTitle>Payouts</CardTitle>
            <CardDescription>
              &ldquo;Employee Pay: Commission Pay&rdquo; rows from the bank since 12 October. Assign each to the person paid; their wallet is remembered so
              later payouts match by themselves.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {recent.length === 0 ? (
              <p className="px-6 text-sm text-muted-foreground">No commission payouts since the scheme started.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">When</TableHead>
                    <TableHead>Comment</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="pr-6">Paid to</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((p) => (
                    <TableRow key={p.txId}>
                      <TableCell className="pl-6 align-top text-sm">
                        <LocalTime value={p.at} />
                      </TableCell>
                      <TableCell className="max-w-md align-top text-sm whitespace-normal">
                        {p.comment}
                        <div className="ident text-xs text-muted-foreground">wallet {p.targetWallet ?? "—"}</div>
                      </TableCell>
                      <TableCell className="text-right align-top">
                        <Money cents={p.amountCents} />
                      </TableCell>
                      <TableCell className="pr-6 align-top">
                        {p.status === "unmatched" ? (
                          <AssignPayout txId={p.txId} staff={staff} />
                        ) : p.status === "old_scheme" ? (
                          <span className="text-sm text-muted-foreground">Old scheme</span>
                        ) : (
                          <span className="text-sm">
                            {p.staffName}
                            {p.matchedBy === "wallet" ? <span className="text-xs text-muted-foreground"> · by wallet</span> : null}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
