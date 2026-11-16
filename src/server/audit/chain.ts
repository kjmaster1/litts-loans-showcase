import { createHmac, timingSafeEqual } from "node:crypto";

/** Pure hashing helpers for the audit chain — no I/O, unit-testable. */

export const GENESIS_HASH = "GENESIS";

export type ChainedFields = {
  occurredAt: Date;
  actorType: "staff" | "system" | "anonymous";
  actorStaffId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  prevHash: string;
};

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") throw new TypeError("bigint is not allowed in audit data");
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-finite number in audit data");
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function computeAuditHash(key: string, fields: ChainedFields): string {
  const payload = canonicalJson({ ...fields, occurredAt: fields.occurredAt.toISOString() });
  return createHmac("sha256", key).update(payload).digest("hex");
}

export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
