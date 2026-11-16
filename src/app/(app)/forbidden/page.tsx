import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { requireViewer } from "@/server/authz/viewer";

export const metadata: Metadata = { title: "No access" };

export default async function ForbiddenPage() {
  await requireViewer();
  return (
    <>
      <PageHeader title="No access" />
      <PageBody>
        <Empty className="rounded-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock />
            </EmptyMedia>
            <EmptyTitle>You don&rsquo;t have access to that page</EmptyTitle>
            <EmptyDescription>
              Your role doesn&rsquo;t include this area. If you think it should, ask a manager.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link href="/" />}>Back to dashboard</Button>
          </EmptyContent>
        </Empty>
      </PageBody>
    </>
  );
}
