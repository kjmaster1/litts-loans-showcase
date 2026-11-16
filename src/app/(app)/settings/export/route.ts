import { ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import { requireFreshStepUp, StepUpRequiredError } from "@/server/auth/step-up-guard";
import { authorize } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { fullExport } from "@/server/export";
import { getRequestMeta } from "@/server/request";

/** Full data export (Owner/CEO/COO, fresh authenticator code). Audited. */
export async function GET() {
  let viewer;
  try {
    viewer = await authorize("settings.manage");
    requireFreshStepUp(viewer);
  } catch (error) {
    // StepUpRequiredError is a ForbiddenError, so it's checked first.
    if (error instanceof StepUpRequiredError) return new Response("Confirm with your authenticator first, then try again.", { status: 403 });
    if (error instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw error;
  }
  const { bytes, rows } = await fullExport();
  await recordAudit(db, {
    actor: { type: "staff", staffId: viewer.staffId },
    action: "data.export.downloaded",
    target: { type: "export", id: "full" },
    metadata: { rows, bytes: bytes.length },
    request: await getRequestMeta(),
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="litts-loans-full-export-${stamp}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}
