import type { Metadata } from "next";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ROLE_LABEL } from "@/lib/roles";
import { findPendingInvite } from "@/server/staff/invites";
import { AcceptInviteForm } from "./accept-invite-form";

export const metadata: Metadata = { title: "Accept invite" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const invite = await findPendingInvite(token);

  if (!invite) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Invite unavailable</h1>
        <Alert variant="danger">
          <AlertTitle>This link can&rsquo;t be used</AlertTitle>
          <AlertDescription>
            It may have expired (links last 48 hours), been replaced by a newer invite, or already been used. Ask a
            manager to send a new one.
          </AlertDescription>
        </Alert>
        <Link href="/sign-in" className="text-sm text-primary underline-offset-4 hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Set up your account</h1>
        <p className="text-sm text-muted-foreground">
          You&rsquo;ve been invited to join Litt&rsquo;s Loans as{" "}
          <span className="font-medium text-foreground">{ROLE_LABEL[invite.role]}</span>.
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border text-sm">
        <div className="bg-card px-3 py-2">
          <dt className="text-xs text-muted-foreground">Character</dt>
          <dd className="font-medium">{invite.characterName}</dd>
        </div>
        <div className="bg-card px-3 py-2">
          <dt className="text-xs text-muted-foreground">State ID</dt>
          <dd className="ident">#{invite.stateId}</dd>
        </div>
      </dl>
      <AcceptInviteForm token={token} />
    </div>
  );
}
