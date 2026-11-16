"use client";

import { UserPlus } from "lucide-react";
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { inviteStaffAction } from "./actions";
import { InviteLink } from "./invite-link";

export function InviteStaffDialog({ roles }: { roles: Role[] }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>(roles.includes("loan_officer") ? "loan_officer" : roles[roles.length - 1]);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ url: string; expiresAt: string; name: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setIssued(null);
      setError(null);
    }
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const characterName = String(form.get("characterName") ?? "");
    setError(null);
    startTransition(async () => {
      const result = await inviteStaffAction({ stateId: String(form.get("stateId") ?? ""), characterName, role });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setIssued({ ...result.data, name: characterName });
    });
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger render={<Button />}>
        <UserPlus />
        Invite staff
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle>Invite ready for {issued.name}</DialogTitle>
              <DialogDescription>They&rsquo;ll choose a username and password, then set up 2FA.</DialogDescription>
            </DialogHeader>
            <InviteLink url={issued.url} expiresAt={issued.expiresAt} />
            <DialogFooter>
              <Button onClick={() => reset(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form method="post" onSubmit={onSubmit} noValidate>
            <DialogHeader>
              <DialogTitle>Invite a staff member</DialogTitle>
              <DialogDescription>Creates a single-use sign-up link. Use the character&rsquo;s in-game details.</DialogDescription>
            </DialogHeader>
            <FieldGroup className="py-4">
              <Field>
                <FieldLabel htmlFor="characterName">Character name</FieldLabel>
                <Input id="characterName" name="characterName" placeholder="e.g. Skyler Marlowe" autoComplete="off" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="stateId">State ID</FieldLabel>
                <Input id="stateId" name="stateId" inputMode="numeric" className="ident" placeholder="3628" autoComplete="off" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="role">Role</FieldLabel>
                <Select
                  value={role}
                  onValueChange={(v) => setRole(v as Role)}
                  items={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                >
                  <SelectTrigger id="role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => reset(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner /> : null}
                Create invite link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
