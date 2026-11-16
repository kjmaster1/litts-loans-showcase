"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

export function ChangePasswordForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("current") ?? "");
    const newPassword = String(form.get("next") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    setError(null);
    if (newPassword.length < 12) return setError("Use at least 12 characters.");
    if (newPassword !== confirm) return setError("New passwords don't match.");
    if (newPassword === currentPassword) return setError("Choose a different password from your current one.");

    startTransition(async () => {
      const { error: changeError } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (changeError) {
        setError(
          changeError.code === "PASSWORD_COMPROMISED"
            ? "This password has appeared in a data breach. Choose another."
            : changeError.status === 429
              ? "Too many attempts. Please wait a few minutes."
              : changeError.code === "INVALID_PASSWORD"
                ? "Your current password is incorrect."
                : "We couldn't change your password. Please try again.",
        );
        return;
      }
      formRef.current?.reset();
      toast.success("Password changed. Other sessions have been signed out.");
    });
  }

  return (
    <form method="post" ref={formRef} onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="current">Current password</FieldLabel>
          <Input id="current" name="current" type="password" autoComplete="current-password" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="next">New password</FieldLabel>
          <Input id="next" name="next" type="password" autoComplete="new-password" required />
          <FieldDescription>At least 12 characters. Checked against known breaches.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner /> : null}
            Change password
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
