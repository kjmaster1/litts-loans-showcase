import { can } from "@/lib/permissions";
import { asOf, listExport } from "@/server/list-export";
import { listLoans, STATUS_FILTERS, type StatusFilter } from "@/server/loans/queries";

/** Excel download of the Loans list, with the page's filters. */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  return listExport("borrower.lookup", "loans", async (viewer) => {
    const statusParam = sp.get("status");
    const status: StatusFilter = STATUS_FILTERS.includes(statusParam as StatusFilter) ? (statusParam as StatusFilter) : "active";
    const q = sp.get("q")?.slice(0, 100) || undefined;
    const officer = can(viewer.role, "loans.view_all") ? sp.get("officer")?.slice(0, 40) || undefined : undefined;
    const rows = await listLoans(viewer, { status, q, officer });
    return {
      title: "Loans",
      subtitle: `${status === "all" ? "All loans" : `Status: ${status.replace("_", " ")}`}${q ? ` · search “${q}”` : ""} · ${asOf()}`,
      filters: { status, q, officer },
      columns: [
        { key: "borrower", label: "Borrower", kind: "text" },
        { key: "stateId", label: "State ID", kind: "number" },
        { key: "opened", label: "Opened", kind: "date" },
        { key: "status", label: "Status", kind: "text" },
        { key: "paid", label: "Paid", kind: "text" },
        { key: "missed", label: "Missed", kind: "number" },
        { key: "rate", label: "Broker rate", kind: "percent" },
        { key: "officer", label: "Officer", kind: "text" },
        { key: "principal", label: "Principal", kind: "money" },
        { key: "principalIn", label: "Principal received", kind: "money" },
        { key: "interestIn", label: "Interest received", kind: "money" },
        { key: "owed", label: "Still owed", kind: "money" },
        { key: "next", label: "Next payment", kind: "date" },
        { key: "lastPayment", label: "Last payment", kind: "date" },
      ],
      rows: rows.map((l) => ({
        borrower: l.borrowerName ?? "",
        stateId: l.borrowerStateId,
        opened: l.openedAt,
        status: l.status.replace("_", " "),
        paid: l.instalments ? `${l.lastCompleted ?? 0}/${l.instalments}` : "",
        missed: l.lastMissed && l.status !== "completed" ? l.lastMissed : null,
        rate: l.brokerRateBp !== null ? l.brokerRateBp / 10_000 : null,
        officer: l.officerName ?? "",
        principal: l.principalCents,
        principalIn: l.principalReceivedCents,
        interestIn: l.interestReceivedCents,
        owed: l.outstandingCents,
        next: l.status === "completed" ? null : l.nextPaymentDueAt,
        lastPayment: l.lastPaymentAt,
      })),
    };
  });
}
