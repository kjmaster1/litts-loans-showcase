"use client";

import { Fingerprint, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { LocalTime } from "@/components/data/local-time";
import { useStepUp } from "@/components/step-up/step-up-provider";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { checkStepUpAction } from "./actions";

type Passkey = { id: string; name: string | null; createdAt: string | null; deviceType: string; backedUp: boolean };

/** WebAuthn errors arrive as DOMException names; turn the common ones into plain English. */
function friendly(message: string | undefined): string {
  if (!message) return "That didn't work. Please try again.";
  if (/NotAllowed|cancel|timed out/i.test(message)) return "Cancelled. Nothing was added.";
  if (/InvalidState|already registered/i.test(message)) return "This device already has a passkey for your account.";
  return message;
}

export function PasskeysCard({ passkeys }: { passkeys: Passkey[] }) {
  const router = useRouter();
  const withStepUp = useStepUp();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function add() {
    setError(null);
    startTransition(async () => {
      const ok = await withStepUp(() => checkStepUpAction());
      if (!ok.ok) return setError(ok.error);
      const r = await authClient.passkey.addPasskey({ name: name.trim() || undefined });
      if (r?.error) return setError(friendly(r.error.message));
      toast.success("Passkey added. You can now sign in with it.");
      setName("");
      router.refresh();
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const r = await authClient.passkey.deletePasskey({ id });
      if (r?.error) return setError(friendly(r.error.message));
      toast.success("Passkey removed.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {passkeys.length ? (
        <ul className="divide-y rounded-lg border">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center gap-3 p-3 text-sm">
              <Fingerprint className="size-4 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{p.name || "Passkey"}</div>
                <div className="text-xs text-muted-foreground">
                  Added <LocalTime value={p.createdAt} format="date" />
                  {p.backedUp ? " · synced across your devices" : " · this device only"}
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${p.name || "passkey"}`} disabled={pending} onClick={() => remove(p.id)}>
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No passkeys yet.</p>
      )}
      <Field>
        <FieldLabel htmlFor="passkey-name">Name (optional)</FieldLabel>
        <Input id="passkey-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Home PC" maxLength={40} />
        <FieldDescription>You&rsquo;ll confirm with your authenticator code, then with Windows Hello, Touch ID or your phone.</FieldDescription>
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      <Button variant="outline" onClick={add} disabled={pending}>
        {pending ? <Spinner /> : <Fingerprint aria-hidden />}
        Add a passkey
      </Button>
    </div>
  );
}
