import { describe, expect, it } from "vitest";
import { z } from "zod";
import { friendlyIssue } from "./validation-messages";

const first = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value);
  if (r.success) throw new Error("expected a failure");
  return friendlyIssue(r.error.issues[0] as never);
};

describe("friendlyIssue", () => {
  it("turns Zod's wording into plain English, naming the field", () => {
    expect(first(z.object({ text: z.string().max(2000) }), { text: "x".repeat(2001) })).toBe("Note is too long. Keep it to 2,000 characters or fewer.");
    expect(first(z.object({ promiseDollars: z.number().int().positive() }), { promiseDollars: -5 })).toBe("Amount must be more than 0.");
    expect(first(z.object({ promiseDollars: z.number() }), { promiseDollars: Number.NaN })).toBe("Amount must be a number.");
    expect(first(z.object({ promiseDollars: z.number().max(100_000_000) }), { promiseDollars: 1e12 })).toBe("Amount must be 100,000,000 or less.");
    expect(first(z.object({ reason: z.string().min(1) }), { reason: "" })).toBe("Reason can't be empty.");
  });

  it("keeps messages a schema wrote itself", () => {
    expect(first(z.object({ reason: z.string().min(5, "Give a reason (at least 5 characters).") }), { reason: "no" })).toBe("Give a reason (at least 5 characters).");
  });
});
