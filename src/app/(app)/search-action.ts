"use server";

import { formatDollars } from "@/lib/format";
import { z } from "zod";
import { dateFormat } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { cleanSearch } from "@/lib/search";
import { ROLE_LABEL } from "@/lib/roles";
import { runAction } from "@/server/action";
import { authorize } from "@/server/authz/viewer";
import { listLoans, searchBorrowers } from "@/server/loans/queries";
import { listMortgages } from "@/server/mortgages/queries";
import { searchStaff } from "@/server/staff/service";

export type SearchHit = { kind: "borrower" | "loan" | "mortgage" | "staff"; title: string; detail: string; href: string };

const money = formatDollars;
const date = (d: Date) => dateFormat({ day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(d);

/** The search palette (redesign 2026-10): borrowers, loans and properties the viewer may see; staff for managers. */
export async function searchAction(raw: string) {
  return runAction(async (): Promise<SearchHit[]> => {
    const viewer = await authorize("borrower.lookup");
    const q = cleanSearch(z.string().max(200).parse(raw), 60);
    if (q.length < 2) return [];
    const [borrowers, loans, mortgages, people] = await Promise.all([
      searchBorrowers(q),
      listLoans(viewer, { status: "all", q }),
      listMortgages(viewer, { status: "all", q }),
      can(viewer.role, "staff.view") ? searchStaff(q) : Promise.resolve([]),
    ]);
    return [
      ...borrowers.slice(0, 5).map((b) => ({
        kind: "borrower" as const,
        title: b.name ?? "Unknown",
        detail: `#${b.stateId} · ${b.loans} loan${b.loans === 1 ? "" : "s"}`,
        href: `/loans/borrowers/${b.stateId}`,
      })),
      ...loans.slice(0, 6).map((l) => ({
        kind: "loan" as const,
        title: `${l.borrowerName ?? `State ID ${l.borrowerStateId}`} · ${money(l.principalCents)}`,
        detail: `${l.status.replace("_", " ")}${l.openedAt ? ` · opened ${date(l.openedAt)}` : ""}`,
        href: `/loans/${l.id}`,
      })),
      ...mortgages.slice(0, 5).map((m) => ({
        kind: "mortgage" as const,
        title: m.address,
        detail: `${m.buyerName ?? "Unknown buyer"} · ${m.status}`,
        href: `/mortgages/${m.id}`,
      })),
      ...people.slice(0, 4).map((s) => ({ kind: "staff" as const, title: s.name, detail: `#${s.stateId} · ${ROLE_LABEL[s.role as keyof typeof ROLE_LABEL] ?? s.role}`, href: "/staff" })),
    ];
  });
}
