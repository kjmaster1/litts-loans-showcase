import { formatCount } from "@/lib/format";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { COMMENT_TAGS } from "@/domain/bank/classify";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { listImportBatches } from "@/server/ledger/queries";
import { UploadForm } from "./upload-form";
import { FinanceTabs } from "@/components/app-shell/section-tabs";

export const metadata: Metadata = { title: "Bank imports" };

export default async function ImportsPage() {
  await requireCapabilityPage("bank.import");
  const batches = await listImportBatches();

  return (
    <>
      <PageHeader
        tabs={<FinanceTabs />}
        title="Bank imports"
        description="Upload the business wallet's export from the in-game bank. Re-uploading overlapping date ranges is safe: rows already imported are skipped."
      />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>New import</CardTitle>
              <CardDescription>You&rsquo;ll see a preview (counts, categories and the reconciled balance) before anything is posted.</CardDescription>
            </CardHeader>
            <CardContent>
              <UploadForm />
            </CardContent>
          </Card>

          <section aria-labelledby="history" className="space-y-2">
            <h2 id="history" className="text-sm font-medium text-muted-foreground">
              Import history
            </h2>
            {batches.length === 0 ? (
              <Empty className="rounded-xl border">
                <EmptyHeader>
                  <EmptyTitle>No imports yet</EmptyTitle>
                  <EmptyDescription>Start with a full-history export so the books reconcile to the bank balance.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="overflow-hidden rounded-xl border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Imported</TableHead>
                      <TableHead>File</TableHead>
                      <TableHead className="hidden md:table-cell">Covers</TableHead>
                      <TableHead className="text-right">New</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Skipped</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">Bank balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batches.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="text-sm">
                          <Link href={`/finance/imports/${b.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                            <LocalTime value={b.createdAt} />
                          </Link>
                          <div className="text-xs text-muted-foreground">by {b.createdBy ?? "system"}</div>
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-sm" title={b.fileName}>
                          {b.fileName}
                        </TableCell>
                        <TableCell className="hidden text-sm md:table-cell">
                          <LocalTime value={b.firstTxAt} format="date" /> – <LocalTime value={b.lastTxAt} format="date" />
                        </TableCell>
                        <TableCell className="num text-right">{formatCount(b.newCount)}</TableCell>
                        <TableCell className="num hidden text-right text-muted-foreground sm:table-cell">
                          {formatCount(b.duplicateCount)}
                        </TableCell>
                        <TableCell className="hidden text-right lg:table-cell">
                          <Money cents={b.reportedBalanceCents} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </div>

        <aside>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Comment tags</CardTitle>
              <CardDescription>
                Manual bank transactions can carry any comment. Start the comment with a tag and it&rsquo;s classified
                automatically on import, e.g. <code className="ident">[REPO] Bison sale</code>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                {Object.entries(COMMENT_TAGS).map(([tag, def]) => (
                  <div key={tag} className="flex gap-3">
                    <dt className="ident w-24 shrink-0 font-medium">[{tag}]</dt>
                    <dd className="text-muted-foreground">{def.description}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </aside>
      </PageBody>
    </>
  );
}
