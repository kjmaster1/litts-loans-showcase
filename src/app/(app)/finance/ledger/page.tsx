import { CircleAlert, CircleCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Money } from "@/components/data/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reportingPeriods } from "@/lib/company-time";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { profitAndLoss, trialBalance, type AccountType } from "@/server/ledger/queries";
import { FinanceTabs } from "@/components/app-shell/section-tabs";

export const metadata: Metadata = { title: "Ledger" };

const SECTIONS: { type: AccountType; label: string }[] = [
  { type: "asset", label: "Assets" },
  { type: "liability", label: "Liabilities" },
  { type: "equity", label: "Equity" },
  { type: "income", label: "Income" },
  { type: "expense", label: "Expenses" },
  { type: "memo", label: "Memo (off-balance)" },
];

/** Accounts whose balance means "something needs attention". */
const NOTES: Record<string, string> = {
  "1900": "Rows awaiting classification. See Transactions → Needs review.",
  "1190": "Legacy manual loans (all complete). A credit balance is net interest earned before the loan system existed.",
  "1110": "Should be zero once every mortgage leg has its partner.",
  "9000": "Tax withheld but not yet covered by a monthly Tax Payment record (records arrive the following month).",
};

export default async function LedgerPage({ searchParams }: PageProps<"/finance/ledger">) {
  await requireCapabilityPage("finance.view");
  const sp = await searchParams;
  const periods = reportingPeriods();
  const period = periods.find((p) => p.key === sp.period) ?? periods[0];
  const [tb, pl] = await Promise.all([trialBalance(), profitAndLoss(period.from, period.to)]);

  const totalDebit = tb.reduce((s, r) => s + r.debitCents, 0);
  const totalCredit = tb.reduce((s, r) => s + r.creditCents, 0);
  const balanced = totalDebit === totalCredit;

  return (
    <>
      <PageHeader
        tabs={<FinanceTabs />}
        title="Ledger"
        description="Double-entry books built from the bank imports. Periods follow UK time (Europe/London)."
      />
      <PageBody className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Profit &amp; loss</CardTitle>
            <CardDescription>{period.label}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <nav aria-label="Period" className="flex flex-wrap gap-2">
              {periods.map((p) => (
                <Button key={p.key} size="sm" variant={p.key === period.key ? "secondary" : "ghost"} render={<Link href={`/finance/ledger?period=${p.key}`} />}>
                  {p.key === "this-month" ? "This month" : p.key === "last-month" ? "Last month" : p.key === "ytd" ? "Year to date" : "All time"}
                </Button>
              ))}
            </nav>
            <div className="grid gap-6 md:grid-cols-2">
              {(["income", "expense"] as const).map((type) => {
                const lines = pl.lines.filter((l) => l.type === type && l.amountCents !== 0);
                return (
                  <div key={type}>
                    <h3 className="mb-2 text-sm font-medium text-muted-foreground">{type === "income" ? "Income" : "Expenses"}</h3>
                    <dl className="divide-y rounded-lg border">
                      {lines.length === 0 ? <div className="p-3 text-sm text-muted-foreground">Nothing in this period.</div> : null}
                      {lines.map((l) => (
                        <div key={l.code} className="flex justify-between gap-4 p-3 text-sm">
                          <dt>
                            <Link href={`/finance/ledger/${l.code}`} className="underline-offset-4 hover:underline">
                              {l.name}
                            </Link>
                          </dt>
                          <dd>
                            <Money cents={l.amountCents} accounting />
                          </dd>
                        </div>
                      ))}
                      <div className="flex justify-between gap-4 bg-muted/40 p-3 text-sm font-medium">
                        <dt>Total</dt>
                        <dd>
                          <Money cents={type === "income" ? pl.incomeCents : pl.expenseCents} accounting />
                        </dd>
                      </div>
                    </dl>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between rounded-lg border-2 border-primary/30 bg-primary/5 p-4">
              <span className="font-medium">Net profit</span>
              <Money cents={pl.netCents} accounting className="text-xl font-semibold" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Trial balance</CardTitle>
            <CardDescription>All time. Balances shown in each account&rsquo;s normal direction.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-0">
            <div
              role="status"
              className={cn(
                "mx-6 flex items-center gap-2 rounded-lg p-3 text-sm",
                balanced ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger",
              )}
            >
              {balanced ? <CircleCheck className="size-4" aria-hidden /> : <CircleAlert className="size-4" aria-hidden />}
              {balanced ? "In balance: total debits equal total credits." : "Out of balance: total debits don’t equal total credits. Investigate now."}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Account</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Debits</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Credits</TableHead>
                  <TableHead className="pr-6 text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SECTIONS.map((section) => {
                  const rows = tb.filter((r) => r.type === section.type);
                  return (
                    <Fragment key={section.type}>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={4} className="pl-6 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                          {section.label}
                        </TableCell>
                      </TableRow>
                      {rows.map((r) => (
                        <TableRow key={r.code} className={cn(r.debitCents === 0 && r.creditCents === 0 && "text-muted-foreground")}>
                          <TableCell className="pl-6 whitespace-normal">
                            <Link href={`/finance/ledger/${r.code}`} className="underline-offset-4 hover:underline">
                              <span className="ident text-muted-foreground">{r.code}</span> {r.name}
                            </Link>
                            {NOTES[r.code] && r.balanceCents !== 0 ? <div className="text-xs text-muted-foreground">{NOTES[r.code]}</div> : null}
                          </TableCell>
                          <TableCell className="hidden text-right md:table-cell">
                            <Money cents={r.debitCents} />
                          </TableCell>
                          <TableCell className="hidden text-right md:table-cell">
                            <Money cents={r.creditCents} />
                          </TableCell>
                          <TableCell className="pr-6 text-right font-medium">
                            <Money cents={r.balanceCents} accounting />
                          </TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="pl-6 font-medium">Totals</TableCell>
                  <TableCell className="hidden text-right font-medium md:table-cell">
                    <Money cents={totalDebit} />
                  </TableCell>
                  <TableCell className="hidden text-right font-medium md:table-cell">
                    <Money cents={totalCredit} />
                  </TableCell>
                  <TableCell className="pr-6" />
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
