"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { resetPasswordAction, type ResetPasswordState } from "./actions";

export function ResetPasswordForm({ token, username }: { token: string; username: string | null }) {
  const [state, action, pending] = useActionState<ResetPasswordState, FormData>(resetPasswordAction.bind(null, token), {});
  const fe = state.fieldErrors ?? {};

  return (
    <form action={action} method="post" noValidate>
      {/* For password managers: which account this password belongs to. */}
      <input type="text" name="username" autoComplete="username" value={username ?? ""} readOnly hidden />
      <FieldGroup>
        <Field data-invalid={fe.password ? true : undefined}>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={fe.password ? true : undefined}
            aria-describedby="password-help"
            required
          />
          <FieldDescription id="password-help">
            At least 12 characters. A passphrase of a few unrelated words works well. We check it against known breaches. Save it in a password manager.
          </FieldDescription>
          <FieldError>{fe.password}</FieldError>
        </Field>
        <Field data-invalid={fe.confirm ? true : undefined}>
          <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" aria-invalid={fe.confirm ? true : undefined} required />
          <FieldError>{fe.confirm}</FieldError>
        </Field>
        {state.formError ? <FieldError>{state.formError}</FieldError> : null}
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? <Spinner /> : null}
          Set new password
        </Button>
        <p className="text-center text-xs text-muted-foreground">Then sign in with it and your usual authenticator code.</p>
      </FieldGroup>
    </form>
  );
}
