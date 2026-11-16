import { asOf, listExport } from "@/server/list-export";
import { COLLECTION_LABEL, collectionsQueue } from "@/server/loans/collections";

/** Excel download of the Collections list, most urgent first. */
export async function GET() {
  return listExport("borrower.lookup", "collections", async (viewer) => {
    const rows = await collectionsQueue(viewer);
    return {
      title: "Collections",
      subtitle: `Most urgent first · ${asOf()}`,
      filters: {},
      columns: [
        { key: "type", label: "Type", kind: "text" },
        { key: "borrower", label: "Borrower", kind: "text" },
        { key: "stateId", label: "State ID", kind: "number" },
        { key: "status", label: "Status", kind: "text" },
        { key: "missed", label: "Missed", kind: "number" },
        { key: "owed", label: "Owed", kind: "money" },
        { key: "officer", label: "Officer", kind: "text" },
        { key: "action", label: "Needs action", kind: "text" },
        { key: "broken", label: "Broken promises", kind: "number" },
        { key: "promise", label: "Promise pending", kind: "money" },
        { key: "promiseBy", label: "Promised by", kind: "date" },
        { key: "last", label: "Last action", kind: "text" },
        { key: "lastAt", label: "Last action on", kind: "date" },
        { key: "note", label: "Last note", kind: "text" },
        { key: "followUp", label: "Follow up on", kind: "date" },
        { key: "legal", label: "With Legal", kind: "text" },
      ],
      rows: rows.map((r) => ({
        type: r.type === "loan" ? "Loan" : "Mortgage",
        borrower: r.borrower,
        stateId: r.stateId,
        status: r.status.replace("_", " "),
        missed: r.missed,
        owed: r.owedCents,
        officer: r.officerName ?? "",
        action: r.due ? (r.last ? "Yes" : "Not contacted") : "",
        broken: r.brokenPromises,
        promise: r.pendingPromise?.promiseCents ?? null,
        promiseBy: r.pendingPromise?.promiseBy ?? null,
        last: r.last ? COLLECTION_LABEL[r.last.kind] : "",
        lastAt: r.last?.at ?? null,
        note: r.last?.note ?? "",
        followUp: r.nextActionAt,
        legal: r.withLegal ? "Yes" : "",
      })),
    };
  });
}
