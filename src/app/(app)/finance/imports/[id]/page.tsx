import { formatCount } from "@/lib/format";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { cashBalanceCents } from "@/server/bank/import";
import { getImportBatch } from "@/server/ledger/queries";

export const metadata: Metadata = { title: "Import" };

export default async function ImportBatchPage({ params }: PageProps<"/finance/imports/[id]">) {
  await requireCapabilityPage("finance.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [batch, cash] = await Promise.all([getImportBatch(id), cashBalanceCents()]);
  if (!batch) notFound();

  return (
    <>
      <PageHeader
        title="Import"
        crumbs={[{ label: "Finance", href: "/finance" }, { label: "Imports", href: "/finance/imports" }]}
        description={
          <>
            {batch.fileName} · imported <LocalTime value={batch.createdAt} /> by {batch.createdBy ?? "system"}
          </>
        }
      />
      <PageBody className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Rows in file</dt>
                <dd className="num">{formatCount(batch.rowCount)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Posted</dt>
                <dd className="num font-medium">{formatCount(batch.newCount)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Already imported</dt>
                <dd className="num">{formatCount(batch.duplicateCount)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Covers</dt>
                <dd className="text-right">
                  <LocalTime value={batch.firstTxAt} format="date" /> – <LocalTime value={batch.lastTxAt} format="date" />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Bank balance on export</dt>
                <dd>
                  <Money cents={batch.reportedBalanceCents} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Ledger cash now</dt>
                <dd>
                  <Money cents={cash} />
                </dd>
              </div>
              <div className="flex justify-between border-t pt-3">
                <dt className="text-muted-foreground">File SHA-256</dt>
                <dd className="ident max-w-36 truncate" title={batch.fileSha256}>
                  {batch.fileSha256}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Posted by category</CardTitle>
            <CardDescription>Click a category to see its transactions.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Category</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="pr-6 text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batch.categories.map((c) => (
                  <TableRow key={c.category}>
                    <TableCell className="pl-6">
                      <Link href={`/finance/transactions?category=${c.category}`} className="text-primary underline-offset-4 hover:underline">
                        {c.label}
                      </Link>
                    </TableCell>
                    <TableCell className="num text-right">{c.count}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <Money cents={c.amountCents} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
