import "server-only";
import { ForbiddenError, type Capability } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { authorize, type Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import type { Column, Report } from "@/server/reports/reports";
import { reportToXlsx } from "@/server/reports/xlsx";
import { getRequestMeta } from "@/server/request";

/**
 * Excel download of a list page (research/12): exactly the rows the page shows
 * with its current filters, scoped to what the viewer may see. Every download is
 * audited (`list.exported`), like report downloads.
 */
export async function listExport(
  capability: Capability,
  name: string,
  build: (viewer: Viewer) => Promise<{ title: string; subtitle: string; columns: Column[]; rows: Report["tables"][number]["rows"]; filters: Record<string, string | undefined> }>,
): Promise<Response> {
  let viewer: Viewer;
  try {
    viewer = await authorize(capability);
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw error;
  }
  const t = await build(viewer);
  const file = reportToXlsx({ key: "pnl", title: t.title, subtitle: t.subtitle, tables: [{ title: t.title, columns: t.columns, rows: t.rows }] });
  await recordAudit(db, {
    actor: { type: "staff", staffId: viewer.staffId },
    action: "list.exported",
    target: { type: "list", id: name },
    metadata: { rows: t.rows.length, ...Object.fromEntries(Object.entries(t.filters).filter(([, v]) => v !== undefined)) },
    request: await getRequestMeta(),
  });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  return new Response(new Uint8Array(file), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="litts-${name}-${day}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}

export const asOf = () => `Downloaded ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date())} (UK time)`;
