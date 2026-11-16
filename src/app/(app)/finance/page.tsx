import { formatCount } from "@/lib/format";
import { ArrowRight, CircleAlert, CircleCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LocalTime } from "@/components/data/local-time";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { Money } from "@/components/data/money";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reportingPeriods } from "@/lib/company-time";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { cashBalanceCents } from "@/server/bank/import";
import { legacyClearing } from "@/server/ledger/legacy";
import { listImportBatches, profitAndLoss, reviewCount, taxByMonth, trialBalance } from "@/server/ledger/queries";
import { cashFlowForecast } from "@/server/forecast";
import { ForecastCard } from "./forecast-card";
import { staffLoans } from "@/server/ledger/staff-loans";
import { LegacyLoansCard } from "./legacy-loans-card";
import { StaffLoansCard } from "./staff-loans-card";
import { FinanceTabs } from "@/components/app-shell/section-tabs";

/** "2026-10" → "Oct 2026". */
const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo - 1] ?? m} ${y}`;
};

export const metadata: Metadata = { title: "Finance" };


export default async function FinancePage() {
  const viewer = await requireCapabilityPage("finance.view");
  const [thisMonth] = reportingPeriods();
  const [cash, toReview, batches, pl, tb, tax, legacy, forecast, lenders] = await Promise.all([
    cashBalanceCents(),
    reviewCount(),
    listImportBatches(5),
    profitAndLoss(thisMonth.from, thisMonth.to),
    trialBalance(),
    taxByMonth(),
    legacyClearing(),
    cashFlowForecast(),
    staffLoans(),
  ]);
  const latest = batches[0];
  const reconciled = latest ? latest.reportedBalanceCents === cash : null;
  const receivable = tb.find((a) => a.code === "1100")?.balanceCents ?? 0;
  const canImport = can(viewer.role, "bank.import");

  if (!latest) {
    return (
      <>
        <PageHeader tabs={<FinanceTabs />} title="Finance" description="The company's books, built from the in-game bank exports." />
        <PageBody>
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>No bank data yet</EmptyTitle>
              <EmptyDescription>Import a full-history export from the in-game bank to build the books.</EmptyDescription>
            </EmptyHeader>
            {canImport ? (
              <EmptyContent>
                <Button render={<Link href="/finance/imports" />}>Import bank export</Button>
              </EmptyContent>
            ) : null}
          </Empty>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        tabs={<FinanceTabs />}
        title="Finance"
        description="The company's books, built from the in-game bank exports."
        actions={canImport ? <Button variant="outline" render={<Link href="/finance/imports" />}>Import bank export</Button> : null}
      />
      <PageBody className="space-y-6">
        <StatStrip cols={4}>
          <Kpi
            label="Cash (ledger)"
            hint={
              <span className={cn(reconciled ? "text-success" : "text-warning")}>
                {reconciled ? <CircleCheck className="mr-1 inline size-3.5 align-[-2px]" aria-hidden /> : <CircleAlert className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />}
                {reconciled ? "Matches the latest bank export" : <>Latest export: <Money cents={latest.reportedBalanceCents} /></>}
              </span>
            }
          >
            <Money cents={cash} />
          </Kpi>
          <Kpi label="Loan principal outstanding" hint="Disbursed minus principal repaid (all loans)">
            <Money cents={receivable} />
          </Kpi>
          <Kpi label={`Net profit · ${thisMonth.label.replace(/^This month \((.*)\)$/, "$1")}`} hint={<Link href="/finance/ledger" className="underline-offset-4 hover:underline">See profit &amp; loss</Link>}>
            <Money cents={pl.netCents} accounting />
          </Kpi>
          <Kpi
            label="Needs review"
            tone={toReview ? "warn" : undefined}
            hint={
              toReview ? (
                <Link href="/finance/transactions?view=review" className="underline-offset-4 hover:underline">
                  Classify these transactions
                </Link>
              ) : (
                "Every transaction is classified"
              )
            }
          >
            <span className="num">{toReview}</span>
          </Kpi>
        </StatStrip>

        {legacy.balanceCents !== 0 ? (
          <LegacyLoansCard
            lentCents={legacy.lentCents}
            repaidCents={legacy.repaidCents}
            balanceCents={legacy.balanceCents}
            bookedIncomeCents={legacy.bookedIncomeCents}
            canClose={can(viewer.role, "ledger.adjust")}
          />
        ) : null}

        {lenders.balanceCents !== 0 ? (
          <StaffLoansCard balanceCents={lenders.balanceCents} lenders={lenders.lenders} canClose={can(viewer.role, "ledger.adjust")} />
        ) : null}

        <ForecastCard forecast={forecast} />

        <div className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Recent imports</CardTitle>
              <CardAction>
                <Button variant="ghost" size="sm" render={<Link href="/finance/imports" />}>
                  All <ArrowRight />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableBody>
                  {batches.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="pl-6 text-sm">
                        <Link href={`/finance/imports/${b.id}`} className="underline-offset-4 hover:underline">
                          <LocalTime value={b.createdAt} />
                        </Link>
                        <div className="text-xs text-muted-foreground">by {b.createdBy ?? "system"}</div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="num">{formatCount(b.newCount)}</span> new
                        <span className="text-muted-foreground"> · {formatCount(b.duplicateCount)} skipped</span>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <Money cents={b.reportedBalanceCents} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tax withheld vs monthly records</CardTitle>
              <CardDescription>
                The bank withholds tax at source and now and then posts a &ldquo;Tax Payment&rdquo; record of it. The business
                account never pays it.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Month</TableHead>
                    <TableHead className="text-right">Withheld</TableHead>
                    <TableHead className="pr-6 text-right">Recorded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tax.slice(-6).reverse().map((m) => (
                    <TableRow key={m.month}>
                      <TableCell className="pl-6">{monthLabel(m.month)}</TableCell>
                      <TableCell className="text-right">
                        <Money cents={m.withheldCents} />
                      </TableCell>
                      <TableCell className="pr-6 text-right text-muted-foreground">
                        {m.recordedCents ? <Money cents={m.recordedCents} /> : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="px-6 pt-3 text-xs text-muted-foreground">Each record covers the tax withheld since the record before it, so a record usually matches the earlier month.</p>
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
