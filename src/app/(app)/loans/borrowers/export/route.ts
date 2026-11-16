import { filterDirectory, sortDirectory, type DirectorySort } from "@/domain/borrowers/directory";
import { STANDING_LABEL } from "@/domain/borrowers/standing-labels";
import { cleanSearch } from "@/lib/search";
import { listBorrowerDirectory } from "@/server/borrowers";
import { asOf, listExport } from "@/server/list-export";

const SORTS = ["standing", "owed", "name", "recent"] as const;

/** Excel download of the borrower directory, with the page's search and sort. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = cleanSearch(url.searchParams.get("q"), 60);
  const sort: DirectorySort = SORTS.find((s) => s === url.searchParams.get("sort")) ?? "standing";
  return listExport("borrower.lookup", "borrowers", async () => {
    const rows = sortDirectory(filterDirectory(await listBorrowerDirectory(), q), sort);
    return {
      title: "Borrowers",
      subtitle: `${q ? `Matching “${q}” · ` : ""}${asOf()}`,
      filters: { q: q || undefined, sort },
      columns: [
        { key: "name", label: "Borrower", kind: "text" },
        { key: "stateId", label: "State ID", kind: "number" },
        { key: "standing", label: "Standing", kind: "text" },
        { key: "openLoans", label: "Open loans", kind: "number" },
        { key: "loans", label: "Loans", kind: "number" },
        { key: "openMortgages", label: "Open mortgages", kind: "number" },
        { key: "mortgages", label: "Mortgages", kind: "number" },
        { key: "owed", label: "Owed on loans", kind: "money" },
        { key: "lent", label: "Lent in total", kind: "money" },
        { key: "repaid", label: "Loans repaid", kind: "number" },
        { key: "wentBad", label: "Loans gone bad", kind: "number" },
        { key: "last", label: "Last activity", kind: "date" },
      ],
      rows: rows.map((r) => ({
        name: r.name ?? "",
        stateId: r.stateId,
        standing: STANDING_LABEL[r.standing].label,
        openLoans: r.openLoans,
        loans: r.loans,
        openMortgages: r.openMortgages,
        mortgages: r.mortgages,
        owed: r.owedCents,
        lent: r.lentCents,
        repaid: r.repaid,
        wentBad: r.wentBad,
        last: r.lastActivityAt,
      })),
    };
  });
}
