"use client";

import { Ban, KeyRound, Link2, LockKeyhole, LogOut, MoreHorizontal, PenLine, RotateCcw, UserCog } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { useStepUp } from "@/components/step-up/step-up-provider";
import { changeNameAction, changeRoleAction, changeStatusAction, issuePasswordResetAction, reissueInviteAction, resetTwoFactorAction } from "./actions";
import { InviteLink } from "./invite-link";

type Member = { id: string; name: string; role: Role; status: "invited" | "active" | "suspended" | "departed" };
type StatusChange = "suspend" | "reactivate" | "depart";

const COPY: Record<StatusChange, { title: string; body: string; cta: string; destructive: boolean }> = {
  suspend: {
    title: "Suspend access",
    body: "They'll be signed out everywhere immediately and can't sign in until reactivated.",
    cta: "Suspend",
    destructive: true,
  },
  reactivate: { title: "Reactivate access", body: "They'll be able to sign in again.", cta: "Reactivate", destructive: false },
  depart: {
    title: "Mark as departed",
    body: "Use when someone leaves the company. Access is removed permanently; their history and attribution are kept.",
    cta: "Mark as departed",
    destructive: true,
  },
};

export function StaffRowActions({
  member,
  roles,
  canResetTwoFactor = false,
  canResetPassword = false,
}: {
  member: Member;
  roles: Role[];
  canResetTwoFactor?: boolean;
  canResetPassword?: boolean;
}) {
  const withStepUp = useStepUp();
  const [resetOpen, setResetOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [name, setName] = useState(member.name);
  const [dialog, setDialog] = useState<StatusChange | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordLink, setPasswordLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function setRole(role: Role) {
    startTransition(async () => {
      const result = await changeRoleAction(member.id, role);
      if (result.ok) toast.success(`${member.name} is now ${ROLE_LABEL[role]}.`);
      else toast.error(result.error);
    });
  }

  function confirmName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await changeNameAction({ staffId: member.id, characterName: name });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`${member.name} is now ${name.trim()}.`);
      setNameOpen(false);
    });
  }

  function reissue() {
    startTransition(async () => {
      const result = await reissueInviteAction(member.id);
      if (result.ok) setLink(result.data);
      else toast.error(result.error);
    });
  }

  function confirmReset() {
    setError(null);
    startTransition(async () => {
      const result = await withStepUp(() => resetTwoFactorAction({ staffId: member.id, reason }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`${member.name}'s two-factor was reset. They'll set it up again at their next sign-in.`);
      setResetOpen(false);
      setReason("");
    });
  }

  function confirmPasswordReset() {
    setError(null);
    startTransition(async () => {
      const result = await withStepUp(() => issuePasswordResetAction({ staffId: member.id, reason }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPasswordOpen(false);
      setReason("");
      setPasswordLink(result.data);
    });
  }

  function confirmStatus() {
    if (!dialog) return;
    setError(null);
    startTransition(async () => {
      const result = await changeStatusAction({ staffId: member.id, change: dialog, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`${COPY[dialog].cta}: ${member.name}`);
      setDialog(null);
      setReason("");
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.name}`} disabled={pending} />}
        >
          {pending ? <Spinner /> : <MoreHorizontal />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {member.status === "invited" ? (
            <DropdownMenuItem onClick={reissue}>
              <Link2 aria-hidden />
              Re-issue invite link
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onClick={() => {
              setName(member.name);
              setError(null);
              setNameOpen(true);
            }}
          >
            <PenLine aria-hidden />
            Change name…
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <UserCog aria-hidden />
              Change role
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={member.role} onValueChange={(v) => setRole(v as Role)}>
                {roles.map((r) => (
                  <DropdownMenuRadioItem key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {canResetPassword ? (
            <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
              <LockKeyhole aria-hidden />
              Reset password…
            </DropdownMenuItem>
          ) : null}
          {canResetTwoFactor ? (
            <DropdownMenuItem onClick={() => setResetOpen(true)}>
              <KeyRound aria-hidden />
              Reset two-factor…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {member.status === "active" ? (
            <DropdownMenuItem onClick={() => setDialog("suspend")}>
              <Ban aria-hidden />
              Suspend access…
            </DropdownMenuItem>
          ) : null}
          {member.status === "suspended" ? (
            <DropdownMenuItem onClick={() => setDialog("reactivate")}>
              <RotateCcw aria-hidden />
              Reactivate…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={() => setDialog("depart")}>
            <LogOut aria-hidden />
            Mark as departed…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog !== null} onOpenChange={(o) => (o ? null : setDialog(null))}>
        <DialogContent className="sm:max-w-md">
          {dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {COPY[dialog].title}: {member.name}
                </DialogTitle>
                <DialogDescription>{COPY[dialog].body}</DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor="reason">Reason</FieldLabel>
                <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
                <FieldDescription>Recorded in the audit log.</FieldDescription>
                {error ? <FieldError>{error}</FieldError> : null}
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Button
                  variant={COPY[dialog].destructive ? "destructive" : "default"}
                  onClick={confirmStatus}
                  disabled={pending || reason.trim().length < 5}
                >
                  {pending ? <Spinner /> : null}
                  {COPY[dialog].cta}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={nameOpen} onOpenChange={(o) => (o ? null : setNameOpen(false))}>
        <DialogContent className="sm:max-w-md">
          <form method="post" onSubmit={confirmName} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Change name: {member.name}</DialogTitle>
              <DialogDescription>
                When their character&rsquo;s name changes in the game. They&rsquo;re recognised by State ID, so only the name shown changes, on past records
                too. Their username stays the same.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="character-name">Character name</FieldLabel>
              <Input id="character-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={64} required />
              <FieldDescription>Recorded in the audit log with the old name.</FieldDescription>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || name.trim().length < 2 || name.trim() === member.name}>
                {pending ? <Spinner /> : null}
                Change name
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={(o) => (o ? null : setResetOpen(false))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset two-factor: {member.name}</DialogTitle>
            <DialogDescription>
              For a lost or replaced phone. Removes their authenticator, backup codes and passkeys and signs them out everywhere. They&rsquo;ll set up a new
              authenticator at their next sign-in. You&rsquo;ll be asked for your own code.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="reset-reason">Reason</FieldLabel>
            <Textarea id="reset-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="e.g. Lost their phone; confirmed in person" />
            <FieldDescription>Recorded in the audit log.</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmReset} disabled={pending || reason.trim().length < 5}>
              {pending ? <Spinner /> : null}
              Reset two-factor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={passwordOpen} onOpenChange={(o) => (o ? null : setPasswordOpen(false))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password: {member.name}</DialogTitle>
            <DialogDescription>
              For a forgotten password. You&rsquo;ll get a one-time link (valid 24 hours) to send them privately; they choose a new password and sign in with
              it and their usual authenticator. Their old password keeps working until they do, and they&rsquo;re signed out everywhere now. You&rsquo;ll be asked
              for your own code.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="password-reason">Reason</FieldLabel>
            <Textarea
              id="password-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. Forgot to save their password at sign-up"
            />
            <FieldDescription>Recorded in the audit log.</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmPasswordReset} disabled={pending || reason.trim().length < 5}>
              {pending ? <Spinner /> : null}
              Create reset link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={passwordLink !== null} onOpenChange={(o) => (o ? null : setPasswordLink(null))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Password reset link for {member.name}</DialogTitle>
            <DialogDescription>Any earlier reset link for this person no longer works.</DialogDescription>
          </DialogHeader>
          {passwordLink ? <InviteLink url={passwordLink.url} expiresAt={passwordLink.expiresAt} /> : null}
          <DialogFooter>
            <Button onClick={() => setPasswordLink(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={link !== null} onOpenChange={(o) => (o ? null : setLink(null))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New invite link for {member.name}</DialogTitle>
            <DialogDescription>Any previous link for this person no longer works.</DialogDescription>
          </DialogHeader>
          {link ? <InviteLink url={link.url} expiresAt={link.expiresAt} /> : null}
          <DialogFooter>
            <Button onClick={() => setLink(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
