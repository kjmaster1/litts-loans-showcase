import { formatDollars } from "@/lib/format";
import { ArrowRight, CircleCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { AreaChart, StackedBarChart } from "@/components/data/charts";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dayMonth } from "@/domain/commissions/week";
import { auditLabel } from "@/lib/audit-labels";
import { can } from "@/lib/permissions";
import { ROLE_LABEL } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { listMySessions } from "@/server/account/sessions";
import { listAuditEvents } from "@/server/audit/queries";
import { requireViewer } from "@/server/authz/viewer";
import { dashboard } from "@/server/dashboard";
import { cashFlowForecast } from "@/server/forecast";
import { cashHistory } from "@/server/ledger/queries";
import { expectedLosses } from "@/server/risk";
import { dataFreshness } from "@/server/freshness";
import { DataAsOf } from "@/components/data/data-as-of";
import { staffCounts } from "@/server/staff/service";

export const metadata: Metadata = { title: "Dashboard" };

const TODO_DOT = { danger: "bg-danger", warning: "bg-warning", info: "bg-info" } as const;
const money = formatDollars;

/**
 * Dashboard (redesign 2026-10): what needs attention first, then the headline
 * figures and two trends; team and security matter less day to day.
 */
export default async function DashboardPage() {
  const viewer = await requireViewer();
  // Loan officers start on their own page (owner, 2026-10-11).
  if (!can(viewer.role, "dashboard.company")) redirect("/my-work");
  const showTeam = can(viewer.role, "staff.view");
  const showAudit = can(viewer.role, "audit.view");
  const finance = can(viewer.role, "finance.view");

  const [counts, activity, sessions, overview, forecast, cash, losses, freshness] = await Promise.all([
    showTeam ? staffCounts() : Promise.resolve(null),
    showAudit ? listAuditEvents(viewer, { pageSize: 8, hideRoutine: true }) : Promise.resolve(null),
    listMySessions(viewer),
    dashboard(viewer),
    finance ? cashFlowForecast() : Promise.resolve(null),
    finance ? cashHistory(90) : Promise.resolve(null),
    finance ? expectedLosses() : Promise.resolve(null),
    dataFreshness(),
  ]);
  const headlines = [
    ...overview.headlines,
    ...(overview.expected ? [{ label: "Expected to receive", cents: overview.expected.totalCents, hint: "From running loans and mortgages", href: "/finance#forecast" }] : []),
  ].slice(0, 4);

  const weeks = forecast ? [forecast.overdue.totalCents ? { ...forecast.overdue, label: "Late" } : null, ...forecast.weeks.map((w) => ({ ...w, label: dayMonth(w.from) }))].filter((w) => w !== null) : [];
  const nextWeek = forecast?.weeks[1];
  const cashNow = cash?.[cash.length - 1]?.cents ?? 0;
  const cashThen = cash?.[0]?.cents ?? 0;

  return (
    <>
      <PageHeader title="Dashboard" description={`Company figures and work waiting. Signed in as ${ROLE_LABEL[viewer.role]}.`} />
      <PageBody className="space-y-6">
        <StatStrip cols={headlines.length as 3 | 4}>
          {headlines.map((h) => (
            <Kpi key={h.label} label={h.label} hint={h.hint} href={h.href}>
              {h.cents !== undefined ? <Money cents={h.cents} /> : <span className="num">{h.count}</span>}
            </Kpi>
          ))}
        </StatStrip>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Needs attention</CardTitle>
              <CardDescription>{overview.todos.length ? `${overview.todos.length} thing${overview.todos.length === 1 ? "" : "s"} waiting for someone.` : "All clear."}</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {overview.todos.length ? (
                <ul className="divide-y border-t">
                  {overview.todos.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={t.href}
                        className="group flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                      >
                        <span className={cn("size-2 shrink-0 rounded-full", TODO_DOT[t.tone])} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{t.label}</span>
                          <span className="text-muted-foreground"> · {t.detail}</span>
                        </span>
                        <span className="sr-only">{t.tone === "danger" ? "(urgent)" : t.tone === "warning" ? "(soon)" : ""}</span>
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
                  <CircleCheck className="size-4 text-success" aria-hidden /> Nothing needs anyone right now.
                </p>
              )}
            </CardContent>
          </Card>

          {overview.expected ? (
            <Card>
              <CardHeader>
                <CardTitle>Expected to receive</CardTitle>
                <CardDescription>From loans and mortgages already running, if paid as agreed.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="num text-2xl font-semibold tracking-tight">
                  <Money cents={overview.expected.totalCents} />
                </p>
                <dl className="divide-y text-sm">
                  {overview.expected.lines.map((l) => (
                    <div key={l.label} className="flex items-baseline justify-between gap-3 py-1.5">
                      <dt>
                        <Link href={l.href} className="underline-offset-4 hover:underline">
                          {l.label}
                        </Link>
                      </dt>
                      <dd className="num">
                        <Money cents={l.cents} />
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="text-xs text-muted-foreground">
                  Before tax withheld at source (about 3% of most repayments). Defaulted loans, if recovered in full, would add <Money cents={overview.expected.defaultedCents} />.
                </p>
                {losses ? (
                  <dl className="divide-y border-t text-sm">
                    <div className="flex items-baseline justify-between gap-3 py-1.5">
                      <dt>
                        <Link href="/finance/reports?report=health" className="underline-offset-4 hover:underline">
                          Expected losses
                        </Link>
                      </dt>
                      <dd className="num text-danger">
                        <Money cents={-losses.expectedCents} />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 py-1.5">
                      <dt>Realistic book value</dt>
                      <dd className="num font-medium">
                        <Money cents={losses.realisticCents} />
                      </dd>
                    </div>
                  </dl>
                ) : null}
                {losses ? (
                  <p className="text-xs text-muted-foreground">
                    Book value is what&rsquo;s owed to Litt&rsquo;s (<Money cents={losses.owedCents} />, defaulted included) less the share past loans like these have lost. An estimate, not booked.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : (
            <SecurityCard sessions={sessions.length} startedAt={sessions.find((s) => s.current)?.createdAt ?? null} />
          )}
        </div>

        {forecast && cash ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Money in, next 8 weeks</CardTitle>
                <CardDescription>
                  {nextWeek ? (
                    <>
                      Next week <Money cents={nextWeek.totalCents} /> is due from running loans and mortgages.
                    </>
                  ) : null}
                </CardDescription>
                <CardAction>
                  <Button variant="ghost" size="sm" render={<Link href="/finance#forecast" />}>
                    Forecast <ArrowRight />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <StackedBarChart
                  data={weeks.map((w, i) => ({ label: w.label, values: [w.loansCents, w.mortgagesCents], highlight: i === (forecast.overdue.totalCents ? 1 : 0) }))}
                  series={[
                    { name: "Loans", className: "fill-chart-1" },
                    { name: "Mortgages", className: "fill-chart-2" },
                  ]}
                  summary={`Money expected each week for the next 8 weeks. ${weeks.map((w) => `${w.label}: ${money(w.totalCents)}`).join("; ")}.`}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Cash, last 90 days</CardTitle>
                <CardDescription>
                  Business wallet per the books: <Money cents={cashNow} /> now, {cashNow >= cashThen ? "up" : "down"} <Money cents={Math.abs(cashNow - cashThen)} /> over the period.
                </CardDescription>
                <CardAction>
                  <Button variant="ghost" size="sm" render={<Link href="/finance/ledger/1000" />}>
                    Ledger <ArrowRight />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <AreaChart
                  points={cash.map((c) => ({ label: dayMonth(new Date(`${c.day}T12:00:00Z`)), value: c.cents }))}
                  summary={`Cash in the business wallet over the last 90 days: ${money(cashThen)} then, ${money(cashNow)} now.`}
                />
              </CardContent>
            </Card>
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-3">
          {activity ? (
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Recent activity</CardTitle>
                <CardDescription>What people changed, newest first. Sign-ins are in the audit log.</CardDescription>
                <CardAction>
                  <Button variant="ghost" size="sm" render={<Link href="/audit" />}>
                    Audit log <ArrowRight />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="px-0">
                <ul className="divide-y border-t">
                  {activity.rows.map((r) => {
                    const { label, tone } = auditLabel(r.action);
                    return (
                      <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                        <StatusBadge tone={tone}>{label}</StatusBadge>
                        <span className="min-w-0">
                          {r.actorName ?? <span className="text-muted-foreground capitalize">{r.actorType}</span>}
                          {r.targetLabel && r.targetLabel !== r.actorName ? (
                            <span className="text-muted-foreground">
                              {" → "}
                              {r.targetHref ? (
                                <Link href={r.targetHref} className="underline-offset-4 hover:text-foreground hover:underline">
                                  {r.targetLabel}
                                </Link>
                              ) : (
                                r.targetLabel
                              )}
                            </span>
                          ) : null}
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          <LocalTime value={r.occurredAt} format="relative" />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          <div className="space-y-6">
            {counts ? (
              <Card size="sm">
                <CardHeader>
                  <CardTitle>Team</CardTitle>
                  <CardAction>
                    <Button variant="ghost" size="sm" render={<Link href="/staff" />}>
                      Staff <ArrowRight />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-3 gap-3">
                    {(
                      [
                        ["Active", counts.active ?? 0],
                        ["Invited", counts.invited ?? 0],
                        ["Suspended", counts.suspended ?? 0],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="num text-lg font-semibold">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            ) : null}
            {overview.expected ? <SecurityCard sessions={sessions.length} startedAt={sessions.find((s) => s.current)?.createdAt ?? null} /> : null}
          </div>
        </div>
        <DataAsOf freshness={freshness} sources={["bank", "cards", "tablet"]} />
      </PageBody>
    </>
  );
}

function SecurityCard({ sessions, startedAt }: { sessions: number; startedAt: Date | null }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Your security</CardTitle>
        <CardAction>
          <Button variant="ghost" size="sm" render={<Link href="/account/security" />}>
            Review <ArrowRight />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-0.5 text-sm">
        <p className="flex items-center gap-1.5">
          <CircleCheck className="size-4 text-success" aria-hidden /> Two-factor authentication is on
        </p>
        <p className="text-muted-foreground">
          {sessions} active session{sessions === 1 ? "" : "s"} · this one started <LocalTime value={startedAt} format="relative" />
        </p>
      </CardContent>
    </Card>
  );
}
