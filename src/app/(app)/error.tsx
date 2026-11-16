"use client"; // Error boundaries must be Client Components

import { RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";

/** A page failed to load (redesign 2026-10, audit #1): say so plainly, offer a retry and a way out. */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <>
      <div className="sticky top-0 z-20 flex h-12 items-center border-b bg-background/90 px-3 sm:px-4">
        <SidebarTrigger className="-ml-0.5" />
      </div>
      <div id="main" tabIndex={-1} className="flex min-h-[60vh] items-center justify-center px-4 outline-none">
        <div className="max-w-md space-y-4 text-center" role="alert">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-danger-subtle text-danger">
            <TriangleAlert className="size-5" aria-hidden />
          </div>
          <div className="space-y-1">
            <h1 className="text-title">This page couldn&rsquo;t load</h1>
            <p className="text-sm text-muted-foreground">
              The server returned an error. Changes you had already saved are kept; anything not yet saved wasn&rsquo;t sent.
            </p>
          </div>
          <div className="flex justify-center gap-2">
            <Button onClick={() => retry()}>
              <RotateCcw aria-hidden /> Try again
            </Button>
            <Button variant="outline" render={<Link href="/" />}>
              Go to the dashboard
            </Button>
          </div>
          {error.digest ? <p className="text-xs text-muted-foreground">Reference: <span className="ident">{error.digest}</span></p> : null}
        </div>
      </div>
    </>
  );
}
