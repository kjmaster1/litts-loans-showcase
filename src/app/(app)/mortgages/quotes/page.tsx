import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LocalTime } from "@/components/data/local-time";
import { WhoToggle } from "@/components/data/who-toggle";
import { Money } from "@/components/data/money";
import { RowLink, linkedRow } from "@/components/data/row-link";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { QuoteOutlook } from "@/domain/mortgages/allowance-outlook";
import { formatDollars } from "@/lib/format";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { quoteApproval } from "@/domain/mortgages/approval";
import { getAllowanceOutlook } from "@/server/mortgages/allowance-outlook";
import { inputOf, listQuotes, quoteMortgage, type QuoteRow } from "@/server/origination/mortgage-quotes";
import { openNoteCounts } from "@/server/origination/quote-review";
import { isLiveQuote } from "@/domain/origination/quote-status";
import { getSettings } from "@/server/settings";
import { OutlookCard } from "./outlook-card";
import { APPROVAL_STATUS, QUOTE_STATUS, VERDICT } from "./status";

export const metadata: Metadata = { title: "Mortgage quotes" };

const TABS = [
  { key: "draft", label: "Drafts" },
  { key: "confirmed", label: "Confirmed" },
  { key: "approval", label: "Needs approval" },
  { key: "matched", label: "Became a mortgage" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const TAB =
  "inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm whitespace-nowrap transition-colors focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

/** Live quotes in signing order (no signing time last), newest first among those. */
function bySigning(a: QuoteRow, b: QuoteRow): number {
  const at = (q: QuoteRow) => q.signedAt?.getTime() ?? q.expectedSigningAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return at(a) - at(b) || b.createdAt.getTime() - a.createdAt.getTime();
}

export default async function QuotesPage({ searchParams }: PageProps<"/mortgages/quotes">) {
  const viewer = await requireCapabilityPage("loans.originate");
  const sp = await searchParams;
  const mine = sp.who === "mine";
  const now = new Date();
  const [live, settings, outlook] = await Promise.all([listQuotes(viewer, { status: "live" }), getSettings(), getAllowanceOutlook(viewer, now)]);
  // Executive approval (research/18), for the badges and the "Needs approval" tab.
  const approvalOf = (q: QuoteRow) => quoteApproval({ baseCents: quoteMortgage(inputOf(q)).baseCents, approvedAt: q.approvedAt }, settings.mortgages);
  const liveShown = mine ? live.filter((q) => q.officerStaffId === viewer.staffId) : live;
  const counts = {
    draft: liveShown.filter((q) => q.status === "draft").length,
    confirmed: liveShown.filter((q) => q.status === "confirmed").length,
    approval: liveShown.filter((q) => approvalOf(q) === "needed").length,
  };
  // Confirmed quotes are what draw on the allowance, so they lead when there are any (whole team, so links stay put).
  const defaultTab: TabKey = live.some((q) => q.status === "confirmed") ? "confirmed" : "draft";
  const status = sp.status === "open" ? "draft" : sp.status;
  const tab: TabKey = TABS.find((t) => t.key === status)?.key ?? defaultTab;

  const rows =
    tab === "draft" || tab === "confirmed"
      ? liveShown.filter((q) => q.status === tab).sort(bySigning)
      : tab === "approval"
        ? liveShown.filter((q) => approvalOf(q) === "needed").sort(bySigning)
        : await listQuotes(viewer, { mine, ...(tab === "all" ? {} : { status: tab }) });
  const approvals = new Map(rows.map((q) => [q.id, approvalOf(q)]));
  const notes = await openNoteCounts(rows.filter((q) => isLiveQuote(q.status)).map((q) => q.id));
  const atSigning = new Map<string, QuoteOutlook>([...(outlook?.confirmed ?? []), ...(outlook?.drafts ?? [])].map((o) => [o.quoteId, o]));
  const href = (key: string, who: boolean) => {
    const qs = new URLSearchParams({ ...(key === defaultTab ? {} : { status: key }), ...(who ? { who: "mine" } : {}) });
    return `/mortgages/quotes${qs.size ? `?${qs}` : ""}`;
  };

  return (
    <>
      <PageHeader
        title="Mortgage quotes"
        crumbs={[{ label: "Mortgages", href: "/mortgages" }]}
        description="Every officer’s quotes not yet on the tablet. Confirmed quotes draw on the State allowance on their signing day; drafts show what would happen."
        actions={
          <Button render={<Link href="/mortgages/quotes/new" />}>
            <Plus aria-hidden /> New quote
          </Button>
        }
        tabs={
          <nav aria-label="Quotes" className="tab-bar shadow-none">
            {TABS.map((t) => {
              const active = t.key === tab;
              const count = Object.hasOwn(counts, t.key) ? counts[t.key as keyof typeof counts] : null;
              return (
                <Link
                  key={t.key}
                  href={href(t.key, mine)}
                  aria-current={active ? "page" : undefined}
                  className={cn(TAB, active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground")}
                >
                  {t.label}
                  {count !== null ? <span className={cn("num rounded-full px-1.5 text-xs", active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>{count}</span> : null}
                </Link>
              );
            })}
          </nav>
        }
      />
      <PageBody className="space-y-6">
        <OutlookCard outlook={outlook} canSeeFinance={can(viewer.role, "finance.view")} now={now} cushionCents={settings.mortgages.allowanceCushionDollars * 100} drafts={tab === "draft"} />
        <WhoToggle all={href(tab, false)} mine={href(tab, true)} isMine={mine} label="quotes" />
        {rows.length === 0 ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>{tab === "approval" ? "Nothing waiting for approval" : mine ? "None of yours here" : "No quotes here"}</EmptyTitle>
              <EmptyDescription>
                {tab === "approval" ? (
                  "Quotes over the executive-approval line wait here until an executive approves them."
                ) : tab === "confirmed" ? (
                  "A quote is confirmed from its page once the buyer is going ahead and the signing time is known."
                ) : (
                  <>
                    Start one with{" "}
                    <Link href="/mortgages/quotes/new" className="underline underline-offset-4">
                      New quote
                    </Link>
                    .
                  </>
                )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card>
            <CardContent className="px-0">
              <Table id="results" tabIndex={-1} className="focus:outline-none" scrollLabel="Mortgage quotes">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Quote</TableHead>
                    <TableHead>Buyer</TableHead>
                    <TableHead className="text-right">Loan</TableHead>
                    <TableHead>Signing (bids close)</TableHead>
                    <TableHead className="text-right">{tab === "draft" ? "If signed then" : "Allowance at signing"}</TableHead>
                    <TableHead>Officer</TableHead>
                    <TableHead className="pr-6">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((q) => {
                    const f = quoteMortgage(inputOf(q));
                    const isLive = isLiveQuote(q.status);
                    const at = isLive && !q.signedAt ? atSigning.get(q.id) : undefined;
                    const approval = approvals.get(q.id);
                    const noteCount = notes.get(q.id) ?? 0;
                    return (
                      <TableRow key={q.id} className={linkedRow}>
                        <TableCell className="pl-6">
                          <RowLink href={`/mortgages/quotes/${q.id}`}>{q.address}</RowLink>
                          <div className="text-xs text-muted-foreground">
                            #{q.number} · {q.status === "confirmed" && q.confirmedAt ? <>confirmed <LocalTime value={q.confirmedAt} format="relative" /></> : <LocalTime value={q.createdAt} format="relative" />}
                          </div>
                        </TableCell>
                        <TableCell>
                          {q.buyerName}
                          <div className="ident text-xs text-muted-foreground">#{q.buyerStateId}</div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={f.loanCents} />
                        </TableCell>
                        <TableCell>
                          {isLive && q.signedAt ? (
                            <>
                              <LocalTime value={q.signedAt} />
                              <div className="text-xs text-muted-foreground">signed in game</div>
                            </>
                          ) : q.expectedSigningAt ? (
                            <>
                              <LocalTime value={q.expectedSigningAt} />
                              {isLive ? (
                                <div className="text-xs text-muted-foreground">{q.expectedSigningAt.getTime() < now.getTime() ? "passed" : <LocalTime value={q.expectedSigningAt} format="relative" />}</div>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {isLive && q.companyFunded ? (
                            <span className="text-xs text-muted-foreground">Company-funded</span>
                          ) : at ? (
                            <>
                              <Money cents={at.beforeCents} />
                              <div className={cn("text-xs font-medium", VERDICT[at.verdict].text)}>
                                {at.afterCents < 0 ? `short by ${formatDollars(-at.afterCents)}` : `${formatDollars(at.afterCents)} left after`}
                              </div>
                              {at.verdict === "short" && q.status === "draft" ? (
                                <div className="text-xs text-muted-foreground">{at.fitsFrom ? <>fits from <LocalTime value={at.fitsFrom} /></> : "no room within 60 days"}</div>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>{q.officerStaffId === viewer.staffId ? <span className="font-medium">You</span> : q.officerName}</TableCell>
                        <TableCell className="pr-6">
                          <span className="flex flex-wrap gap-1.5">
                            <StatusBadge tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</StatusBadge>
                            {isLive && q.signedAt ? <StatusBadge tone="info">Signed, awaiting tablet</StatusBadge> : null}
                            {at && !q.companyFunded ? <StatusBadge tone={VERDICT[at.verdict].tone}>{VERDICT[at.verdict].label}</StatusBadge> : null}
                            {isLive && approval === "needed" ? <StatusBadge tone={APPROVAL_STATUS.needed.tone}>{APPROVAL_STATUS.needed.label}</StatusBadge> : null}
                            {isLive && approval === "approved" ? <StatusBadge tone={APPROVAL_STATUS.approved.tone}>{APPROVAL_STATUS.approved.label}</StatusBadge> : null}
                            {noteCount ? (
                              <StatusBadge tone="warning">
                                {noteCount} change{noteCount === 1 ? "" : "s"} asked
                              </StatusBadge>
                            ) : null}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}
