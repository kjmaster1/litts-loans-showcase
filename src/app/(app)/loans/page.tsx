import { cleanSearch } from "@/lib/search";
import { ClipboardPaste, FilePlus2, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DataAsOf } from "@/components/data/data-as-of";
import { ExportButton, exportHref } from "@/components/data/export-button";
import { dataFreshness } from "@/server/freshness";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LoanStatusBadge } from "@/components/data/loan-status-badge";
import { LocalTime } from "@/components/data/local-time";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { Money } from "@/components/data/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { requireViewer } from "@/server/authz/viewer";
import { lastPasteByTab, staleTabs } from "@/server/loans/paste";
import { relinkSuggestions } from "@/server/loans/relink";
import { RowLink, linkedRow } from "@/components/data/row-link";
import { ViewTabs } from "@/components/data/view-tabs";
import { SortHeader, type SortDir } from "@/components/data/sort-header";
import { activeStaffOptions, listLoans, loanKpis, loanStatusCounts, STATUS_FILTERS, type LoanListRow, type StatusFilter } from "@/server/loans/queries";
import { LoanFilters } from "./loan-filters";

export const metadata: Metadata = { title: "Loans" };

const TABS: { key: StatusFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "overdue", label: "Overdue" },
  { key: "defaulted", label: "Defaulted" },
  { key: "completed", label: "Completed" },
  { key: "written_off", label: "Written off" },
  { key: "all", label: "All" },
];
const TAB_LABEL = { active: "Active", overdue: "Overdue", default: "Default", complete: "Complete" } as const;

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Sortable columns and their natural first direction (redesign 2026-10). */
const SORTS = { opened: "desc", borrower: "asc", principal: "desc", outstanding: "desc" } as const satisfies Record<string, SortDir>;
type SortKey = keyof typeof SORTS;
const SORT_VALUE: Record<SortKey, (l: LoanListRow) => string | number> = {
  opened: (l) => l.openedAt?.getTime() ?? 0,
  borrower: (l) => (l.borrowerName ?? "").toLowerCase(),
  principal: (l) => l.principalCents,
  outstanding: (l) => l.outstandingCents ?? -1,
};


