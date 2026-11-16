import { describe, expect, it } from "vitest";
import { canonicalJson, computeAuditHash, GENESIS_HASH, hashesEqual, type ChainedFields } from "./chain";

const base: ChainedFields = {
  occurredAt: new Date("2026-10-09T12:00:00.123Z"),
  actorType: "staff",
  actorStaffId: "11111111-1111-4111-8111-111111111111",
  action: "staff.role.changed",
  targetType: "staff",
  targetId: "22222222-2222-4222-8222-222222222222",
  reason: null,
  metadata: { from: "loan_officer", to: "legal" },
  ip: "203.0.113.7",
  userAgent: "test",
  prevHash: GENESIS_HASH,
};

describe("canonicalJson", () => {
  it("is independent of key order (jsonb reorders keys)", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("drops undefined like JSON/jsonb does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects values that can't round-trip through jsonb", () => {
    expect(() => canonicalJson({ n: BigInt(1) })).toThrow();
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });
});

describe("computeAuditHash", () => {
  const key = "k".repeat(32);

  it("is deterministic", () => {
    expect(computeAuditHash(key, base)).toBe(computeAuditHash(key, { ...base }));
  });

  it("changes when any field changes", () => {
    const h = computeAuditHash(key, base);
    expect(computeAuditHash(key, { ...base, action: "staff.suspended" })).not.toBe(h);
    expect(computeAuditHash(key, { ...base, metadata: { from: "loan_officer", to: "owner" } })).not.toBe(h);
    expect(computeAuditHash(key, { ...base, occurredAt: new Date(base.occurredAt.getTime() + 1) })).not.toBe(h);
    expect(computeAuditHash(key, { ...base, prevHash: "x" })).not.toBe(h);
  });

  it("depends on the secret key (an attacker without it can't re-chain)", () => {
    expect(computeAuditHash("a".repeat(32), base)).not.toBe(computeAuditHash("b".repeat(32), base));
  });

  it("compares in constant time and handles length mismatch", () => {
    const h = computeAuditHash(key, base);
    expect(hashesEqual(h, h)).toBe(true);
    expect(hashesEqual(h, h.slice(2))).toBe(false);
  });
});
