import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { RecentlyViewed } from "@/components/app-shell/recently-viewed";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LoanStatusBadge } from "@/components/data/loan-status-badge";
import { LocalTime } from "@/components/data/local-time";
import { LongText } from "@/components/data/long-text";
import { Money } from "@/components/data/money";
import { MortgageStateBadge } from "@/components/data/mortgage-state-badge";
import { RowLink, linkedRow } from "@/components/data/row-link";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { borrowerProfile } from "@/server/borrowers";
import { COLLECTION_LABEL } from "@/server/loans/collections";
import { DoNotLend } from "../do-not-lend";

export const metadata: Metadata = { title: "Borrower" };

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** "$15,000", "15000" → cents; anything else → null. */
function dollars(v: string | undefined): number | null {
  const n = Number((v ?? "").replace(/[$,\s]/g, ""));
  return v && Number.isFinite(n) && n > 0 && n < 100_000_000 ? Math.round(n) * 100 : null;
}

function percent(v: string | undefined): number | null {
  const n = Number((v ?? "").replace(/[%\s]/g, ""));
  return v && Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * 100) : null;
}

const FLAG_STYLE = {
  danger: { icon: CircleAlert, className: "text-danger" },
  warning: { icon: TriangleAlert, className: "text-warning" },
  info: { icon: Info, className: "text-muted-foreground" },
  good: { icon: CircleCheck, className: "text-success" },
} as const;

const OUTCOME = { kept: ["success", "Kept"], pending: ["neutral", "Not due yet"], broken: ["danger", "Broken"] } as const;

