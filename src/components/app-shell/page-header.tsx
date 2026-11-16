import Link from "next/link";
import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { AddDataMenu } from "./add-data-menu";
import { NotificationBell } from "./notification-bell";
import { SearchPalette } from "./search-palette";

export type Crumb = { label: string; href?: string };

/**
 * Page chrome (redesign 2026-10): a slim top bar — sidebar toggle, breadcrumbs only
 * when there's a parent, search and the New menu — then the title block, and an
 * optional tab bar for a section's own pages.
 */
export function PageHeader({
  title,
  description,
  crumbs = [],
  actions,
  tabs,
  meta,
}: {
  title: string;
  description?: React.ReactNode;
  crumbs?: Crumb[];
  actions?: React.ReactNode;
  /** A section's tab bar (e.g. Finance). */
  tabs?: React.ReactNode;
  /** Status badges and facts shown next to the title. */
  meta?: React.ReactNode;
}) {
  return (
    <>
      <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:px-4">
        <SidebarTrigger className="-ml-0.5" data-tour="menu" />
        {crumbs.length ? (
          <>
            <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
            <Breadcrumb className="min-w-0">
              <BreadcrumbList className="flex-nowrap">
                {crumbs.map((c) => (
                  <Fragment key={c.label}>
                    <BreadcrumbItem className="hidden shrink-0 sm:inline-flex">
                      {c.href ? <BreadcrumbLink render={<Link href={c.href} />}>{c.label}</BreadcrumbLink> : c.label}
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden sm:inline-flex" />
                  </Fragment>
                ))}
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate">{title}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </>
        ) : null}
        <div data-tour="topbar" className="ml-auto flex items-center gap-2">
          <SearchPalette />
          <NotificationBell />
          <AddDataMenu />
        </div>
      </header>
      {/* "Skip to content" lands here, on the page title (the layout's <main> holds the whole page). */}
      <div id="main" tabIndex={-1} className={cn("px-4 pt-5 outline-none sm:px-6 lg:px-8", tabs ? "border-b pb-0" : "pb-1")}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-title">{title}</h1>
              {meta}
            </div>
            {description ? <p className="max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? (
            // Phones: one compact row that swipes sideways instead of stacking two rows of buttons.
            <div className="-mx-4 flex shrink-0 items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] max-sm:[&_[data-slot=button]]:h-8 max-sm:[&_[data-slot=button]]:px-2.5 max-sm:[&_[data-slot=button]]:text-[0.8125rem] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
              {actions}
            </div>
          ) : null}
        </div>
        {tabs ? <div className="mt-4">{tabs}</div> : null}
      </div>
    </>
  );
}

export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("px-4 pt-5 pb-12 sm:px-6 lg:px-8", className)}>{children}</div>
  );
}
