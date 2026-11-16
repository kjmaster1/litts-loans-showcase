"use client";

import { Fingerprint } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

/** Deliberately generic: never reveal whether the username exists (OWASP ASVS V6). */
const GENERIC_ERROR = "Incorrect username or password.";

function messageFor(code: string | undefined, status: number | undefined): string {
  if (status === 429 || code === "ACCOUNT_TEMPORARILY_LOCKED") {
    return "Too many attempts. Please wait a minute and try again.";
  }
  if (status === 403) return "This account is not active. Contact management.";
  return GENERIC_ERROR;
}

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setError(null);

    startTransition(async () => {
      const { data, error: signInError } = await authClient.signIn.username({ username, password });
      if (signInError) {
        setError(messageFor(signInError.code, signInError.status));
        return;
      }
      const destination = encodeURIComponent(next);
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
        router.push(`/two-factor?next=${destination}`);
      } else {
        // Password-only session: the app will route an unenrolled user to 2FA setup.
        router.push(next);
      }
      router.refresh();
    });
  }

  function withPasskey() {
    setError(null);
    startTransition(async () => {
      const r = await authClient.signIn.passkey();
      if (r?.error) {
        const message = r.error.message ?? "";
        if (/NotAllowed|cancel|timed out/i.test(message)) setError("Passkey sign-in was cancelled.");
        else if (r.error.status === 403) setError(messageFor(undefined, 403));
        else setError(message || "That passkey didn't work.");
        return;
      }
      router.push(next);
      router.refresh();
    });
  }

  return (
    <form method="post" onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus
            aria-invalid={error ? true : undefined}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={error ? true : undefined}
          />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? "Signing in…" : "Sign in"}
        </Button>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" aria-hidden />
          or
          <span className="h-px flex-1 bg-border" aria-hidden />
        </div>
        <Button type="button" variant="outline" size="lg" className="w-full" disabled={pending} onClick={withPasskey}>
          <Fingerprint aria-hidden />
          Sign in with a passkey
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Forgotten your password? Ask the CEO for a one-time reset link.
        </p>
      </FieldGroup>
    </form>
  );
}
