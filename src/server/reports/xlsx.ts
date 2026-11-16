import "server-only";
import * as XLSX from "xlsx";
import type { Report, ReportTable } from "./reports";

/** One sheet per table: title rows, a header row, data, and a total row. Money in dollars. */
export function reportToXlsx(report: Report): Uint8Array {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const table of report.tables) {
    XLSX.utils.book_append_sheet(wb, sheetFor(report, table), uniqueName(table.title, used));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true }) as Uint8Array;
}

function uniqueName(title: string, used: Set<string>): string {
  const base = title.replace(/[\\/?*[\]:]/g, " ").slice(0, 28).trim() || "Sheet";
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name);
  return name;
}

function sheetFor(report: Report, table: ReportTable): XLSX.WorkSheet {
  const value = (kind: string, v: unknown) => (v === null || v === undefined ? null : kind === "money" ? Number(v) / 100 : v);
  const header = table.columns.map((c) => c.label);
  const body = table.rows.map((r) => table.columns.map((c) => value(c.kind, r[c.key])));
  const total = table.total ? [table.columns.map((c) => value(c.kind, table.total![c.key]))] : [];
  const aoa: unknown[][] = [[`${report.title}: ${table.title}`], [report.subtitle], ...(table.note ? [[table.note]] : []), [], header, ...body, ...total];
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  const first = aoa.length - body.length - total.length; // first data row (0-based)
  table.columns.forEach((c, ci) => {
    if (c.kind !== "money" && c.kind !== "date" && c.kind !== "percent") return;
    for (let ri = first; ri < aoa.length; ri++) {
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })];
      if (cell && typeof cell.v !== "string") cell.z = c.kind === "money" ? "$#,##0;[Red]-$#,##0" : c.kind === "percent" ? "0%" : "d mmm yyyy";
    }
  });
  ws["!cols"] = table.columns.map((c) => ({ wch: c.kind === "text" ? 28 : 14 }));
  return ws;
}
