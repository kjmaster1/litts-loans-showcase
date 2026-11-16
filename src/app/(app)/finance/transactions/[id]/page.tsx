import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { CategoryBadge, CONFIDENCE_LEGEND, type ConfidenceLevel } from "@/components/data/category-badge";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { StatusBadge } from "@/components/data/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { classify } from "@/domain/bank/classify";
import { CATEGORIES, selectableCategories, type Category } from "@/domain/ledger/categories";
import { can } from "@/lib/permissions";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { getBankTransaction, trialBalance } from "@/server/ledger/queries";
import { ReclassifyForm } from "./reclassify-form";

export const metadata: Metadata = { title: "Transaction" };

const KIND_LABEL: Record<string, string> = {
  bank_posting: "Posting",
  reversal: "Reversal",
  mortgage_settlement: "Mortgage settlement",
  adjustment: "Adjustment",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-2 gap-y-0.5 py-1.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default async function TransactionPage({ params }: PageProps<"/finance/transactions/[id]">) {
  const viewer = await requireCapabilityPage("finance.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [data, accounts] = await Promise.all([getBankTransaction(id), trialBalance()]);
  if (!data) notFound();
  const { tx, entries, classifiedBy } = data;
  const accountName = new Map(accounts.map((a) => [a.code, a.name]));
  const category = tx.category as Category;
  const reclassifiable = CATEGORIES[category].selectable || category === "unclassified";
  const canReclassify = can(viewer.role, "bank.reclassify") && reclassifiable;
  const rule = classify(tx).rule;
  const confidence = tx.confidence as ConfidenceLevel;

  return (
    <>
      <PageHeader
        title={tx.comment.trim() || "Transaction"}
        crumbs={[{ label: "Finance", href: "/finance" }, { label: "Transactions", href: "/finance/transactions" }]}
      />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>
                <Money cents={tx.amountCents} direction={tx.direction} className="text-2xl" />
              </CardTitle>
              <CardDescription>
                <LocalTime value={tx.occurredAt} /> · <span className="capitalize">{tx.txType}</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <Fact label="Comment">{tx.comment || <span className="text-muted-foreground">—</span>}</Fact>
                <Fact label="Tax withheld">
                  {tx.taxCents ? (
                    <>
                      <Money cents={tx.taxCents} />
                      {tx.taxPercent ? <span className="text-muted-foreground"> ({tx.taxPercent}%)</span> : null}
                    </>
                  ) : (
                    "None"
                  )}
                </Fact>
                <Fact label="Initiated by">
                  {tx.initiatorName ?? "—"}
                  {tx.initiatorStateId ? <span className="ident text-muted-foreground"> #{tx.initiatorStateId}</span> : null}
                </Fact>
                <Fact label="From wallet">
                  <span className="ident">{tx.sourceWallet ?? "None (cash)"}</span>
                </Fact>
                <Fact label="To wallet">
                  <span className="ident">{tx.targetWallet ?? "—"}</span>
                </Fact>
                <Fact label="Import">
                  <Link href={`/finance/imports/${tx.batchId}`} className="text-primary underline-offset-4 hover:underline">
                    View batch
                  </Link>
                </Fact>
                <Fact label="Fingerprint">
                  <span className="ident text-muted-foreground" title={tx.fingerprint}>
                    {tx.fingerprint.slice(0, 16)}… #{tx.occurrence}
                  </span>
                </Fact>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Journal</CardTitle>
              <CardDescription>Double-entry postings for this transaction, oldest first. Entries are never edited; corrections are posted as reversals.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {entries.map((e) => (
                <section key={e.id} aria-label={KIND_LABEL[e.kind]}>
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                    <StatusBadge tone={e.kind === "reversal" ? "warning" : "neutral"}>{KIND_LABEL[e.kind]}</StatusBadge>
                    <span className="text-muted-foreground">
                      recorded <LocalTime value={e.recordedAt} />
                      {e.createdBy ? ` by ${e.createdBy}` : ""}
                    </span>
                    {e.reason ? <span className="w-full text-muted-foreground">&ldquo;{e.reason}&rdquo;</span> : null}
                  </div>
                  <div className="overflow-hidden rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Account</TableHead>
                          <TableHead className="text-right">Debit</TableHead>
                          <TableHead className="text-right">Credit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {e.lines.map((l) => (
                          <TableRow key={l.id}>
                            <TableCell>
                              <Link href={`/finance/ledger/${l.accountCode}`} className="underline-offset-4 hover:underline">
                                <span className="ident text-muted-foreground">{l.accountCode}</span> {accountName.get(l.accountCode)}
                              </Link>
                              {l.memo ? <div className="text-xs text-muted-foreground">{l.memo}</div> : null}
                            </TableCell>
                            <TableCell className="text-right">{l.debitCents ? <Money cents={l.debitCents} /> : ""}</TableCell>
                            <TableCell className="text-right">{l.creditCents ? <Money cents={l.creditCents} /> : ""}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              ))}
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Classification</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <CategoryBadge category={tx.category} confidence={confidence} className="text-base" />
              <p className="text-muted-foreground">{CONFIDENCE_LEGEND[confidence].label}.</p>
              {confidence === "manual" ? (
                <p>Set by {classifiedBy ?? "a staff member"}.</p>
              ) : (
                <p className="text-muted-foreground">
                  Rule: <code className="ident">{rule}</code>
                </p>
              )}
            </CardContent>
          </Card>
          {canReclassify ? (
            <Card>
              <CardHeader>
                <CardTitle>Reclassify</CardTitle>
                <CardDescription>Reverses the current posting and posts again under the new category, on the original date.</CardDescription>
              </CardHeader>
              <CardContent>
                <ReclassifyForm
                  transactionId={tx.id}
                  current={tx.category}
                  options={selectableCategories(tx.direction).map((c) => ({ value: c, label: CATEGORIES[c].label, group: CATEGORIES[c].group }))}
                />
              </CardContent>
            </Card>
          ) : !reclassifiable ? (
            <p className="text-sm text-muted-foreground">
              Game-generated mortgage and tax records are classified with certainty and can&rsquo;t be changed.
            </p>
          ) : null}
        </aside>
      </PageBody>
    </>
  );
}
