import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LoanStatusBadge } from "@/components/data/loan-status-badge";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireViewer } from "@/server/authz/viewer";
import { COLLECTION_LABEL, collectionsQueue, type QueueRow } from "@/server/loans/collections";
import { RowLink, linkedRow } from "@/components/data/row-link";
import { shorten } from "@/components/data/long-text";
import { formatCents } from "@/lib/money";
import { DataAsOf } from "@/components/data/data-as-of";
import { ExportButton } from "@/components/data/export-button";
import { dataFreshness } from "@/server/freshness";

export const metadata: Metadata = { title: "Collections" };

function CaseStatus({ r }: { r: QueueRow }) {
  if (r.type === "mortgage") {
    return r.status === "late" ? <StatusBadge tone="warning">Mortgage · in grace</StatusBadge> : <StatusBadge tone="danger">Mortgage · behind</StatusBadge>;
  }
  return <LoanStatusBadge status={r.status as "overdue" | "defaulted" | "written_off"} />;
}

export default async function CollectionsPage() {
  const viewer = await requireViewer();
  const [rows, freshness] = await Promise.all([collectionsQueue(viewer), dataFreshness()]);
  const due = rows.filter((r) => r.due).length;
  const broken = rows.filter((r) => r.brokenPromises > 0).length;
  const promised = rows.filter((r) => r.pendingPromise).reduce((s, r) => s + (r.pendingPromise?.promiseCents ?? 0), 0);
  const owed = rows.filter((r) => r.status !== "written_off").reduce((s, r) => s + r.owedCents, 0);

  return (
    <>
      <PageHeader
        title="Collections"
        description="Overdue and defaulted loans and mortgages behind on payments, most urgent first. Promises to pay are checked against the bank."
        actions={rows.length > 0 ? <ExportButton href="/loans/collections/export" /> : null}
      />
      <PageBody className="space-y-6">
        {rows.length === 0 ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>Nothing to chase</EmptyTitle>
              <EmptyDescription>No overdue or defaulted loans or late mortgages{viewer.role === "loan_officer" ? " of yours" : ""}.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <StatStrip cols={4}>
              <Kpi label="Need action now" tone={due > 0 ? "warn" : undefined} hint="not contacted or follow-up due">
                {due}
              </Kpi>
              <Kpi label="Broken promises" tone={broken > 0 ? "bad" : undefined} hint={broken === 1 ? "borrower" : "borrowers"}>
                {broken}
              </Kpi>
              <Kpi label="Promised, not yet due" hint="checked against the bank">
                {formatCents(promised)}
              </Kpi>
              <Kpi label="Owed on these cases" hint="excludes written off">
                {formatCents(owed)}
              </Kpi>
            </StatStrip>
            <Card>
              <CardContent className="px-0">
                <Table id="results" tabIndex={-1} className="focus:outline-none" scrollLabel="Collections">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Borrower</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Missed</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Owed</TableHead>
                      <TableHead className="hidden md:table-cell">Last action</TableHead>
                      <TableHead className="hidden pr-6 sm:table-cell">Follow up</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={`${r.type}-${r.id}`} className={linkedRow}>
                        <TableCell className="pl-6 whitespace-normal">
                          <RowLink href={r.href}>{r.borrower}</RowLink>
                          <div className="text-xs text-muted-foreground">
                            {r.stateId !== null ? `#${r.stateId}` : "No State ID"}
                            {r.officerName ? ` · ${r.officerName}` : " · no officer"}
                          </div>
                          {/* Phones: the money and the next step, which sit in columns off-screen otherwise (UX review 2026-10-12). */}
                          <div className="mt-0.5 text-xs sm:hidden">
                            Owes <Money cents={r.owedCents} />
                            {r.missed ? ` · ${r.missed} missed` : ""}
                            {r.due ? <span className="font-medium text-warning"> · {!r.last ? "not contacted" : "follow up now"}</span> : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="flex flex-wrap gap-1">
                            <CaseStatus r={r} />
                            {r.brokenPromises > 0 ? (
                              <StatusBadge tone="danger">{r.brokenPromises === 1 ? "Broke a promise" : `Broke ${r.brokenPromises} promises`}</StatusBadge>
                            ) : null}
                            {r.withLegal ? <StatusBadge tone="info">With Legal</StatusBadge> : null}
                          </span>
                        </TableCell>
                        <TableCell className="num hidden text-right sm:table-cell">{r.missed ?? "—"}</TableCell>
                        <TableCell className="hidden text-right sm:table-cell">
                          <Money cents={r.owedCents} />
                        </TableCell>
                        <TableCell className="hidden max-w-sm whitespace-normal md:table-cell">
                          {r.last ? (
                            <>
                              <span className="text-sm">{COLLECTION_LABEL[r.last.kind]}</span>
                              {r.last.outcome ? (
                                <span className="text-sm">
                                  {" "}
                                  ({formatCents(r.last.promiseCents ?? 0)},{" "}
                                  {r.last.outcome.state === "kept" ? "kept" : r.last.outcome.state === "broken" ? <strong className="text-danger">broken</strong> : "pending"})
                                </span>
                              ) : null}
                              {r.last.note ? <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]"> · {shorten(r.last.note, 160)}</span> : null}
                              <div className="text-xs text-muted-foreground">
                                <LocalTime value={r.last.at} format="relative" /> · {r.last.staffName}
                              </div>
                            </>
                          ) : (
                            <span className="text-sm text-muted-foreground">Nothing logged</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden pr-6 sm:table-cell">
                          {r.due ? (
                            <StatusBadge tone="warning">{!r.last ? "Not contacted" : r.last.outcome?.state === "broken" ? "Chase now" : "Due"}</StatusBadge>
                          ) : r.pendingPromise?.promiseBy ? (
                            <span className="text-sm">
                              Promise by <LocalTime value={r.pendingPromise.promiseBy} format="date" />
                            </span>
                          ) : r.nextActionAt ? (
                            <LocalTime value={r.nextActionAt} format="date" />
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <p className="text-caption">
              <Link href="/loans" className="underline underline-offset-2">
                Loans
              </Link>{" "}
              and{" "}
              <Link href="/mortgages?status=behind" className="underline underline-offset-2">
                late mortgages
              </Link>{" "}
              open their own collections log. A promise counts as kept once the borrower has paid the promised amount by the end of the day they named.
            </p>
          </>
        )}
        <DataAsOf freshness={freshness} sources={["cards", "tablet", "bank"]} />
      </PageBody>
    </>
  );
}