export default async function LoansPage({ searchParams }: PageProps<"/loans">) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const statusParam = one(sp.status);
  const status: StatusFilter = STATUS_FILTERS.includes(statusParam as StatusFilter) ? (statusParam as StatusFilter) : "active";
  const q = cleanSearch(one(sp.q)) || undefined;
  const seesAll = can(viewer.role, "loans.view_all");
  const officer = seesAll ? one(sp.officer)?.slice(0, 40) || undefined : undefined;
  const canPaste = can(viewer.role, "imports.paste");
  const canOriginate = can(viewer.role, "loans.originate");
  const sortParam = one(sp.sort);
  const sort: SortKey = sortParam && Object.hasOwn(SORTS, sortParam) ? (sortParam as SortKey) : "opened";
  const dir: SortDir = one(sp.dir) === "asc" || one(sp.dir) === "desc" ? (one(sp.dir) as SortDir) : SORTS[sort];

  const freshness = await dataFreshness();
  const [unsorted, kpis, lastPaste, staffOptions, mixedUp, counts] = await Promise.all([
    listLoans(viewer, { status, q, officer }),
    loanKpis(viewer),
    lastPasteByTab(),
    seesAll ? activeStaffOptions({ finished: true }) : Promise.resolve([]),
    can(viewer.role, "loans.edit_metadata") ? relinkSuggestions() : Promise.resolve([]),
    loanStatusCounts(viewer),
  ]);
  const value = SORT_VALUE[sort];
  const rows = [...unsorted].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return (x < y ? -1 : x > y ? 1 : 0) * (dir === "asc" ? 1 : -1);
  });
  const tabCount = (k: StatusFilter) =>
    k === "all" ? Object.values(counts).reduce((s, n) => s + n, 0) : k === "open" ? counts.active + counts.overdue + counts.defaulted : k === "live" ? counts.active + counts.overdue : counts[k as keyof typeof counts];
  // Views without a tab of their own (e.g. the dashboard's "Assign loan officers" → active and overdue) get one while shown.
  const EXTRA: Partial<Record<StatusFilter, string>> = { open: "Open", live: "Active & overdue" };
  const tabs = EXTRA[status] ? [{ key: status, label: EXTRA[status]! }, ...TABS] : TABS;
  const stale = staleTabs(lastPaste);

  const href = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { status: status === "active" ? undefined : status, q, officer, sort: sort === "opened" ? undefined : sort, dir: dir === SORTS[sort] ? undefined : dir, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    return `/loans${params.size ? `?${params}` : ""}`;
  };

  // Clicking the current column reverses it; another column starts in its natural direction.
  const sortHref = (k: SortKey) => {
    const next: SortDir = k === sort ? (dir === "asc" ? "desc" : "asc") : SORTS[k];
    return href({ sort: k === "opened" ? undefined : k, dir: next === SORTS[k] ? undefined : next });
  };

  return (
    <>
      <PageHeader
        title="Loans"
        description={seesAll ? "Every private loan, built from bank payments and the phone's weekly cards." : "Loans you look after."}
        actions={
          <>
            <ExportButton href={exportHref("/loans/export", { status, q, officer })} />
            {canOriginate ? (
              <Button variant="outline" render={<Link href="/loans/offers" />}>
                Offers
              </Button>
            ) : null}
            {canPaste ? (
              <Button variant="outline" render={<Link href="/loans/import" />}>
                <ClipboardPaste aria-hidden /> Paste phone cards
              </Button>
            ) : null}
            {canOriginate ? (
              <Button render={<Link href="/loans/new" />}>
                <FilePlus2 aria-hidden /> New loan
              </Button>
            ) : null}
          </>
        }
      />
      <PageBody className="space-y-6">
        {canPaste && stale.length > 0 ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden />
            <AlertTitle>Loan statuses may be out of date</AlertTitle>
            <AlertDescription>
              <p>
                {stale.map((tab) => TAB_LABEL[tab]).join(", ")}{" "}
                {stale.length === 1 ? "tab hasn't" : "tabs haven't"} been pasted in the last week. Statuses, missed payments and terms come
                from the phone, so paste all four tabs weekly.{" "}
                <Link href="/loans/import" className="font-medium text-foreground underline underline-offset-4">
                  Paste now
                </Link>
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {mixedUp.length ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden />
            <AlertTitle>
              {mixedUp.length} borrower{mixedUp.length === 1 ? " has" : "s have"} payments on the wrong loan
            </AlertTitle>
            <AlertDescription>
              <p>
                They had two loans at once and some payments were matched to the wrong one. Open each to review and apply the corrections:{" "}
                {mixedUp.slice(0, 8).map((b, i) => (
                  <span key={b.stateId}>
                    {i > 0 ? ", " : ""}
                    <Link href={`/loans/${b.loanId}`} className="font-medium text-foreground underline underline-offset-4">
                      {b.name ?? `#${b.stateId}`}
                    </Link>{" "}
                    ({b.moves})
                  </span>
                ))}
                {mixedUp.length > 8 ? ` and ${mixedUp.length - 8} more` : ""}.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        <StatStrip cols={6}>
          <Kpi
            label="Open loans"
            tone={seesAll && kpis.unassigned > 0 ? "warn" : undefined}
            hint={seesAll && kpis.unassigned > 0 ? `${kpis.unassigned} without an officer` : undefined}
            href={seesAll && kpis.unassigned > 0 ? href({ status: "live", officer: "unassigned" }) : undefined}
          >
            <span className="num">{kpis.open}</span>
          </Kpi>
          <Kpi label="Principal outstanding" hint="Defaulted loans included">
            <Money cents={kpis.outstandingCents} />
          </Kpi>
          <Kpi label="Excl. defaults" hint="Active and overdue only">
            <Money cents={kpis.outstandingLiveCents} />
          </Kpi>
          <Kpi label="Interest to come" hint="On principal still owed">
            <Money cents={kpis.interestToComeCents} />
          </Kpi>
          <Kpi label="Overdue" tone={kpis.overdue > 0 ? "warn" : undefined} hint="1–2 payments missed" href={href({ status: "overdue" })}>
            <span className="num">{kpis.overdue}</span>
          </Kpi>
          <Kpi
            label="Defaulted"
            tone={kpis.defaulted > 0 ? "bad" : undefined}
            href={href({ status: "defaulted" })}
            hint={kpis.dueForWriteOff > 0 ? `${kpis.dueForWriteOff} ready for write-off review` : "3+ payments missed"}
          >
            <span className="num">{kpis.defaulted}</span>
          </Kpi>
        </StatStrip>

        <div className="space-y-4">
          <ViewTabs
            label="Loan status"
            current={status}
            tabs={tabs.map((tab) => ({ ...tab, href: href({ status: tab.key === "active" ? undefined : tab.key }), count: tabCount(tab.key) }))}
          />

          <LoanFilters q={q} officer={officer} staff={seesAll ? staffOptions : null} />

          {rows.length === 0 ? (
            <Empty className="rounded-xl border">
              <EmptyHeader>
                <EmptyTitle>No loans here</EmptyTitle>
                <EmptyDescription>
                  {q || officer
                    ? "Try a different search or filter."
                    : seesAll
                      ? "Loans appear when a bank export with loan transfers is imported."
                      : "No loans are assigned to you yet. Claim yours when pasting the phone cards."}
                </EmptyDescription>
              </EmptyHeader>
              {!seesAll && canPaste ? (
                <EmptyContent>
                  <Button variant="outline" render={<Link href="/loans/import" />}>
                    Paste phone cards
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-lg bg-card shadow-xs ring-1 ring-foreground/[0.08] dark:ring-foreground/10">
              <Table id="results" tabIndex={-1} className="focus:outline-none">
                <caption className="sr-only">
                  {rows.length} loans, sorted by {sort} {dir === "asc" ? "ascending" : "descending"}
                </caption>
                <TableHeader>
                  <TableRow>
                    <SortHeader label="Borrower" active={sort === "borrower"} dir={dir} href={sortHref("borrower")} />
                    <SortHeader label="Principal" align="right" active={sort === "principal"} dir={dir} href={sortHref("principal")} />
                    <TableHead className="hidden md:table-cell">Progress</TableHead>
                    <SortHeader label="Outstanding" align="right" active={sort === "outstanding"} dir={dir} href={sortHref("outstanding")} className="hidden sm:table-cell" />
                    <TableHead className="hidden lg:table-cell">Officer</TableHead>
                    <SortHeader label="Opened" active={sort === "opened"} dir={dir} href={sortHref("opened")} className="hidden xl:table-cell" />
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((l) => (
                    <TableRow key={l.id} className={linkedRow}>
                      <TableCell className="align-top whitespace-normal">
                        <RowLink href={`/loans/${l.id}`}>{l.borrowerName ?? "Unknown borrower"}</RowLink>
                        <div className="text-xs text-muted-foreground">
                          <span className="ident">#{l.borrowerStateId}</span>
                          {l.brokerRateBp !== null ? <span> · {l.brokerRateBp / 100}%</span> : null}
                          <span className="md:hidden">
                            {l.instalments ? ` · ${l.lastCompleted ?? 0}/${l.instalments}` : ""}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right align-top">
                        <Money cents={l.principalCents} />
                      </TableCell>
                      <TableCell className="hidden align-top md:table-cell">
                        {l.instalments ? (
                          <div className="space-y-1">
                            <div className="text-sm">
                              <span className="num">
                                {l.lastCompleted ?? 0}/{l.instalments}
                              </span>
                              {l.lastMissed ? <span className="text-warning"> · {l.lastMissed} missed</span> : null}
                            </div>
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
                              <div
                                className={cn("h-full rounded-full", l.lastMissed ? "bg-warning" : "bg-primary")}
                                style={{ width: `${Math.min(100, ((l.lastCompleted ?? 0) / l.instalments) * 100)}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Terms unknown: paste cards</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-right align-top sm:table-cell">
                        {/* Never below zero, like the loan page and the totals: a small overpayment is the game's rounding or its penalties (QA 2026-10-13). */}
                        {l.outstandingCents === null ? <span className="text-muted-foreground">—</span> : <Money cents={Math.max(0, l.outstandingCents)} />}
                      </TableCell>
                      <TableCell className="hidden align-top lg:table-cell">
                        {l.officerName ?? <span className="text-muted-foreground">Unassigned</span>}
                      </TableCell>
                      <TableCell className="hidden align-top text-sm xl:table-cell">
                        <LocalTime value={l.openedAt} format="date" />
                      </TableCell>
                      <TableCell className="align-top">
                        <LoanStatusBadge status={l.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {rows.length === 500 ? "Showing the newest 500. Search to narrow it down." : `${rows.length} loan${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <DataAsOf freshness={freshness} sources={["cards", "bank"]} />
      </PageBody>
    </>
  );
}
