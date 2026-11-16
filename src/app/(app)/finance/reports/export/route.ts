import { ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { authorize } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { buildReport, parseRange, REPORTS, type ReportKey } from "@/server/reports/reports";
import { reportToXlsx } from "@/server/reports/xlsx";
import { getRequestMeta } from "@/server/request";

/** Excel download of a report. Same permission as the page; every download is audited. */
export async function GET(request: Request) {
  let viewer;
  try {
    viewer = await authorize("finance.view");
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw error;
  }
  const url = new URL(request.url);
  const key = url.searchParams.get("report") as ReportKey;
  if (!REPORTS.includes(key)) return new Response("Unknown report", { status: 400 });
  const range = parseRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined);
  const report = await buildReport(viewer, key, range);
  const file = reportToXlsx(report);

  await recordAudit(db, {
    actor: { type: "staff", staffId: viewer.staffId },
    action: "report.exported",
    target: { type: "report", id: key },
    metadata: { from: range.fromKey, to: range.toKey },
    request: await getRequestMeta(),
  });

  const name = `litts-${key}-${range.fromKey}-to-${range.toKey}.xlsx`;
  return new Response(new Uint8Array(file), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
