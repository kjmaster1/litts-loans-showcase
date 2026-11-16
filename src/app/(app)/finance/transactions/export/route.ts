import { CATEGORIES, isCategory } from "@/domain/ledger/categories";
import { asOf, listExport } from "@/server/list-export";
import { listBankTransactions } from "@/server/ledger/queries";

/** Excel download of the bank transactions, with the page's filters (every page). */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  return listExport("finance.view", "transactions", async () => {
    const q = sp.get("q")?.slice(0, 100) || undefined;
    const c = sp.get("category");
    const category = c && isCategory(c) ? c : undefined;
    const direction = sp.get("direction") === "in" ? "in" : sp.get("direction") === "out" ? "out" : undefined;
    const review = sp.get("view") === "review";
    const { rows } = await listBankTransactions({ q, category, direction, review, page: 1 }, 100_000);
    return {
      title: "Transactions",
      subtitle: `${review ? "Needing review" : "Bank rows"}${category ? ` · ${CATEGORIES[category].label}` : ""}${direction ? ` · money ${direction}` : ""}${q ? ` · search “${q}”` : ""} · times in UTC · ${asOf()}`,
      filters: { q, category, direction, view: review ? "review" : undefined },
      columns: [
        { key: "at", label: "Time (UTC)", kind: "text" },
        { key: "direction", label: "In/out", kind: "text" },
        { key: "type", label: "Bank type", kind: "text" },
        { key: "amount", label: "Amount", kind: "money" },
        { key: "tax", label: "Tax withheld", kind: "money" },
        { key: "source", label: "From wallet", kind: "text" },
        { key: "target", label: "To wallet", kind: "text" },
        { key: "initiator", label: "Initiated by", kind: "text" },
        { key: "stateId", label: "State ID", kind: "number" },
        { key: "comment", label: "Comment", kind: "text" },
        { key: "category", label: "Category", kind: "text" },
      ],
      rows: rows.map((t) => ({
        at: t.occurredAt.toISOString().replace("T", " ").slice(0, 19),
        direction: t.direction,
        type: t.txType,
        amount: t.amountCents,
        tax: t.taxCents,
        source: t.sourceWallet ?? "",
        target: t.targetWallet ?? "",
        initiator: t.initiatorName ?? "",
        stateId: t.initiatorStateId,
        comment: t.comment,
        category: isCategory(t.category) ? CATEGORIES[t.category].label : t.category,
      })),
    };
  });
}
