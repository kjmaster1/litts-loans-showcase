import type { Metadata } from "next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

const NOTICES: Record<string, { title: string; body: string }> = {
  expired: { title: "Session ended", body: "For security, sessions end after 12 hours. Please sign in again." },
  idle: { title: "Signed out due to inactivity", body: "You were inactive for an hour. Please sign in again." },
  inactive: { title: "Account not active", body: "Your access has been suspended. Contact management." },
  signed_out: { title: "Signed out", body: "You’ve signed out of this device." },
  password_reset: { title: "Password changed", body: "Sign in with your new password and your usual authenticator code." },
};

/** Only same-site relative paths are accepted as a post-login destination. */
function safeNext(value: string | string[] | undefined): string {
  const next = Array.isArray(value) ? value[0] : value;
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const params = await searchParams;
  const reason = typeof params.reason === "string" ? NOTICES[params.reason] : undefined;

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">Use the username and password from your staff invite.</p>
      </div>
      {reason ? (
        <Alert variant="info">
          <AlertTitle>{reason.title}</AlertTitle>
          <AlertDescription>{reason.body}</AlertDescription>
        </Alert>
      ) : null}
      <SignInForm next={safeNext(params.next)} />
    </div>
  );
}
