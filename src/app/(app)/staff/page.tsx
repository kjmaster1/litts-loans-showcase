import type { Metadata } from "next";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LocalTime } from "@/components/data/local-time";
import { StatusBadge, type Tone } from "@/components/data/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can } from "@/lib/permissions";
import { grantableRoles, ROLE_LABEL } from "@/lib/roles";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { listStaff, type StaffRow } from "@/server/staff/service";
import { InviteStaffDialog } from "./invite-staff-dialog";
import { StaffRowActions } from "./staff-row-actions";

export const metadata: Metadata = { title: "Staff" };

const STATUS: Record<StaffRow["status"], { tone: Tone; label: string }> = {
  active: { tone: "success", label: "Active" },
  invited: { tone: "info", label: "Invited" },
  suspended: { tone: "warning", label: "Suspended" },
  departed: { tone: "neutral", label: "Departed" },
};

export default async function StaffPage() {
  const viewer = await requireCapabilityPage("staff.view");
  const rows = await listStaff(viewer);
  const canInvite = can(viewer.role, "staff.manage");
  const roles = grantableRoles(viewer.role);
  const canReset = can(viewer.role, "staff.reset_2fa");
  const canResetPassword = can(viewer.role, "staff.reset_password");
  const current = rows.filter((r) => r.status !== "departed");
  const departed = rows.filter((r) => r.status === "departed");

  return (
    <>
      <PageHeader
        title="Staff"
        description="Everyone with an account. Each person is one RP character, identified by their State ID."
        actions={canInvite && roles.length > 0 ? <InviteStaffDialog roles={roles} /> : null}
      />
      <PageBody className="space-y-8">
        <StaffTable rows={current} roles={roles} canReset={canReset} canResetPassword={canResetPassword} caption="Current staff" />
        {departed.length > 0 ? <StaffTable rows={departed} roles={roles} canReset={false} canResetPassword={false} caption="Former staff" /> : null}
      </PageBody>
    </>
  );
}

function StaffTable({
  rows,
  roles,
  canReset,
  canResetPassword,
  caption,
}: {
  rows: StaffRow[];
  roles: ReturnType<typeof grantableRoles>;
  canReset: boolean;
  canResetPassword: boolean;
  caption: string;
}) {
  return (
    <section aria-label={caption} className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        {caption} <span className="num">({rows.length})</span>
      </h2>
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Role</TableHead>
              <TableHead className="hidden sm:table-cell">State ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">2FA</TableHead>
              <TableHead className="hidden md:table-cell">Last active</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <div className="font-medium">{r.characterName}</div>
                  <div className="text-xs text-muted-foreground">{r.username ? `@${r.username}` : "No login yet"}</div>
                  <div className="text-xs text-muted-foreground sm:hidden">
                    {ROLE_LABEL[r.role]} · <span className="ident">#{r.stateId}</span>
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{ROLE_LABEL[r.role]}</TableCell>
                <TableCell className="ident hidden sm:table-cell">#{r.stateId}</TableCell>
                <TableCell>
                  <StatusBadge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusBadge>
                  {r.status === "invited" && r.inviteExpiresAt ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Link expires <LocalTime value={r.inviteExpiresAt} format="relative" />
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {r.username ? (
                    <StatusBadge tone={r.twoFactorEnabled ? "success" : "warning"}>
                      {r.twoFactorEnabled ? "On" : "Not set up"}
                    </StatusBadge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden text-sm md:table-cell">
                  <LocalTime value={r.lastActiveAt} format="relative" />
                </TableCell>
                <TableCell>
                  {r.manageable && r.status !== "departed" ? (
                    <StaffRowActions
                      member={{ id: r.id, name: r.characterName, role: r.role, status: r.status }}
                      roles={roles}
                      canResetTwoFactor={canReset && r.twoFactorEnabled}
                      canResetPassword={canResetPassword && r.status === "active" && r.username !== null}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
