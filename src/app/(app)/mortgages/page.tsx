import { cleanSearch } from "@/lib/search";
import { FilePlus2, TabletSmartphone, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DataAsOf } from "@/components/data/data-as-of";
import { ExportButton, exportHref } from "@/components/data/export-button";
import { dataFreshness } from "@/server/freshness";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { MortgageStateBadge } from "@/components/data/mortgage-state-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can } from "@/lib/permissions";
import { requireViewer } from "@/server/authz/viewer";
import { listMortgages, MORTGAGE_FILTERS, mortgageKpis, type MortgageFilter } from "@/server/mortgages/queries";
import { MortgageSearch } from "./mortgage-search";
import { RowLink, linkedRow } from "@/components/data/row-link";
import { ViewTabs } from "@/components/data/view-tabs";

export const metadata: Metadata = { title: "Mortgages" };

const TABS: { key: MortgageFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "behind", label: "Late or behind" },
  { key: "completed", label: "Completed" },
  { key: "unpasted", label: "Not pasted" },
  { key: "all", label: "All" },
];

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function MortgagesPage({ searchParams }: PageProps<"/mortgages">) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const param = one(sp.status);
  const status: MortgageFilter = MORTGAGE_FILTERS.includes(param as MortgageFilter) ? (param as MortgageFilter) : "active";
  const q = cleanSearch(one(sp.q)) || undefined;
  const seesAll = can(viewer.role, "loans.view_all");
  const canPaste = can(viewer.role, "imports.paste");
  const canOriginate = can(viewer.role, "loans.originate");
  const [rows, k, freshness] = await Promise.all([listMortgages(viewer, { status, q }), mortgageKpis(viewer), dataFreshness()]);

  const tabCount: Record<MortgageFilter, number> = { active: k.active, behind: k.behind + k.late, completed: k.completed, unpasted: k.unpasted, all: k.total };
  const href = (s: MortgageFilter) => {
    const params = new URLSearchParams();
    if (s !== "active") params.set("status", s);
    if (q) params.set("q", q);
    return `/mortgages${params.size ? `?${params}` : ""}`;
  };

  return (
    <>
      <PageHeader
        title="Mortgages"
        description={
          seesAll
            ? "Property loans arranged on the tablet. The State lends the principal; Litt's earns the banker fee and broker interest."
            : "Mortgages you arranged."
        }
        actions={
          <>
            <ExportButton href={exportHref("/mortgages/export", { status, q })} />
            {canOriginate ? (
              <Button variant="outline" render={<Link href="/mortgages/quotes" />}>
                Quotes
              </Button>
            ) : null}
            {canPaste ? (
              <Button variant="outline" render={<Link href="/mortgages/import" />}>
                <TabletSmartphone aria-hidden /> Paste from tablet
              </Button>
            ) : null}
            {canOriginate ? (
              <Button render={<Link href="/mortgages/quotes/new" />}>
                <FilePlus2 aria-hidden /> New quote
              </Button>
            ) : null}
          </>
        }
      />
      <PageBody className="space-y-6">
        {canPaste && (k.unpasted > 0 || k.unlinkedRepayments > 0) ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden />
            <AlertTitle>{k.unpasted > 0 ? `${k.unpasted} mortgage${k.unpasted === 1 ? " hasn't" : "s haven't"} been pasted from the tablet` : "Repayments without a mortgage"}</AlertTitle>
            <AlertDescription>
              <p>
                {k.unpasted > 0 ? "Without the tablet details there's no schedule, officer or rates. " : ""}
                {k.unlinkedRepayments > 0
                  ? `${k.unlinkedRepayments} repayment${k.unlinkedRepayments === 1 ? " is" : "s are"} for a property with no mortgage on record yet. Paste its agreement to link ${k.unlinkedRepayments === 1 ? "it" : "them"}. `
                  : ""}
                <Link href="/mortgages/import" className="font-medium text-foreground underline underline-offset-4">
                  Paste from tablet
                </Link>
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        <StatStrip cols={4}>
          <Kpi label="Active mortgages">
            <span className="num">{k.active}</span>
          </Kpi>
          <Kpi
            label="Owed to the State"
            hint={
              k.owedToCompanyCents > 0 ? (
                <>
                  Plus <Money cents={k.owedToCompanyCents} /> owed to Litt&rsquo;s on company-funded mortgages
                </>
              ) : (
                "Principal still to be repaid and passed on"
              )
            }
          >
            <Money cents={k.owedToStateCents} />
          </Kpi>
          <Kpi label="Broker interest to come" hint="Litt's share of the remaining instalments">
            <Money cents={k.brokerInterestToComeCents} />
          </Kpi>
          <Kpi label="Late or behind" tone={k.behind > 0 ? "bad" : k.late > 0 ? "warn" : undefined} hint={k.behind > 0 ? `${k.behind} past the grace period` : "Payment past due"}>
            <span className="num">{k.behind + k.late}</span>
          </Kpi>
        </StatStrip>

        <div className="space-y-4">
          <ViewTabs label="Mortgage status" current={status} tabs={TABS.map((t) => ({ ...t, href: href(t.key), count: tabCount[t.key] }))} />
          <MortgageSearch q={q} />

          {rows.length === 0 ? (
            <Empty className="rounded-xl border">
              <EmptyHeader>
                <EmptyTitle>No mortgages here</EmptyTitle>
                <EmptyDescription>{q ? "Try a different search." : seesAll ? "Mortgages appear when a bank export with a down payment is imported." : "No mortgages are assigned to you yet."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table id="results" tabIndex={-1} className="focus:outline-none">
                <TableHeader>
                  <TableRow>
                    <TableHead>Property</TableHead>
                    <TableHead className="text-right">Loan</TableHead>
                    <TableHead className="hidden md:table-cell">Paid</TableHead>
                    <TableHead className="hidden lg:table-cell">Officer</TableHead>
                    <TableHead className="hidden xl:table-cell">Started</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((m) => (
                    <TableRow key={m.id} className={linkedRow}>
                      <TableCell className="align-top whitespace-normal">
                        <RowLink href={`/mortgages/${m.id}`}>
                          {m.address}
                        </RowLink>
                        <div className="text-xs text-muted-foreground">
                          {m.buyerName ?? "Unknown buyer"}
                          {m.buyerStateId ? <span className="ident"> #{m.buyerStateId}</span> : null}
                          {m.funding === "company" ? <span className="text-info"> · company-funded</span> : null}
                          {m.flags.length ? (
                            <span className={m.flags.some((f) => f.level === "breach") ? "text-danger" : "text-warning"}>
                              {" "}
                              · {m.flags.length} guideline {m.flags.length === 1 ? "flag" : "flags"}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right align-top">
                        {m.loanCents !== null ? <Money cents={m.loanCents} /> : <span className="text-muted-foreground">—</span>}
                        {m.priceCents ? (
                          <div className="text-xs text-muted-foreground">
                            of <Money cents={m.priceCents} />
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden align-top md:table-cell">
                        {m.instalments ? (
                          <div className="space-y-1">
                            <span className="num text-sm">
                              {m.paymentsMade}/{m.instalments}
                            </span>
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
                              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (m.paymentsMade / m.instalments) * 100)}%` }} />
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">{m.paymentsMade} payment{m.paymentsMade === 1 ? "" : "s"}</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden align-top lg:table-cell">{m.officerName ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                      <TableCell className="hidden align-top text-sm xl:table-cell">
                        <LocalTime value={m.originatedAt} format="date" />
                      </TableCell>
                      <TableCell className="align-top">
                        <MortgageStateBadge status={m.status} state={m.state} pasted={m.pasted} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
        <DataAsOf freshness={freshness} sources={["tablet", "bank"]} />
      </PageBody>
    </>
  );
}
