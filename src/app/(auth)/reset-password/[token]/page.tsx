import type { Metadata } from "next";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { findPasswordReset } from "@/server/staff/password-reset";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ params }: PageProps<"/reset-password/[token]">) {
  const { token } = await params;
  const reset = await findPasswordReset(token);

  if (!reset) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Link unavailable</h1>
        <Alert variant="danger">
          <AlertTitle>This link can&rsquo;t be used</AlertTitle>
          <AlertDescription>
            It may have expired (links last 24 hours), been replaced by a newer one, or already been used. Ask an executive to send a new one.
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
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="text-sm text-muted-foreground">Your old password stops working. Your authenticator stays the same.</p>
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border text-sm">
        <div className="bg-card px-3 py-2">
          <dt className="text-xs text-muted-foreground">Character</dt>
          <dd className="font-medium">{reset.characterName}</dd>
        </div>
        <div className="bg-card px-3 py-2">
          <dt className="text-xs text-muted-foreground">Username</dt>
          <dd className="ident">{reset.username ?? "—"}</dd>
        </div>
      </dl>
      <ResetPasswordForm token={token} username={reset.username} />
    </div>
  );
}
