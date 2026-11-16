import { dateFormat, formatCents } from "@/lib/format";
import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { getAllowanceView } from "@/server/mortgages/allowance";
import { AddReadingForm, AdoptRuleForm, VoidReadingButton } from "./allowance-forms";
import { FinanceTabs } from "@/components/app-shell/section-tabs";

export const metadata: Metadata = { title: "State allowance" };

function signed(cents: number) {
  return (
    <span className={cn("num whitespace-nowrap", cents > 0 && "text-success", cents < 0 && "text-danger")}>
      {cents > 0 ? "+" : cents < 0 ? "−" : ""}
      <Money cents={Math.abs(cents)} className="text-inherit" />
    </span>
  );
}

export default async function AllowancePage() {
  const viewer = await requireCapabilityPage("finance.view");
  const canRecord = can(viewer.role, "allowance.record");
  const v = await getAllowanceView();
  const live = v.readings.filter((r) => !r.voidedAt);
  const last = live.at(-1);
  const best = v.fit.ranking[0];
  const informative = v.fit.intervals.filter((iv) => iv.events.length > 0);

  return (
    <>
      <PageHeader
        tabs={<FinanceTabs />}
        title="State allowance"
        description="The State's credit limit for Litt's mortgages. It isn't money in the business wallet, so it's tracked here rather than in the ledger."
      />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <StatStrip cols={3}>
            <Kpi label="Last reading" hint={last ? <LocalTime value={last.observedAt} /> : "None yet. Record one from the phone."}>
              {last ? <Money cents={last.balanceCents} /> : "—"}
            </Kpi>
            <Kpi
              label="Expected now"
              hint={
                v.projection
                  ? `${v.projection.source === "adopted" ? "Using the adopted rule" : "Using the best-fitting rule"} · ${v.projection.eventsSince} movement${v.projection.eventsSince === 1 ? "" : "s"} since the last reading`
                  : "Needs a rule (see below)"
              }
            >
              {v.projection ? <Money cents={v.projection.balanceCents} /> : "—"}
            </Kpi>
            <Kpi label="Rule" hint={v.adopted ? `Adopted ${dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(new Date(v.adopted.adoptedAt))}` : v.fit.conclusive ? "Best fit, not adopted yet" : "Not enough readings yet"}>
              <span className="text-base leading-snug font-medium">{(v.adopted?.rule ?? (v.fit.conclusive ? best?.rule : null))?.label ?? "Unknown"}</span>
            </Kpi>
          </StatStrip>

          {v.gaps.mortgagesWithoutTerms > 0 || v.gaps.repaymentsWithoutPrincipal > 0 ? (
            <Alert variant="warning">
              <TriangleAlert aria-hidden />
              <AlertTitle>Some movements can&rsquo;t be counted yet</AlertTitle>
              <AlertDescription>
                <p>
                  {v.gaps.mortgagesWithoutTerms > 0
                    ? `${v.gaps.mortgagesWithoutTerms} mortgage${v.gaps.mortgagesWithoutTerms === 1 ? " has" : "s have"} no loan amount because ${v.gaps.mortgagesWithoutTerms === 1 ? "it hasn't" : "they haven't"} been pasted from the tablet. `
                    : ""}
                  {v.gaps.repaymentsWithoutPrincipal > 0 ? `${v.gaps.repaymentsWithoutPrincipal} repayment${v.gaps.repaymentsWithoutPrincipal === 1 ? "" : "s"} can't be split into principal yet. ` : ""}
                  The comparison below is only as good as these figures.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>How the allowance moves</CardTitle>
              <CardDescription>
                Each candidate rule is tested against the change between consecutive readings, using the mortgages started and payments made in
                between. {informative.length === 0 ? "Record readings before and after a new mortgage or a weekly payment to start the comparison." : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Rule</TableHead>
                    <TableHead className="text-right">Matches</TableHead>
                    <TableHead className="pr-6 text-right">Total difference</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {v.fit.ranking.slice(0, 6).map((s, i) => (
                    <TableRow key={s.rule.id}>
                      <TableCell className="pl-6 whitespace-normal">
                        {s.rule.label}
                        {i === 0 && v.fit.conclusive ? (
                          <StatusBadge tone="success" className="ml-2">
                            Best fit
                          </StatusBadge>
                        ) : null}
                        {v.adopted?.rule.id === s.rule.id ? (
                          <StatusBadge tone="info" className="ml-2">
                            Adopted
                          </StatusBadge>
                        ) : null}
                      </TableCell>
                      <TableCell className="num text-right">
                        {s.exact}/{s.intervals}
                      </TableCell>
                      <TableCell className="pr-6 text-right">{s.intervals ? <Money cents={s.totalErrorCents} /> : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {canRecord ? (
                <div className="border-t px-6 pt-4">
                  <AdoptRuleForm
                    rules={v.rules.map((r) => ({ id: r.id, label: r.label }))}
                    current={v.adopted?.rule.id ?? null}
                    suggested={v.fit.conclusive ? (best?.rule.id ?? null) : null}
                  />
                </div>
              ) : null}
            </CardContent>
          </Card>

          {informative.length ? (
            <Card>
              <CardHeader>
                <CardTitle>Between readings</CardTitle>
                <CardDescription>Observed change against what the leading rule predicts.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Period</TableHead>
                      <TableHead>What happened</TableHead>
                      <TableHead className="text-right">Observed</TableHead>
                      <TableHead className="pr-6 text-right">Predicted</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {informative.map((iv) => (
                      <TableRow key={iv.to.id}>
                        <TableCell className="pl-6 text-sm">
                          <LocalTime value={iv.from.at} /> → <LocalTime value={iv.to.at} />
                        </TableCell>
                        <TableCell className="text-sm whitespace-normal">
                          {iv.events
                            .slice(0, 4)
                            .map((e) => (e.kind === "origination" ? `Started ${e.label}` : e.kind === "repayment" ? `Payment ${e.label}` : `Sanction ${e.label}`))
                            .join(" · ")}
                          {iv.events.length > 4 ? ` · and ${iv.events.length - 4} more` : ""}
                        </TableCell>
                        <TableCell className="text-right">{signed(iv.observedCents)}</TableCell>
                        <TableCell className="pr-6 text-right">{best ? signed(iv.predicted[best.rule.id]) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          {canRecord ? (
            <Card>
              <CardHeader>
                <CardTitle>Record a reading</CardTitle>
              </CardHeader>
              <CardContent>
                <AddReadingForm />
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Readings</CardTitle>
              <CardDescription>
                Newest first. {live.length} counted. A reading entered by mistake can be voided with the <span aria-hidden>⊘</span> button. It stays
                on record and is never deleted.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {v.readings.length === 0 ? (
                <p className="text-sm text-muted-foreground">No readings yet.</p>
              ) : (
                <ul className="divide-y">
                  {[...v.readings].reverse().map((r) => (
                    <li key={r.id} className={cn("flex items-start gap-2 py-2 text-sm", r.voidedAt && "text-muted-foreground")}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn("font-medium", r.voidedAt && "line-through")}>
                            <Money cents={r.balanceCents} />
                          </span>
                          {r.voidedAt ? <StatusBadge tone="neutral">Voided</StatusBadge> : null}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          <LocalTime value={r.observedAt} />
                          {r.by ? ` · ${r.by}` : ""}
                        </div>
                        {r.note ? <div className="text-xs">{r.note}</div> : null}
                        {r.voidedAt ? <div className="text-xs">Void: {r.voidReason}</div> : null}
                      </div>
                      {canRecord && !r.voidedAt ? <VoidReadingButton id={r.id} label={formatCents(r.balanceCents)} /> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
