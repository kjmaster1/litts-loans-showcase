import { describe, expect, it } from "vitest";
import { collectionPriority, promiseOutcome } from "./collections";

const promise = { loggedAt: new Date("2026-10-10T10:00:00Z"), promiseCents: 500_000, promiseBy: new Date("2026-10-14T12:00:00Z") };
const pay = (iso: string, dollars: number) => ({ at: new Date(iso), cents: dollars * 100 });

describe("promiseOutcome", () => {
  it("is kept once enough is paid by the end of the promised day", () => {
    expect(promiseOutcome(promise, [pay("2026-10-12T09:00:00Z", 3000), pay("2026-10-14T22:00:00Z", 2000)], new Date("2026-10-20T00:00:00Z"))).toEqual({ state: "kept", paidCents: 500_000 });
  });
  it("is pending until the day has passed, then broken", () => {
    const partial = [pay("2026-10-12T09:00:00Z", 1000)];
    expect(promiseOutcome(promise, partial, new Date("2026-10-14T20:00:00Z")).state).toBe("pending");
    expect(promiseOutcome(promise, partial, new Date("2026-10-15T00:30:00Z"))).toEqual({ state: "broken", paidCents: 100_000 });
  });
  it("ignores payments from before the promise or after the day", () => {
    expect(promiseOutcome(promise, [pay("2026-10-09T09:00:00Z", 5000), pay("2026-10-16T09:00:00Z", 5000)], new Date("2026-10-20T00:00:00Z")).state).toBe("broken");
  });
});

describe("collectionPriority", () => {
  const base = { owedCents: 2_000_000, missed: 1, brokenPromises: 0, pendingPromise: false, followUpDue: false, neverContacted: false };
  it("ranks bigger, later, broken-promise cases first and waits on pending promises", () => {
    const p = (o: Partial<typeof base>) => collectionPriority({ ...base, ...o });
    expect(p({ owedCents: 8_000_000 })).toBeGreaterThan(p({}));
    expect(p({ missed: 3 })).toBeGreaterThan(p({}));
    expect(p({ brokenPromises: 1 })).toBeGreaterThan(p({ missed: 3 }));
    expect(p({ pendingPromise: true })).toBeLessThan(p({}));
    expect(p({ neverContacted: true })).toBeGreaterThan(p({}));
  });
});
