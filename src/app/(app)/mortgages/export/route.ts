import { asOf, listExport } from "@/server/list-export";
import { listMortgages, MORTGAGE_FILTERS, type MortgageFilter } from "@/server/mortgages/queries";

/** Excel download of the Mortgages list, with the page's filters. */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  return listExport("borrower.lookup", "mortgages", async (viewer) => {
    const param = sp.get("status");
    const status: MortgageFilter = MORTGAGE_FILTERS.includes(param as MortgageFilter) ? (param as MortgageFilter) : "active";
    const q = sp.get("q")?.slice(0, 100) || undefined;
    const rows = await listMortgages(viewer, { status, q });
    const state = (r: (typeof rows)[number]) =>
      r.status !== "active"
        ? r.status
        : !r.state
          ? "terms unknown"
          : r.state.kind === "on_track"
            ? "on track"
            : r.state.kind === "late"
              ? "late, in grace"
              : r.state.kind === "behind"
                ? "behind"
                : "all paid";
    return {
      title: "Mortgages",
      subtitle: `${status === "all" ? "All mortgages" : `Showing: ${status}`}${q ? ` · search “${q}”` : ""} · ${asOf()}`,
      filters: { status, q },
      columns: [
        { key: "address", label: "Property", kind: "text" },
        { key: "buyer", label: "Buyer", kind: "text" },
        { key: "stateId", label: "State ID", kind: "number" },
        { key: "started", label: "Started", kind: "date" },
        { key: "funding", label: "Funded by", kind: "text" },
        { key: "officer", label: "Officer", kind: "text" },
        { key: "price", label: "Price", kind: "money" },
        { key: "loan", label: "Loan", kind: "money" },
        { key: "paid", label: "Payments", kind: "text" },
        { key: "state", label: "State", kind: "text" },
        { key: "missed", label: "Missed", kind: "number" },
        { key: "principalLeft", label: "Principal to repay", kind: "money" },
        { key: "interestLeft", label: "Broker interest to come", kind: "money" },
      ],
      rows: rows.map((r) => ({
        address: r.address,
        buyer: r.buyerName ?? "",
        stateId: r.buyerStateId,
        started: r.originatedAt,
        funding: r.funding === "company" ? "Litt’s" : "State",
        officer: r.officerName ?? "",
        price: r.priceCents,
        loan: r.loanCents,
        paid: r.instalments ? `${r.paymentsMade}/${r.instalments}` : String(r.paymentsMade),
        state: state(r),
        missed: r.state?.kind === "late" || r.state?.kind === "behind" ? r.state.overdue : null,
        principalLeft: r.principalRemainingCents,
        interestLeft: r.brokerInterestRemainingCents,
      })),
    };
  });
}
