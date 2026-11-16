import { describe, expect, it } from "vitest";
import { userVerified } from "./webauthn";

const authData = (flags: number) => {
  const b = Buffer.alloc(37);
  b[32] = flags;
  return b.toString("base64url");
};

describe("userVerified", () => {
  it("reads the UV bit", () => {
    expect(userVerified(authData(0x05))).toBe(true); // UP + UV
    expect(userVerified(authData(0x01))).toBe(false); // UP only
  });
  it("rejects missing or malformed data", () => {
    expect(userVerified(undefined)).toBeNull();
    expect(userVerified("abc")).toBeNull();
  });
});
