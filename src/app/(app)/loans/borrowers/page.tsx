import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { DataAsOf } from "@/components/data/data-as-of";
import { ExportButton, exportHref } from "@/components/data/export-button";
import { Kpi, StatStrip } from "@/components/data/kpi";
import { ListSearch } from "@/components/data/list-search";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { RowLink, linkedRow } from "@/components/data/row-link";
import { SortHeader } from "@/components/data/sort-header";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { filterDirectory, sortDirectory, type DirectorySort } from "@/domain/borrowers/directory";
import { STANDING_LABEL } from "@/domain/borrowers/standing-labels";
import { cleanSearch } from "@/lib/search";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { listBorrowerDirectory } from "@/server/borrowers";
import { dataFreshness } from "@/server/freshness";

export const metadata: Metadata = { title: "Borrowers" };

const SORTS = ["standing", "owed", "name", "recent"] as const;
const PAGE = 100;

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Everyone who has borrowed (owner, 2026-10-11); each row opens the borrower's profile. */
export default async function BorrowersPage({ searchParams }: PageProps<"/loans/borrowers">) {
  await requireCapabilityPage("borrower.lookup");
  const sp = await searchParams;
  // Old lending-check links (?stateId=…&amount=…&rate=…) still go straight to the profile.
  const stateIdParam = one(sp.stateId);
  if (stateIdParam && /^\d{1,7}$/.test(stateIdParam)) {
    const keep = new URLSearchParams();
    for (const k of ["amount", "rate"]) {
      const v = one(sp[k]);
      if (v) keep.set(k, v.slice(0, 20));
    }
    redirect(`/loans/borrowers/${Number(stateIdParam)}${keep.size ? `?${keep}` : ""}`);
  }
  const q = cleanSearch(one(sp.q), 60);
  const sort: DirectorySort = SORTS.find((s) => s === one(sp.sort)) ?? "standing";
  const [all, freshness] = await Promise.all([listBorrowerDirectory(), dataFreshness()]);
  const rows = sortDirectory(filterDirectory(all, q), sort);
  const shown = rows.slice(0, PAGE);
  const exactId = /^\d{1,7}$/.test(q) ? Number(q) : null;
  const known = exactId !== null && all.some((r) => r.stateId === exactId);

  const owing = all.filter((r) => r.owedCents > 0);
  const sortHref = (s: DirectorySort) => `/loans/borrowers?${new URLSearchParams({ ...(q ? { q } : {}), ...(s === "standing" ? {} : { sort: s }) })}`;

  return (
    <>
      <PageHeader
        title="Borrowers"
        description="Everyone who has borrowed from Litt’s. Open someone to see their loans, mortgages and collections, and whether to lend to them again."
        actions={<ExportButton href={exportHref("/loans/borrowers/export", { q: q || undefined, sort: sort === "standing" ? undefined : sort })} />}
      />
      <PageBody className="space-y-6">
        <StatStrip cols={4}>
          <Kpi label="Borrowers">{all.length}</Kpi>
          <Kpi label="Owe Litt’s money" hint={<Money cents={owing.reduce((s, r) => s + r.owedCents, 0)} />}>
            {owing.length}
          </Kpi>
          <Kpi label="Defaulted" tone={all.some((r) => r.standing === "defaulted") ? "bad" : undefined} hint="a loan in default now">
            {all.filter((r) => r.standing === "defaulted").length}
          </Kpi>
          <Kpi label="Do not lend" hint="flagged by management">
            {all.filter((r) => r.standing === "do_not_lend").length}
          </Kpi>
        </StatStrip>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <ListSearch q={q} label="Search borrowers" placeholder="Name or State ID" />
        </div>

        {exactId !== null && !known ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>State ID {exactId} hasn&rsquo;t borrowed from Litt&rsquo;s</EmptyTitle>
              <EmptyDescription>Check them before lending: the lending check works for new borrowers too.</EmptyDescription>
            </EmptyHeader>
            <Button render={<Link href={`/loans/borrowers/${exactId}`} />}>Check State ID {exactId}</Button>
          </Empty>
        ) : rows.length === 0 ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>No one found</EmptyTitle>
              <EmptyDescription>Nobody called &ldquo;{q}&rdquo; has borrowed from Litt&rsquo;s. Search by State ID to check someone new.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card>
            <CardContent className="px-0">
              <Table id="results" tabIndex={-1} className="focus:outline-none" scrollLabel="Borrowers">
                <TableHeader>
                  <TableRow>
                    <SortHeader label="Borrower" active={sort === "name"} dir="asc" href={sortHref("name")} className="pl-6" />
                    <SortHeader label="Standing" active={sort === "standing"} dir="asc" href={sortHref("standing")} />
                    <TableHead className="hidden text-right md:table-cell">Loans</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Mortgages</TableHead>
                    <SortHeader label="Owed" align="right" active={sort === "owed"} dir="desc" href={sortHref("owed")} />
                    <TableHead className="hidden text-right lg:table-cell">Repaid</TableHead>
                    <SortHeader label="Last activity" active={sort === "recent"} dir="desc" href={sortHref("recent")} className="hidden pr-6 sm:table-cell" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((r) => {
                    const st = STANDING_LABEL[r.standing];
                    return (
                      <TableRow key={r.stateId} className={linkedRow}>
                        <TableCell className="pl-6">
                          <RowLink href={`/loans/borrowers/${r.stateId}`}>{r.name ?? "Unknown"}</RowLink>
                          <div className="ident text-xs text-muted-foreground">#{r.stateId}</div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                        </TableCell>
                        <TableCell className="num hidden text-right md:table-cell">
                          {r.loans ? (
                            <>
                              {r.openLoans}
                              <span className="text-muted-foreground"> open of {r.loans}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="num hidden text-right lg:table-cell">
                          {r.mortgages ? (
                            <>
                              {r.openMortgages}
                              <span className="text-muted-foreground"> open of {r.mortgages}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{r.owedCents ? <Money cents={r.owedCents} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="num hidden text-right lg:table-cell">
                          {r.repaid}
                          {r.wentBad ? <span className="text-danger"> · {r.wentBad} bad</span> : null}
                        </TableCell>
                        <TableCell className="hidden pr-6 sm:table-cell">
                          <LocalTime value={r.lastActivityAt} format="date" />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
        <p className="text-caption">
          {rows.length > PAGE ? `First ${PAGE} of ${rows.length} borrowers. Search to narrow it down.` : `${rows.length} borrower${rows.length === 1 ? "" : "s"}`}
          {q ? ` matching “${q}”` : ""}. Owed counts loans still running or in default; written-off balances aren&rsquo;t included.
        </p>
        <DataAsOf freshness={freshness} sources={["cards", "bank"]} />
      </PageBody>
    </>
  );
}
