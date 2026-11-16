import type { Metadata } from "next";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { requireCapabilityPage } from "@/server/authz/viewer";
import { TabletWorkflow } from "./tablet-workflow";

export const metadata: Metadata = { title: "Paste from tablet" };

export default async function TabletPastePage() {
  await requireCapabilityPage("imports.paste");
  return (
    <>
      <PageHeader
        title="Paste from tablet"
        crumbs={[{ label: "Mortgages", href: "/mortgages" }]}
        description={
          <>
            On the tablet, open a <span className="font-medium text-foreground">Sale Agreement</span>, copy everything from the address down to
            &ldquo;After Tax&rdquo; and paste it here. You can paste several agreements one after another.
          </>
        }
      />
      <PageBody>
        <TabletWorkflow />
      </PageBody>
    </>
  );
}
