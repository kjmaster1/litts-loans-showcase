import type { Metadata } from "next";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { ListSearch } from "@/components/data/list-search";
import { Money } from "@/components/data/money";
import { RowLink, linkedRow } from "@/components/data/row-link";
import { StatusBadge } from "@/components/data/status-badge";
import { ViewTabs } from "@/components/data/view-tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateFormat } from "@/lib/format";
import { asStateId, cleanSearch } from "@/lib/search";
import { requireViewer } from "@/server/authz/viewer";
import { listCases, type CaseRow, type CaseState } from "@/server/legal/cases";
import { CaseStateBadge } from "./case-state";

export const metadata: Metadata = { title: "Legal cases" };

const DAY = dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });

const VIEWS = ["open", "needs_details", "ready", "with_legal", "closed"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = { open: "Open", needs_details: "Needs details", ready: "Ready", with_legal: "With Legal", closed: "Closed" };
const inView = (v: View, s: CaseState) => (v === "open" ? s !== "closed" : s === v);

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function matches(r: CaseRow, q: string) {
  const id = asStateId(q);
  if (id !== null) return r.stateId === id;
  return r.borrowerName.toLowerCase().includes(q.toLowerCase()) || (r.officerName ?? "").toLowerCase().includes(q.toLowerCase());
}

/** Defaulted loans going to court (2026-11-10): what each case still needs, and what's with Legal. */
export default async function LegalCasesPage({ searchParams }: PageProps<"/loans/legal">) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const raw = one(sp.view);
  const view: View = raw && (VIEWS as readonly string[]).includes(raw) ? (raw as View) : "open";
  const q = cleanSearch(one(sp.q));
  const all = await listCases(viewer);
  const searched = q ? all.filter((r) => matches(r, q)) : all;
  const rows = searched.filter((r) => inView(view, r.state));
  const own = viewer.role === "loan_officer";
  const href = (v: View) => {
    const p = new URLSearchParams();
    if (v !== "open") p.set("view", v);
    if (q) p.set("q", q);
    return `/loans/legal${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <PageHeader
        title="Legal cases"
        description={
          own
            ? "Your defaulted loans going to court. When Legal asks, fill in the fee per day and collateral from the signed contract."
            : "Defaulted loans going to court: the case sheet for the lawyer, the attorney’s fee, and what’s come back."
        }
      />
      <PageBody className="space-y-4">
        <ViewTabs
          label="Cases"
          current={view}
          tabs={VIEWS.map((v) => ({ key: v, label: VIEW_LABEL[v], href: href(v), count: searched.filter((r) => inView(v, r.state)).length, tone: v === "needs_details" ? "attention" : undefined }))}
        />
        <div className="flex">
          <ListSearch q={q} label="Search cases" placeholder="Name, State ID or officer" />
        </div>
        {rows.length === 0 ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>{all.length === 0 ? "No defaulted loans" : "No cases here"}</EmptyTitle>
              <EmptyDescription>
                {all.length === 0 ? `A loan appears here once the game defaults it${own ? " (yours only)" : ""}.` : q ? "Nothing matches that search." : "Try another tab."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card>
            <CardContent className="px-0">
              <Table id="results" tabIndex={-1} className="focus:outline-none" scrollLabel="Legal cases">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Borrower</TableHead>
                    <TableHead>Case</TableHead>
                    <TableHead className="hidden sm:table-cell">Defaulted</TableHead>
                    <TableHead className="pr-6 text-right">Claim</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.loanId} className={linkedRow}>
                      <TableCell className="pl-6 whitespace-normal">
                        <RowLink href={`/loans/legal/${r.loanId}`}>{r.borrowerName}</RowLink>
                        <div className="text-xs text-muted-foreground">
                          #{r.stateId}
                          {r.officerName ? ` · ${r.officerName}` : " · no officer"}
                          {r.number ? ` · LC${r.number}` : ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          <CaseStateBadge state={r.state} />
                          {r.state === "needs_details" && r.detailsRequestedAt ? <StatusBadge tone="neutral">Officer asked</StatusBadge> : null}
                          {r.handedAt ? r.feePaid ? <StatusBadge tone="success">Fee paid</StatusBadge> : <StatusBadge tone="danger">Fee not paid</StatusBadge> : null}
                        </span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{r.defaultAt ? DAY.format(r.defaultAt) : "—"}</TableCell>
                      <TableCell className="pr-6 text-right">
                        {r.totalCents !== null ? <Money cents={r.totalCents} /> : r.claimCents !== null ? <Money cents={r.claimCents} /> : "—"}
                        {r.totalCents === null && r.claimCents !== null ? <div className="text-xs text-muted-foreground">before fees</div> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}
