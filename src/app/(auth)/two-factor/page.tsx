import type { Metadata } from "next";
import { TwoFactorForm } from "./two-factor-form";

export const metadata: Metadata = { title: "Verify it's you" };

function safeNext(value: string | string[] | undefined): string {
  const next = Array.isArray(value) ? value[0] : value;
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export default async function TwoFactorPage({ searchParams }: PageProps<"/two-factor">) {
  const params = await searchParams;
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Verify it&rsquo;s you</h1>
        <p className="text-sm text-muted-foreground">
          Enter the 6-digit code from your authenticator app.
        </p>
      </div>
      <TwoFactorForm next={safeNext(params.next)} />
    </div>
  );
}
