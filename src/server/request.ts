import "server-only";
import { headers } from "next/headers";

/**
 * Client IP and user agent for audit records. Vercel sets `x-forwarded-for`.
 * Outside a web request (a maintenance script) there are none: both are null.
 */
export async function getRequestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  let h: Headers;
  try {
    h = await headers();
  } catch {
    return { ip: null, userAgent: null };
  }
  const forwarded = h.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return { ip, userAgent: h.get("user-agent")?.slice(0, 512) ?? null };
}
