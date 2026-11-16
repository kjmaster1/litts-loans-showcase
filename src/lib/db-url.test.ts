import { describe, expect, it } from "vitest";
import { hardenConnectionString } from "./db-url";

describe("hardenConnectionString", () => {
  it("upgrades weak or ambiguous sslmodes to verify-full", () => {
    for (const mode of ["require", "prefer", "verify-ca"]) {
      const out = new URL(hardenConnectionString(`postgresql://u:p@ep-x.eu-west-2.aws.neon.tech/neondb?sslmode=${mode}&channel_binding=require`));
      expect(out.searchParams.get("sslmode")).toBe("verify-full");
      expect(out.searchParams.get("channel_binding")).toBe("require");
      expect(out.password).toBe("p");
    }
  });

  it("leaves URLs without sslmode (local Docker) untouched", () => {
    expect(hardenConnectionString("postgres://litts:pw@localhost:54329/litts_loans")).toBe("postgres://litts:pw@localhost:54329/litts_loans");
  });
});
