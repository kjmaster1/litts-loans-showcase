"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Browser-side auth client. Same-origin, so no baseURL is needed. */
export const authClient = createAuthClient({
  plugins: [
    usernameClient(),
    // Navigation after a password-only success is handled by the sign-in form.
    twoFactorClient(),
    passkeyClient(),
  ],
});
