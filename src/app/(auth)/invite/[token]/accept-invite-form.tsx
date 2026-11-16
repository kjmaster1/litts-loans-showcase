"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { acceptInviteAction, type AcceptInviteState } from "./actions";

export function AcceptInviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<AcceptInviteState, FormData>(
    acceptInviteAction.bind(null, token),
    {},
  );
  const fe = state.fieldErrors ?? {};

  return (
    <form action={action} noValidate>
      <FieldGroup>
        <Field data-invalid={fe.username ? true : undefined}>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={state.values?.username}
            aria-invalid={fe.username ? true : undefined}
            aria-describedby="username-help"
            required
          />
          <FieldDescription id="username-help">Lowercase letters, numbers, dots and underscores.</FieldDescription>
          <FieldError>{fe.username}</FieldError>
        </Field>
        <Field data-invalid={fe.password ? true : undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
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
            At least 12 characters. A passphrase of a few unrelated words works well. We check it against known
            breaches.
          </FieldDescription>
          <FieldError>{fe.password}</FieldError>
        </Field>
        <Field data-invalid={fe.confirm ? true : undefined}>
          <FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            aria-invalid={fe.confirm ? true : undefined}
            required
          />
          <FieldError>{fe.confirm}</FieldError>
        </Field>
        {state.formError ? <FieldError>{state.formError}</FieldError> : null}
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? <Spinner /> : null}
          Create account
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Next, you&rsquo;ll set up two-factor authentication.
        </p>
      </FieldGroup>
    </form>
  );
}
