/**
 * Reads the "user verified" (UV) flag from WebAuthn authenticator data: byte 32
 * holds the flags, bit 2 = UV (the authenticator checked a fingerprint, face or
 * PIN). The data is covered by the passkey's signature, so it can't be forged.
 * Returns null when the data is missing or malformed.
 */
export function userVerified(authenticatorDataBase64Url: unknown): boolean | null {
  if (typeof authenticatorDataBase64Url !== "string" || authenticatorDataBase64Url.length < 44) return null;
  try {
    const bytes = Buffer.from(authenticatorDataBase64Url, "base64url");
    if (bytes.length < 37) return null;
    return (bytes[32] & 0x04) !== 0;
  } catch {
    return null;
  }
}
