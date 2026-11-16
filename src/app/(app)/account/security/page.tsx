import type { Metadata } from "next";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { StatusBadge } from "@/components/data/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ROLE_LABEL } from "@/lib/roles";
import { listMyPasskeys } from "@/server/account/passkeys";
import { listMySessions } from "@/server/account/sessions";
import { requireViewer } from "@/server/authz/viewer";
import { BackupCodesCard } from "./backup-codes-card";
import { ChangePasswordForm } from "./change-password-form";
import { PasskeysCard } from "./passkeys-card";
import { SessionsList } from "./sessions-list";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage() {
  const viewer = await requireViewer();
  const [sessions, passkeys] = await Promise.all([listMySessions(viewer), listMyPasskeys(viewer)]);

  return (
    <>
      <PageHeader
        title="Security"
        description="Manage your password, two-factor authentication, passkeys and where you're signed in."
      />
      <PageBody className="grid max-w-5xl gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Your account</CardTitle>
            <CardDescription>Your name, role and State ID are managed by your manager.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Character</dt>
                <dd className="font-medium">{viewer.characterName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Role</dt>
                <dd className="font-medium">{ROLE_LABEL[viewer.role]}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">State ID</dt>
                <dd className="ident">#{viewer.stateId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Username</dt>
                <dd className="ident">@{viewer.username}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Two-factor authentication</CardTitle>
              <StatusBadge tone="success">On</StatusBadge>
            </div>
            <CardDescription>
              Required for every account. If you lose your authenticator, sign in with a backup code, then ask an
              executive to reset your 2FA.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BackupCodesCard />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Passkeys</CardTitle>
            <CardDescription>
              Sign in with Windows Hello, a fingerprint or your phone instead of your password and code. Your password and authenticator still work as a
              backup.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PasskeysCard passkeys={passkeys.map((p) => ({ ...p, createdAt: p.createdAt?.toISOString() ?? null }))} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>You&rsquo;ll stay signed in here; all other sessions will be signed out.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where you&rsquo;re signed in</CardTitle>
            <CardDescription>Sessions end after 60 minutes of inactivity or 12 hours at most.</CardDescription>
          </CardHeader>
          <CardContent>
            <SessionsList
              sessions={sessions.map((s) => ({
                ...s,
                createdAt: s.createdAt.toISOString(),
                lastActiveAt: s.lastActiveAt.toISOString(),
              }))}
            />
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
