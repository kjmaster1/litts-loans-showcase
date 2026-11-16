import { formatCount } from "@/lib/format";
import { CircleAlert, CircleCheck } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { CONFIDENCE_LEGEND } from "@/components/data/category-badge";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CATEGORIES } from "@/domain/ledger/categories";
import { cn } from "@/lib/utils";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { getImportPreview, ImportError } from "@/server/bank/import";
import { PreviewActions } from "./preview-actions";

export const metadata: Metadata = { title: "Review import" };

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="num mt-1 text-2xl font-semibold">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export default async function PreviewPage({ params }: PageProps<"/finance/imports/preview/[id]">) {
  const viewer = await requireCapabilityPage("bank.import");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();

  let preview;
  try {
    preview = await getImportPreview(viewer, id);
  } catch (error) {
    if (error instanceof ImportError) {
      return (
        <>
          <PageHeader title="Review import" crumbs={[{ label: "Finance", href: "/finance" }, { label: "Imports", href: "/finance/imports" }]} />
          <PageBody>
            <Alert variant="warning">
              <AlertTitle>Preview unavailable</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          </PageBody>
        </>
      );
    }
    throw error;
  }

  // The books start from the account's first transaction, so after this file they must equal the export's balance
  // as at its last row. A difference means rows are missing or counted twice (a renamed customer, 2026-10-13).
  const reconciles = preview.cashAtExportCents === preview.reportedBalanceCents;
  const nothingNew = preview.newRows === 0;

  return (
    <>
      <PageHeader
        title="Review import"
        crumbs={[{ label: "Finance", href: "/finance" }, { label: "Imports", href: "/finance/imports" }]}
        description={
          <>
            <span className="font-medium text-foreground">{preview.fileName}</span> · covers{" "}
            <LocalTime value={preview.firstTxAt} format="date" /> – <LocalTime value={preview.lastTxAt} format="date" /> · export
            times in {preview.timezone}, shown in your local time.
          </>
        }
        actions={<PreviewActions stagingId={preview.stagingId} disabled={nothingNew} />}
      />
      <PageBody className="space-y-6">
        {preview.errors.length > 0 ? (
          <Alert variant="danger">
            <AlertTitle>{preview.errors.length} row(s) couldn&rsquo;t be read and will be skipped</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc pl-4">
                {preview.errors.slice(0, 10).map((e) => (
                  <li key={e.sheetRow}>
                    Row {e.sheetRow}: {e.message}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Rows in file" value={formatCount(preview.totalRows)} />
          <Stat label="New" value={formatCount(preview.newRows)} hint="will be posted" />
          <Stat label="Already imported" value={formatCount(preview.duplicateRows)} hint="skipped" />
          <Stat
            label="Needs review"
            value={preview.byConfidence.unclassified}
            hint={preview.byConfidence.unclassified ? "posted to Suspense, then classify" : "none"}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Reconciliation</CardTitle>
            <CardDescription>
              The books&rsquo; cash at the time of the export&rsquo;s last row, once this file is in, compared with the balance printed on the
              export. They always match unless a transaction is missing or counted twice.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">Ledger cash now</div>
                <Money cents={preview.cashBeforeCents} className="text-lg font-semibold" />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Ledger cash at the export, after import</div>
                <Money cents={preview.cashAtExportCents} className="text-lg font-semibold" />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Bank balance on export</div>
                <Money cents={preview.reportedBalanceCents} className="text-lg font-semibold" />
              </div>
            </div>
            {reconciles ? (
              <div role="status" className="mt-4 flex items-start gap-2 rounded-lg bg-success-subtle p-3 text-sm text-success">
                <CircleCheck className="mt-px size-4 shrink-0" aria-hidden />
                <span>Reconciles exactly. The books will match the bank.</span>
              </div>
            ) : (
              <Alert variant="danger" className="mt-4">
                <CircleAlert aria-hidden />
                <AlertTitle>
                  The books won&rsquo;t match the bank: <Money cents={preview.cashAtExportCents} /> against the export&rsquo;s{" "}
                  <Money cents={preview.reportedBalanceCents} />, <Money cents={Math.abs(preview.cashAtExportCents - preview.reportedBalanceCents)} />{" "}
                  {preview.cashAtExportCents > preview.reportedBalanceCents ? "too much" : "too little"}
                </AlertTitle>
                <AlertDescription>
                  Something in this file is missing from the books or would be counted twice. Check before importing, and tell Management if
                  you can&rsquo;t see why. You can still import.
                </AlertDescription>
              </Alert>
            )}
            {preview.backdated.length > 0 ? (
              <Alert variant="danger" className="mt-4">
                <CircleAlert aria-hidden />
                <AlertTitle>
                  {preview.backdated.length === 1 ? "1 new row is" : `${formatCount(preview.backdated.length)} new rows are`} older than rows already in the
                  books
                </AlertTitle>
                <AlertDescription>
                  <p>A bank export never adds to the past, so these are most likely already in the books with a detail changed.</p>
                  <ul className="mt-1 list-disc pl-4">
                    {preview.backdated.slice(0, 10).map((r) => (
                      <li key={r.sheetRow}>
                        <LocalTime value={r.occurredAt} /> · <Money cents={r.amountCents} direction={r.direction} /> · {r.initiatorName ?? "—"} ·{" "}
                        {r.comment || "no comment"}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <Card>
            <CardHeader>
              <CardTitle>What will be posted</CardTitle>
              <CardDescription>New rows by category. You can reclassify any row after import.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {preview.byCategory.length === 0 ? (
                <p className="px-6 text-sm text-muted-foreground">
                  Every row in this file has already been imported, so nothing will change.
                </p>
              ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Category</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="pr-6 text-right">Out</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.byCategory.map((c) => (
                    <TableRow key={c.category}>
                      <TableCell className={cn("pl-6", c.category === "unclassified" && "font-medium text-danger")}>
                        {CATEGORIES[c.category].label}
                      </TableCell>
                      <TableCell className="num text-right">{c.count}</TableCell>
                      <TableCell className="text-right">{c.inCents ? <Money cents={c.inCents} /> : "—"}</TableCell>
                      <TableCell className="pr-6 text-right">{c.outCents ? <Money cents={c.outCents} /> : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>How rows were classified</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm">
                {(["certain", "tag", "heuristic", "unclassified"] as const).map((k) => {
                  const L = CONFIDENCE_LEGEND[k];
                  return (
                    <li key={k} className="flex items-start gap-2">
                      <L.icon className={cn("mt-0.5 size-4 shrink-0", L.className)} aria-hidden />
                      <span className="flex-1">{L.label}</span>
                      <span className="num font-medium">{preview.byConfidence[k]}</span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </div>

        {preview.review.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Needs review after import ({preview.review.length})</CardTitle>
              <CardDescription>No rule matched these comments. They&rsquo;ll be posted to Suspense so cash still reconciles; classify them from Transactions → Needs review.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableBody>
                  {preview.review.map((r) => (
                    <TableRow key={r.sheetRow}>
                      <TableCell className="pl-6 text-sm">
                        <LocalTime value={r.occurredAt} />
                      </TableCell>
                      <TableCell className="max-w-md text-sm whitespace-normal">{r.comment}</TableCell>
                      <TableCell className="pr-6 text-right">
                        <Money cents={r.amountCents} direction={r.direction} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}

        <p className="text-xs text-muted-foreground">
          This preview expires <LocalTime value={preview.expiresAt} format="relative" />.
        </p>
      </PageBody>
    </>
  );
}
