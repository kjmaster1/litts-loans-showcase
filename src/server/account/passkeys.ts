import "server-only";
import { desc, eq } from "drizzle-orm";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { passkey } from "@/server/db/schema";

export type MyPasskey = { id: string; name: string | null; createdAt: Date | null; deviceType: string; backedUp: boolean };

/** The viewer's passkeys, without key material. */
export async function listMyPasskeys(viewer: Viewer): Promise<MyPasskey[]> {
  return db
    .select({ id: passkey.id, name: passkey.name, createdAt: passkey.createdAt, deviceType: passkey.deviceType, backedUp: passkey.backedUp })
    .from(passkey)
    .where(eq(passkey.userId, viewer.userId))
    .orderBy(desc(passkey.createdAt));
}
