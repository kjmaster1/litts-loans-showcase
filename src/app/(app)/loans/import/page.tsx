import type { Metadata } from "next";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { lastPasteByTab } from "@/server/loans/paste";
import { PasteWorkflow } from "./paste-workflow";

export const metadata: Metadata = { title: "Paste phone cards" };

export default async function PasteCardsPage() {
  await requireCapabilityPage("imports.paste");
  const last = await lastPasteByTab();

  return (
    <>
      <PageHeader
        title="Paste phone cards"
        crumbs={[{ label: "Loans", href: "/loans" }]}
        description={
          <>
            Weekly: open <span className="font-medium text-foreground">Business Subscriptions</span> on the phone, copy the whole of each tab
            and paste it here: Active, Overdue, Default and Complete. The cards set each loan&rsquo;s terms and status.
          </>
        }
      />
      <PageBody>
        <PasteWorkflow lastPasted={Object.fromEntries(Object.entries(last).map(([k, v]) => [k, v?.toISOString() ?? null]))} />
      </PageBody>
    </>
  );
}
