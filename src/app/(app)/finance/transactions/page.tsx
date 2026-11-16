import { formatCount } from "@/lib/format";
import { cleanSearch } from "@/lib/search";
import type { Metadata } from "next";
import Link from "next/link";
import { ViewTabs } from "@/components/data/view-tabs";
import { DataAsOf } from "@/components/data/data-as-of";
import { ExportButton, exportHref } from "@/components/data/export-button";
import { dataFreshness } from "@/server/freshness";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { CategoryBadge, type ConfidenceLevel } from "@/components/data/category-badge";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CATEGORIES, isCategory } from "@/domain/ledger/categories";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { listBankTransactions, reviewCount } from "@/server/ledger/queries";
import { TransactionFilters } from "./transaction-filters";
import { FinanceTabs } from "@/components/app-shell/section-tabs";
import { RowLink, linkedRow } from "@/components/data/row-link";

export const metadata: Metadata = { title: "Transactions" };

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function TransactionsPage({ searchParams }: PageProps<"/finance/transactions">) {
  await requireCapabilityPage("finance.view");
  const sp = await searchParams;
  const q = cleanSearch(one(sp.q)) || undefined;
  const categoryParam = one(sp.category);
  const category = categoryParam && isCategory(categoryParam) ? categoryParam : undefined;
  const direction = one(sp.direction) === "in" ? "in" : one(sp.direction) === "out" ? "out" : undefined;
  const review = one(sp.view) === "review";
  const page = Math.max(1, Number(one(sp.page)) || 1);

  const [result, toReview, freshness] = await Promise.all([listBankTransactions({ q, category, direction, review, page }), reviewCount(), dataFreshness()]);

  const href = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { q, category, direction, view: review ? "review" : undefined, page: String(page), ...patch };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "page" && v === "1")) params.set(k, v);
    const s = params.toString();
    return `/finance/transactions${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <PageHeader
        tabs={<FinanceTabs />}
        title="Transactions"
        description="Every row imported from the bank, with how it was posted. Times are shown in your timezone."
        actions={<ExportButton href={exportHref("/finance/transactions/export", { q, category, direction, view: review ? "review" : undefined })} />}
      />
      <PageBody className="space-y-4">
        <ViewTabs
          label="Views"
          current={review ? "review" : "all"}
          tabs={[
            { key: "all", label: "All", href: href({ view: undefined, page: undefined }) },
            { key: "review", label: "Needs review", count: toReview, tone: "attention", href: href({ view: "review", page: undefined, category: undefined }) },
          ]}
        />

        {!review ? <TransactionFilters q={q} category={category} direction={direction} /> : null}

        {result.rows.length === 0 ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>{review ? "Nothing needs review" : "No transactions"}</EmptyTitle>
              <EmptyDescription>
                {review ? "Every imported row has a category." : q || category || direction ? "Try a different filter." : "No bank export has been imported yet."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table id="results" tabIndex={-1} className="focus:outline-none">
              <TableHeader>
                <TableRow>
                  <TableHead className="hidden w-40 sm:table-cell">When</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="hidden lg:table-cell">Category</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((t) => (
                  <TableRow key={t.id} className={linkedRow}>
                    <TableCell className="hidden align-top text-sm sm:table-cell">
                      <LocalTime value={t.occurredAt} />
                    </TableCell>
                    <TableCell className="max-w-xl align-top whitespace-normal">
                      <RowLink href={`/finance/transactions/${t.id}`}>
                        {t.comment.trim() || <span className="text-muted-foreground italic">No comment</span>}
                      </RowLink>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        <span className="sm:hidden">
                          <LocalTime value={t.occurredAt} />
                          {" · "}
                        </span>
                        <span className="capitalize">{t.txType}</span>
                        {t.initiatorName ? (
                          <>
                            {" · "}
                            {t.initiatorName}
                            {t.initiatorStateId ? <span className="ident"> #{t.initiatorStateId}</span> : null}
                          </>
                        ) : null}
                        <span className="lg:hidden">
                          {" · "}
                          {CATEGORIES[t.category as keyof typeof CATEGORIES]?.label}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden align-top lg:table-cell">
                      <CategoryBadge category={t.category} confidence={t.confidence as ConfidenceLevel} />
                    </TableCell>
                    <TableCell className="text-right align-top">
                      <Money cents={t.amountCents} direction={t.direction} className="font-medium" />
                      {t.taxCents > 0 ? (
                        <div className="text-xs text-muted-foreground">
                          tax <Money cents={t.taxCents} />
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {result.pageCount > 1 ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page <span className="num">{result.page}</span> of <span className="num">{result.pageCount}</span> ·{" "}
              <span className="num">{formatCount(result.total)}</span> transactions
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={result.page <= 1} render={<Link href={href({ page: String(result.page - 1) })} />}>
                Newer
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={result.page >= result.pageCount}
                render={<Link href={href({ page: String(result.page + 1) })} />}
              >
                Older
              </Button>
            </div>
          </div>
        ) : null}
        <DataAsOf freshness={freshness} sources={["bank"]} />
      </PageBody>
    </>
  );
}
