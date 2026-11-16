import { SearchX } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";

/** Inside the app frame, so the sidebar and search stay available. */
export default function NotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <PageBody className="flex min-h-[50vh] items-center justify-center">
        <div className="max-w-md space-y-4 text-center">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <SearchX className="size-5" aria-hidden />
          </div>
          <p className="text-sm text-muted-foreground">
            There&rsquo;s nothing at this address. It may have been mistyped, or the record may not exist. Use search (Ctrl K) to find what you&rsquo;re looking for.
          </p>
          <Button variant="outline" render={<Link href="/" />}>
            Go to the dashboard
          </Button>
        </div>
      </PageBody>
    </>
  );
}
