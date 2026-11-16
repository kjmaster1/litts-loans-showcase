import { Download } from "lucide-react";
import { dateFormat } from "@/lib/dates";
import type { Metadata } from "next";
import { ViewTabs } from "@/components/data/view-tabs";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Money } from "@/components/data/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { zonedParts } from "@/lib/company-time";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { buildReport, firstActivity, parseRange, REPORT_TITLES, REPORTS, type Cell, type Column, type ReportKey } from "@/server/reports/reports";
import { RangeForm } from "./range-form";
import { FinanceTabs } from "@/components/app-shell/section-tabs";

export const metadata: Metadata = { title: "Reports" };

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

const pad = (n: number) => String(n).padStart(2, "0");

function CellView({ column, value }: { column: Column; value: Cell | undefined }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  if (column.kind === "money") return <Money cents={Number(value)} accounting />;
  if (column.kind === "percent") return <span className="num">{Math.round(Number(value) * 100)}%</span>;
  if (column.kind === "number") return <span className="num">{String(value)}</span>;
  if (column.kind === "date" && value instanceof Date) {
    return <span className="num">{dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(value)}</span>;
  }
  return <>{String(value)}</>;
}

export default async function ReportsPage({ searchParams }: PageProps<"/finance/reports">) {
  const viewer = await requireCapabilityPage("finance.view");
  const sp = await searchParams;
  const key: ReportKey = REPORTS.includes(one(sp.report) as ReportKey) ? (one(sp.report) as ReportKey) : "pnl";
  const range = parseRange(one(sp.from), one(sp.to));
  const [report, first] = await Promise.all([buildReport(viewer, key, range), firstActivity()]);

  const today = zonedParts(new Date());
  const todayKey = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
  const lastMonth = today.month === 1 ? { y: today.year - 1, m: 12 } : { y: today.year, m: today.month - 1 };
  const lastMonthEnd = new Date(Date.UTC(lastMonth.y, lastMonth.m, 0)).getUTCDate();
  const presets = [
    { label: "This month", from: `${today.year}-${pad(today.month)}-01`, to: todayKey },
    { label: "Last month", from: `${lastMonth.y}-${pad(lastMonth.m)}-01`, to: `${lastMonth.y}-${pad(lastMonth.m)}-${pad(lastMonthEnd)}` },
    { label: "This year", from: `${today.year}-01-01`, to: todayKey },
    ...(first ? [{ label: "All time", from: first, to: todayKey }] : []),
  ];
  const qs = (patch: Record<string, string>) => new URLSearchParams({ report: key, from: range.fromKey, to: range.toKey, ...patch }).toString();

  return (
    <>
      <PageHeader
        tabs={<FinanceTabs />}
        title="Reports"
        description="Built from the books. Dates are UK time; every download is recorded in the audit log."
        actions={
          <Button render={<a href={`/finance/reports/export?${qs({})}`} />}>
            <Download aria-hidden /> Download Excel
          </Button>
        }
      />
      <PageBody className="space-y-6">
        <ViewTabs label="Report" current={key} tabs={REPORTS.map((r) => ({ key: r, label: REPORT_TITLES[r], href: `/finance/reports?${qs({ report: r })}` }))} />

        <RangeForm report={key} from={range.fromKey} to={range.toKey} presets={presets} />

        <div>
          <h2 className="text-lg font-semibold">{report.title}</h2>
          <p className="text-sm text-muted-foreground">{report.subtitle}</p>
        </div>

        {report.tables.map((t) => (
          <Card key={t.title}>
            <CardHeader>
              <CardTitle>{t.title}</CardTitle>
              {t.note ? <CardDescription>{t.note}</CardDescription> : null}
            </CardHeader>
            <CardContent className="px-0">
              {t.rows.length === 0 ? (
                <p className="px-6 text-sm text-muted-foreground">Nothing in this period.</p>
              ) : (
                <Table scrollLabel={t.title}>
                  <TableHeader>
                    <TableRow>
                      {t.columns.map((c, i) => (
                        <TableHead key={c.key} className={cn(i === 0 && "pl-6", i === 0 && t.columns.length > 4 && "sticky-col", i === t.columns.length - 1 && "pr-6", (c.kind === "money" || c.kind === "percent" || c.kind === "number") && "text-right", "whitespace-nowrap")}>
                          {c.label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {t.rows.map((row, ri) => (
                      <TableRow key={ri}>
                        {t.columns.map((c, i) => (
                          <TableCell key={c.key} className={cn(i === 0 && "pl-6", i === 0 && t.columns.length > 4 && "sticky-col", i === t.columns.length - 1 && "pr-6", (c.kind === "money" || c.kind === "percent" || c.kind === "number") && "text-right")}>
                            <CellView column={c} value={row[c.key]} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                  {t.total ? (
                    <TableFooter>
                      <TableRow>
                        {t.columns.map((c, i) => (
                          <TableCell key={c.key} className={cn("font-medium", i === 0 && "pl-6", i === 0 && t.columns.length > 4 && "sticky-col", i === t.columns.length - 1 && "pr-6", (c.kind === "money" || c.kind === "percent" || c.kind === "number") && "text-right")}>
                            <CellView column={c} value={t.total![c.key]} />
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableFooter>
                  ) : null}
                </Table>
              )}
            </CardContent>
          </Card>
        ))}
      </PageBody>
    </>
  );
}
