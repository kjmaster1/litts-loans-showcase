import "server-only";
import { eq } from "drizzle-orm";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { staff } from "@/server/db/schema";

/**
 * Remembers that someone finished or skipped the app tour, and as which role
 * (docs/design/TUTORIAL-2026-10-12.md). Like `notification_read`, this is the person's own
 * display state, not a business change, so it isn't written to the audit log.
 */
export async function completeTour(viewer: Viewer): Promise<void> {
  await db.update(staff).set({ tourCompletedAt: new Date(), tourRole: viewer.role }).where(eq(staff.id, viewer.staffId));
}
