import type { Metadata } from "next";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { LocalTime } from "@/components/data/local-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SETTING_LABELS } from "@/domain/settings";
import { can } from "@/lib/permissions";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { getSettings, settingsHistory } from "@/server/settings";
import { DataCard } from "./data-card";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings" };

const fmt = (path: string, v: number) => (path.endsWith("Days") ? `${v} days` : `${v}%`);

export default async function SettingsPage() {
  const viewer = await requireCapabilityPage("finance.view");
  const canEdit = can(viewer.role, "settings.manage");
  const [current, history] = await Promise.all([getSettings(), settingsHistory()]);

  return (
    <>
      <PageHeader
        title="Settings"
        description={canEdit ? "Company rates and rules. Changes need your authenticator code and a reason." : "Company rates and rules. Only the Owner, CEO and COO can change them."}
      />
      <PageBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          <SettingsForm current={current} canEdit={canEdit} />
        </div>
        <div className="space-y-6">
          <DataCard canExport={canEdit} />
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>History</CardTitle>
              <CardDescription>Every change, newest first. Before the first change the app used the original rates.</CardDescription>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No changes yet.</p>
              ) : (
                <ol className="space-y-4 text-sm">
                  {history.map((h) => (
                    <li key={h.id} className="space-y-1">
                      <div className="text-xs text-muted-foreground">
                        <LocalTime value={h.at} /> · {h.by}
                      </div>
                      <ul className="list-disc pl-5">
                        {h.changes.map((c) => (
                          <li key={c.path}>
                            {SETTING_LABELS[c.path] ?? c.path}: {fmt(c.path, c.from)} → <span className="font-medium">{fmt(c.path, c.to)}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-muted-foreground italic [overflow-wrap:anywhere]">&ldquo;{h.reason}&rdquo;</p>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
