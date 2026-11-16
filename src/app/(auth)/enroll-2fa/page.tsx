import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireViewer } from "@/server/authz/viewer";
import { EnrollTwoFactor } from "./enroll-two-factor";

export const metadata: Metadata = { title: "Set up two-factor authentication" };

export default async function EnrollTwoFactorPage() {
  const viewer = await requireViewer({ allowUnenrolled: true });
  if (viewer.twoFactorEnabled) redirect("/");

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <p className="text-xs font-medium tracking-wide text-primary uppercase">Required</p>
        <h1 className="text-2xl font-semibold tracking-tight">Set up two-factor authentication</h1>
        <p className="text-sm text-muted-foreground">
          Every Litt&rsquo;s Loans account needs an authenticator app (Google Authenticator, Microsoft Authenticator,
          1Password, Authy…). You&rsquo;ll enter a code from it each time you sign in.
        </p>
      </div>
      <EnrollTwoFactor username={viewer.username} />
    </div>
  );
}