/** Borrower profile (research/12): one State ID's whole relationship with Litt's. */
export default async function BorrowerPage({ params, searchParams }: PageProps<"/loans/borrowers/[stateId]">) {
  const viewer = await requireCapabilityPage("borrower.lookup");
  const { stateId: raw } = await params;
  if (!/^\d{1,7}$/.test(raw)) notFound();
  const stateId = Number(raw);
  const sp = await searchParams;
  const amountCents = dollars(one(sp.amount));
  const rateBp = percent(one(sp.rate));
  const p = await borrowerProfile(viewer, stateId, { amountCents, rateBp });
  const { check, totals } = p;
  const canFlag = can(viewer.role, "loans.edit_metadata");
  const title = p.name ?? `State ID ${stateId}`;
  const open = p.loans.filter((l) => l.status === "active" || l.status === "overdue" || l.status === "defaulted").length;

  return (
    <>
      <PageHeader
        title={title}
        crumbs={[{ label: "Borrowers", href: "/loans/borrowers" }]}
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="ident text-sm text-muted-foreground">#{stateId}</span>
            {check.doNotLend ? <StatusBadge tone="danger">Do not lend</StatusBadge> : null}
            {totals.missedNow ? <StatusBadge tone="warning">{totals.missedNow} payments missed now</StatusBadge> : null}
          </span>
        }
        description={
          p.loans.length || p.mortgages.length
            ? `${p.loans.length} loan${p.loans.length === 1 ? "" : "s"} and ${p.mortgages.length} mortgage${p.mortgages.length === 1 ? "" : "s"} with Litt’s.`
            : "No loans or mortgages with Litt’s yet."
        }
      />
      <RecentlyViewed item={{ kind: "borrower", title, detail: `#${stateId}`, href: `/loans/borrowers/${stateId}` }} />
      <PageBody className="space-y-6">
        <StatStrip cols={totals.netCents !== null ? 5 : 4}>
          <Kpi label="Owes on loans" tone={totals.owedCents && totals.missedNow ? "warn" : undefined} hint={`${open} open`}>
            <Money cents={totals.owedCents} />
          </Kpi>
          <Kpi label="Borrowed in total" hint={`${p.loans.length} loan${p.loans.length === 1 ? "" : "s"}`}>
            <Money cents={totals.lentCents} />
          </Kpi>
          <Kpi label="Interest paid" hint="before tax">
            <Money cents={totals.interestPaidCents} />
          </Kpi>
          <Kpi label="Track record" tone={totals.wentBad ? "bad" : undefined} hint={totals.wentBad ? `${totals.wentBad} went bad` : "none went bad"}>
            <span className="num">
              {totals.repaid} repaid
            </span>
          </Kpi>
          {totals.netCents !== null ? (
            <Kpi label="Net to Litt’s" tone={totals.netCents < 0 ? "bad" : undefined} hint="lifetime, before commission">
              <Money cents={totals.netCents} />
            </Kpi>
          ) : null}
        </StatStrip>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-6">
            {p.loans.length ? (
              <Card>
                <CardHeader>
                  <CardTitle>Loans</CardTitle>
                </CardHeader>
                <CardContent className="px-0">
                  <Table scrollLabel="Loans">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-6">Opened</TableHead>
                        <TableHead className="text-right">Principal</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Owed</TableHead>
                        {totals.netCents !== null ? <TableHead className="hidden text-right sm:table-cell">Net to Litt’s</TableHead> : null}
                        <TableHead className="hidden pr-6 md:table-cell">Officer</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {p.loans.map((l) => (
                        <TableRow key={l.id} className={l.visible ? linkedRow : undefined}>
                          <TableCell className="pl-6">
                            {l.visible ? (
                              <RowLink href={`/loans/${l.id}`}>
                                <LocalTime value={l.openedAt} format="date" />
                              </RowLink>
                            ) : (
                              <LocalTime value={l.openedAt} format="date" />
                            )}
                            {l.instalments ? (
                              <div className="text-xs text-muted-foreground">
                                {l.lastCompleted ?? 0}/{l.instalments} paid
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right">
                            <Money cents={l.principalCents} />
                          </TableCell>
                          <TableCell>
                            <span className="flex flex-wrap items-center gap-1">
                              <LoanStatusBadge status={l.status} />
                              {l.lastMissed && l.status !== "completed" ? <span className="text-xs text-warning">{l.lastMissed} missed</span> : null}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            {l.status === "active" || l.status === "overdue" || l.status === "defaulted" ? <Money cents={Math.max(0, l.outstandingCents ?? 0)} /> : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          {totals.netCents !== null ? (
                            <TableCell className="hidden text-right sm:table-cell">
                              <Money cents={l.netCents ?? 0} accounting />
                            </TableCell>
                          ) : null}
                          <TableCell className="hidden pr-6 md:table-cell">{l.officerName ?? <span className="text-muted-foreground">—</span>}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : null}

            {p.mortgages.length ? (
              <Card>
                <CardHeader>
                  <CardTitle>Mortgages</CardTitle>
                </CardHeader>
                <CardContent className="px-0">
                  <Table scrollLabel="Mortgages">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-6">Property</TableHead>
                        <TableHead className="text-right">Loan</TableHead>
                        <TableHead>Payments</TableHead>
                        {totals.netCents !== null ? <TableHead className="hidden text-right sm:table-cell">Net to Litt’s</TableHead> : null}
                        <TableHead className="hidden pr-6 md:table-cell">Started</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {p.mortgages.map((m) => (
                        <TableRow key={m.id} className={m.visible ? linkedRow : undefined}>
                          <TableCell className="pl-6">
                            {m.visible ? <RowLink href={`/mortgages/${m.id}`}>{m.address}</RowLink> : m.address}
                            {m.funding === "company" ? <div className="text-xs text-muted-foreground">Funded by Litt’s</div> : null}
                          </TableCell>
                          <TableCell className="text-right">{m.loanCents !== null ? <Money cents={m.loanCents} /> : "—"}</TableCell>
                          <TableCell>
                            <MortgageStateBadge status={m.status} state={m.state} />
                          </TableCell>
                          {totals.netCents !== null ? (
                            <TableCell className="hidden text-right sm:table-cell">
                              <Money cents={m.netCents ?? 0} accounting />
                            </TableCell>
                          ) : null}
                          <TableCell className="hidden pr-6 md:table-cell">
                            <LocalTime value={m.originatedAt} format="date" />
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
                <CardTitle>Collections and notes</CardTitle>
                <CardDescription>
                  {p.activity.length ? "Newest first, across their loans and mortgages." : "Nothing logged on loans or mortgages you can see."}
                </CardDescription>
              </CardHeader>
              {p.activity.length ? (
                <CardContent>
                  <ol className="space-y-3 text-sm">
                    {p.activity.map((a) => (
                      <li key={a.key} className="border-l pl-3">
                        <div className="font-medium">
                          {a.kind === "note" ? "Note" : COLLECTION_LABEL[a.entry.kind]}
                          {a.kind === "collection" && a.entry.promiseCents ? (
                            <span className="font-normal">
                              {" "}
                              · {formatCents(a.entry.promiseCents)} by <LocalTime value={a.entry.promiseBy} format="date" />
                            </span>
                          ) : null}
                          {a.kind === "collection" && a.entry.outcome ? (
                            <StatusBadge tone={OUTCOME[a.entry.outcome.state][0]} className="ml-2 align-middle">
                              {OUTCOME[a.entry.outcome.state][1]}
                            </StatusBadge>
                          ) : null}
                        </div>
                        {(a.kind === "note" ? a.text : a.entry.note) ? (
                          <LongText className="text-muted-foreground" text={(a.kind === "note" ? a.text : a.entry.note) ?? ""} />
                        ) : null}
                        <div className="text-xs text-muted-foreground">
                          <LocalTime value={a.at} /> · {a.staffName ?? "System"} ·{" "}
                          <Link href={a.on.type === "loan" ? `/loans/${a.on.id}` : `/mortgages/${a.on.id}`} className="underline-offset-4 hover:underline">
                            {a.on.label}
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              ) : null}
            </Card>
          </div>

          <Card className={cn("self-start", check.doNotLend && "border-danger/50")}>
            <CardHeader>
              <CardTitle>Can we lend?</CardTitle>
              <CardDescription>Add the amount and rate being asked for to compare with how similar loans have gone. For information only; the decision is yours.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <form method="get" className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="lend-amount">Amount</Label>
                  <Input id="lend-amount" name="amount" inputMode="numeric" placeholder="e.g. 20000" defaultValue={amountCents ? String(amountCents / 100) : ""} className="w-32" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lend-rate">Rate %</Label>
                  <Input id="lend-rate" name="rate" inputMode="decimal" placeholder="e.g. 20" defaultValue={rateBp ? String(rateBp / 100) : ""} className="w-20" />
                </div>
                <Button type="submit" variant="outline">
                  Check
                </Button>
              </form>
              <ul className="space-y-2 text-sm">
                {check.flags.map((f, i) => {
                  const s = FLAG_STYLE[f.level];
                  return (
                    <li key={i} className="flex items-start gap-2">
                      <s.icon className={cn("mt-0.5 size-4 shrink-0", s.className)} aria-hidden />
                      <span className={cn("[overflow-wrap:anywhere]", f.level === "danger" && "font-medium")}>{f.text}</span>
                    </li>
                  );
                })}
              </ul>
              {canFlag ? <DoNotLend stateId={stateId} flagged={check.doNotLend !== null} /> : null}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
