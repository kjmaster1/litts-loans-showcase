import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LocalTime } from "@/components/data/local-time";
import { Money } from "@/components/data/money";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { accountActivity, accountByCode, decodeCursor, encodeCursor, naturalBalance, trialBalance } from "@/server/ledger/queries";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({ params, searchParams }: PageProps<"/finance/ledger/[code]">) {
  await requireCapabilityPage("finance.view");
  const { code } = await params;
  if (!/^\d{4}$/.test(code)) notFound();
  const sp = await searchParams;
  const before = decodeCursor(typeof sp.before === "string" ? sp.before : undefined);

  const [account, activity, tb] = await Promise.all([accountByCode(code), accountActivity(code, { before }), trialBalance()]);
  if (!account) notFound();
  const balance = tb.find((r) => r.code === code);

  return (
    <>
      <PageHeader
        title={`${account.code} · ${account.name}`}
        crumbs={[{ label: "Finance", href: "/finance" }, { label: "Ledger", href: "/finance/ledger" }]}
        description={account.description ?? undefined}
        actions={
          balance ? (
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Balance</div>
              <Money cents={balance.balanceCents} accounting className="text-2xl font-semibold" />
            </div>
          ) : null
        }
      />
      <PageBody className="space-y-4">
        {activity.rows.length === 0 ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>No postings</EmptyTitle>
              <EmptyDescription>Nothing has been posted to this account yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Effect</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.rows.map((r) => (
                  <TableRow key={r.lineId}>
                    <TableCell className="align-top text-sm">
                      <LocalTime value={r.effectiveAt} />
                    </TableCell>
                    <TableCell className="max-w-lg align-top text-sm whitespace-normal">
                      {r.bankTransactionId ? (
                        <Link href={`/finance/transactions/${r.bankTransactionId}`} className="underline-offset-4 hover:underline">
                          {r.description}
                        </Link>
                      ) : (
                        r.description
                      )}
                      {r.kind !== "bank_posting" ? <span className="ml-1 text-xs text-muted-foreground">({r.kind.replace("_", " ")})</span> : null}
                      {r.memo ? <div className="text-xs text-muted-foreground">{r.memo}</div> : null}
                    </TableCell>
                    <TableCell className="text-right align-top">{r.debitCents ? <Money cents={r.debitCents} /> : ""}</TableCell>
                    <TableCell className="text-right align-top">{r.creditCents ? <Money cents={r.creditCents} /> : ""}</TableCell>
                    <TableCell className="hidden text-right align-top sm:table-cell">
                      <Money cents={naturalBalance(account.type, r.debitCents, r.creditCents, account.code)} accounting />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="flex justify-end gap-2">
          {before ? (
            <Button variant="outline" size="sm" render={<Link href={`/finance/ledger/${code}`} />}>
              Newest
            </Button>
          ) : null}
          {activity.hasMore ? (
            <Button variant="outline" size="sm" render={<Link href={`/finance/ledger/${code}?before=${encodeCursor(activity.rows[activity.rows.length - 1])}`} />}>
              Older
            </Button>
          ) : null}
        </div>
      </PageBody>
    </>
  );
}
