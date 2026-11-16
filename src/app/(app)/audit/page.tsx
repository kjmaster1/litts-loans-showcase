import { formatCount } from "@/lib/format";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LocalTime } from "@/components/data/local-time";
import { StatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { auditLabel } from "@/lib/audit-labels";
import { isExecutive } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { verifyAuditChain } from "@/server/audit/audit";
import { AUDIT_CATEGORIES, listAuditEvents, type AuditCategory } from "@/server/audit/queries";
import { requireCapabilityPage } from "@/server/authz/viewer";

export const metadata: Metadata = { title: "Audit log" };

/** Compact, non-secret summary of an event's metadata for the table. */
function summarise(metadata: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (typeof metadata.from === "string" && typeof metadata.to === "string") parts.push(`${metadata.from} → ${metadata.to}`);
  if (typeof metadata.username === "string") parts.push(`username: ${metadata.username}`);
  if (typeof metadata.role === "string") parts.push(`role: ${metadata.role}`);
  if (typeof metadata.method === "string") parts.push(`via ${metadata.method.replaceAll("_", " ")}`);
  if (typeof metadata.sessionsRevoked === "number" && metadata.sessionsRevoked > 0) {
    parts.push(`${metadata.sessionsRevoked} session(s) ended`);
  }
  if (typeof metadata.error === "string") parts.push(metadata.error.toLowerCase().replaceAll("_", " "));
  return parts.length ? parts.join(" · ") : null;
}

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const viewer = await requireCapabilityPage("audit.view");
  const params = await searchParams;
  const category = typeof params.category === "string" && Object.hasOwn(AUDIT_CATEGORIES, params.category) ? (params.category as AuditCategory) : undefined;
  // Entry ids are Postgres bigints: anything longer than 18 digits would overflow the column.
  const before = typeof params.before === "string" && /^\d{1,18}$/.test(params.before) ? BigInt(params.before) : undefined;

  const [{ rows, nextBefore }, chain] = await Promise.all([
    listAuditEvents(viewer, { category, before }),
    isExecutive(viewer.role) ? verifyAuditChain() : Promise.resolve(null),
  ]);

  const filterHref = (c?: AuditCategory) => (c ? `/audit?category=${c}` : "/audit");

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in, permission change and sensitive action. Entries can't be edited or deleted."
      />
      <PageBody className="space-y-4">
        {chain ? (
          <div
            role="status"
            className={cn(
              "flex items-start gap-3 rounded-xl border p-3 text-sm",
              chain.ok ? "bg-success-subtle/50" : "border-danger/40 bg-danger-subtle",
            )}
          >
            {chain.ok ? (
              <ShieldCheck className="mt-px size-4 text-success" aria-hidden />
            ) : (
              <ShieldAlert className="mt-px size-4 text-danger" aria-hidden />
            )}
            <div>
              <p className="font-medium">{chain.ok ? "Integrity verified" : "Integrity check FAILED"}</p>
              <p className="text-muted-foreground">
                {chain.ok
                  ? `All ${formatCount(chain.checked)} entries match their cryptographic chain.`
                  : `Entry #${chain.brokenAtId.toString()} does not match (${chain.problem.replace("_", " ")}). The log may have been tampered with. Investigate before trusting entries from that point on.`}
              </p>
            </div>
          </div>
        ) : null}

        <nav aria-label="Filter by category" className="flex flex-wrap gap-2">
          <Button size="sm" variant={!category ? "secondary" : "ghost"} render={<Link href={filterHref()} />}>
            All
          </Button>
          {(Object.keys(AUDIT_CATEGORIES) as AuditCategory[]).map((c) => (
            <Button key={c} size="sm" variant={category === c ? "secondary" : "ghost"} render={<Link href={filterHref(c)} />}>
              {AUDIT_CATEGORIES[c]}
            </Button>
          ))}
        </nav>

        {rows.length === 0 ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyTitle>No events</EmptyTitle>
              <EmptyDescription>Nothing has been recorded for this filter yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead className="hidden xl:table-cell">IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const { label, tone } = auditLabel(r.action);
                  const details = summarise(r.metadata);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm">
                        <LocalTime value={r.occurredAt} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={tone}>{label}</StatusBadge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.actorName ?? <span className="text-muted-foreground capitalize">{r.actorType}</span>}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.targetHref ? (
                          <Link href={r.targetHref} className="text-primary underline-offset-4 hover:underline">
                            {r.targetLabel}
                          </Link>
                        ) : (
                          (r.targetLabel ?? <span className="text-muted-foreground">—</span>)
                        )}
                      </TableCell>
                      <TableCell className="max-w-md text-sm whitespace-normal">
                        {r.reason ? <p className="[overflow-wrap:anywhere]">&ldquo;{r.reason}&rdquo;</p> : null}
                        {details ? <p className="text-muted-foreground">{details}</p> : null}
                        {!r.reason && !details ? <span className="text-muted-foreground">—</span> : null}
                      </TableCell>
                      <TableCell className="ident hidden text-muted-foreground xl:table-cell">{r.ip ?? "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex justify-end gap-2">
          {before ? (
            <Button variant="outline" size="sm" render={<Link href={filterHref(category)} />}>
              Newest
            </Button>
          ) : null}
          {nextBefore ? (
            <Button
              variant="outline"
              size="sm"
              render={<Link href={`/audit?${new URLSearchParams({ ...(category ? { category } : {}), before: nextBefore })}`} />}
            >
              Older entries
            </Button>
          ) : null}
        </div>
      </PageBody>
    </>
  );
}
