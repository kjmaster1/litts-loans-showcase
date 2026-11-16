"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

type Mode = "totp" | "backup";

function messageFor(code: string | undefined, status: number | undefined, mode: Mode): string {
  if (status === 429 || code === "ACCOUNT_TEMPORARILY_LOCKED") {
    return "Too many attempts. Wait a few minutes before trying again.";
  }
  if (status === 401 && code !== "INVALID_CODE" && code !== "INVALID_BACKUP_CODE") {
    return "Your sign-in attempt expired. Please sign in again.";
  }
  return mode === "totp" ? "That code didn't match. Check your app and try again." : "That backup code isn't valid.";
}

export function TwoFactorForm({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(value: string) {
    setError(null);
    startTransition(async () => {
      const result =
        mode === "totp"
          ? await authClient.twoFactor.verifyTotp({ code: value })
          : await authClient.twoFactor.verifyBackupCode({ code: value.trim() });
      if (result.error) {
        setError(messageFor(result.error.code, result.error.status, mode));
        setCode("");
        return;
      }
      router.push(next);
      router.refresh();
    });
  }

  return (
    <form method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit(code);
      }}
    >
      <FieldGroup>
        {mode === "totp" ? (
          <Field>
            <FieldLabel htmlFor="totp" className="sr-only">
              Authentication code
            </FieldLabel>
            <InputOTP
              id="totp"
              maxLength={6}
              pattern={REGEXP_ONLY_DIGITS}
              value={code}
              onChange={setCode}
              onComplete={submit}
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              disabled={pending}
              aria-invalid={error ? true : undefined}
              containerClassName="justify-center"
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
              </InputOTPGroup>
              <InputOTPSeparator />
              <InputOTPGroup>
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor="backup">Backup code</FieldLabel>
            <Input
              id="backup"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="ident"
              autoFocus
              aria-invalid={error ? true : undefined}
            />
            <FieldDescription>Each backup code works once.</FieldDescription>
          </Field>
        )}

        {error ? <FieldError className="text-center">{error}</FieldError> : null}

        <Button type="submit" size="lg" className="w-full" disabled={pending || code.length < (mode === "totp" ? 6 : 8)}>
          {pending ? <Spinner /> : null}
          Verify
        </Button>

        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            className="text-primary underline-offset-4 hover:underline"
            onClick={() => {
              setMode(mode === "totp" ? "backup" : "totp");
              setCode("");
              setError(null);
            }}
          >
            {mode === "totp" ? "Use a backup code" : "Use authenticator app"}
          </button>
          <Link href="/sign-in" className="text-muted-foreground underline-offset-4 hover:underline">
            Start over
          </Link>
        </div>
      </FieldGroup>
    </form>
  );
}
