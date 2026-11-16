import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { LocalTime } from "@/components/data/local-time";
import { WhoToggle } from "@/components/data/who-toggle";
import { Money } from "@/components/data/money";
import { RowLink, linkedRow } from "@/components/data/row-link";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LOAN_KIND_LABEL } from "@/domain/origination/loan-offer";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { listOffers } from "@/server/origination/loan-offers";
import { OFFER_STATUS } from "./status";

export const metadata: Metadata = { title: "Loan offers" };

const TABS = [
  { key: "open", label: "Open" },
  { key: "funded", label: "Paid out" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
] as const;
const TAB =
  "inline-flex h-9 shrink-0 items-center border-b-2 px-2.5 text-sm whitespace-nowrap transition-colors focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

export default async function OffersPage({ searchParams }: PageProps<"/loans/offers">) {
  const viewer = await requireCapabilityPage("loans.originate");
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.status)?.key ?? "open";
  const mine = sp.who === "mine";
  const [rows, open] = await Promise.all([listOffers(viewer, { ...(tab === "all" ? {} : { status: tab }), mine }), listOffers(viewer, { status: "open" })]);
  const href = (status: string, who: boolean) => {
    const qs = new URLSearchParams({ ...(status === "open" ? {} : { status }), ...(who ? { who: "mine" } : {}) });
    return `/loans/offers${qs.size ? `?${qs}` : ""}`;
  };
  const issued = open.filter((o) => o.status === "issued");

  return (
    <>
      <PageHeader
        title="Loan offers"
        crumbs={[{ label: "Loans", href: "/loans" }]}
        description="Every officer’s loan offers and contracts. Only an offer’s officer or management can change it."
        actions={
          <Button render={<Link href="/loans/new" />}>
            <Plus aria-hidden /> New loan
          </Button>
        }
        tabs={
          <nav aria-label="Offers" className="tab-bar shadow-none">
            {TABS.map((t) => (
              <Link key={t.key} href={href(t.key, mine)} aria-current={t.key === tab ? "page" : undefined} className={cn(TAB, t.key === tab ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground")}>
                {t.label}
              </Link>
            ))}
          </nav>
        }
      />
      <PageBody className="space-y-6">
        <StatStrip cols={3}>
          <Kpi label="Open offers" hint={`${open.length - issued.length} draft${open.length - issued.length === 1 ? "" : "s"}, ${issued.length} contract${issued.length === 1 ? "" : "s"} issued`}>
            {open.length}
          </Kpi>
          <Kpi label="Contracts waiting to be paid out" hint="issued, not yet paid out in the game">
            <Money cents={issued.reduce((s, o) => s + o.amountCents, 0)} />
          </Kpi>
          <Kpi label="All open offers" hint="if every draft and contract goes ahead">
            <Money cents={open.reduce((s, o) => s + o.amountCents, 0)} />
          </Kpi>
        </StatStrip>
        <WhoToggle all={href(tab, false)} mine={href(tab, true)} isMine={mine} label="offers" />
        {rows.length === 0 ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>{mine ? "None of yours here" : "No offers here"}</EmptyTitle>
              <EmptyDescription>
                Start one with <Link href="/loans/new" className="underline underline-offset-4">New loan</Link>.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card>
            <CardContent className="px-0">
              <Table id="results" tabIndex={-1} className="focus:outline-none" scrollLabel="Loan offers">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Offer</TableHead>
                    <TableHead>Borrower</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Rate</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Weeks</TableHead>
                    <TableHead>Officer</TableHead>
                    <TableHead className="pr-6">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((o) => (
                    <TableRow key={o.id} className={linkedRow}>
                      <TableCell className="pl-6">
                        <RowLink href={`/loans/offers/${o.id}`}>#{o.number}</RowLink>
                        <div className="text-xs text-muted-foreground">
                          {LOAN_KIND_LABEL[o.kind]} · <LocalTime value={o.createdAt} format="relative" />
                        </div>
                      </TableCell>
                      <TableCell>
                        {o.borrowerName}
                        <div className="ident text-xs text-muted-foreground">#{o.borrowerStateId}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Money cents={o.amountCents} />
                      </TableCell>
                      <TableCell className="num hidden text-right sm:table-cell">{o.rateBp / 100}%</TableCell>
                      <TableCell className="num hidden text-right md:table-cell">{o.weeks}</TableCell>
                      <TableCell>{o.officerStaffId === viewer.staffId ? <span className="font-medium">You</span> : o.officerName}</TableCell>
                      <TableCell className="pr-6">
                        <StatusBadge tone={OFFER_STATUS[o.status].tone}>{OFFER_STATUS[o.status].label}</StatusBadge>
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
