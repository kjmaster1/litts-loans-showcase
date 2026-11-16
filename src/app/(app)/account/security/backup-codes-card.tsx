"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

/** Regenerates backup codes (invalidating the old ones) after re-entering the password. */
export function BackupCodesCard() {
  const [open, setOpen] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close(next: boolean) {
    setOpen(next);
    if (!next) {
      setCodes(null);
      setError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger render={<Button variant="outline" />}>Generate new backup codes</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {codes ? (
          <>
            <DialogHeader>
              <DialogTitle>Your new backup codes</DialogTitle>
              <DialogDescription>Your old codes no longer work. Save these now; they won&rsquo;t be shown again.</DialogDescription>
            </DialogHeader>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border bg-muted/40 p-4">
              {codes.map((c) => (
                <li key={c} className="ident select-all">
                  {c}
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button onClick={() => navigator.clipboard.writeText(codes.join("\n"))} variant="outline">
                Copy all
              </Button>
              <Button onClick={() => close(false)}>I&rsquo;ve saved them</Button>
            </DialogFooter>
          </>
        ) : (
          <form method="post"
            onSubmit={(e) => {
              e.preventDefault();
              const password = String(new FormData(e.currentTarget).get("password") ?? "");
              setError(null);
              startTransition(async () => {
                const { data, error: genError } = await authClient.twoFactor.generateBackupCodes({ password });
                if (genError || !data) {
                  setError(genError?.status === 429 ? "Too many attempts. Please wait." : "Incorrect password.");
                  return;
                }
                setCodes(data.backupCodes);
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Generate new backup codes</DialogTitle>
              <DialogDescription>This replaces all your existing backup codes.</DialogDescription>
            </DialogHeader>
            <Field className="py-4">
              <FieldLabel htmlFor="bc-password">Confirm your password</FieldLabel>
              <Input id="bc-password" name="password" type="password" autoComplete="current-password" autoFocus />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner /> : null}
                Generate
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
