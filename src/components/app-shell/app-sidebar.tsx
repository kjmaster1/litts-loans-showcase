"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark, Wordmark } from "@/components/brand/logo";
import {
  Sidebar,
  SidebarMenuBadge,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { Role } from "@/lib/roles";
import { can } from "@/lib/permissions";
import type { Viewer } from "@/server/authz/viewer";
import { NAV } from "./nav";
import { UserMenu } from "./user-menu";

function matches(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The most specific nav item matching the path (so /finance/ledger doesn't also light up /finance). */
function activeHref(pathname: string): string | undefined {
  return NAV.flatMap((g) => g.items.map((i) => i.href))
    .filter((href) => matches(pathname, href))
    .sort((a, b) => b.length - a.length)[0];
}

export function AppSidebar({ viewer, badges = {} }: { viewer: Viewer; badges?: Partial<Record<"review", number>> }) {
  const pathname = usePathname();
  const current = activeHref(pathname);
  const role: Role = viewer.role;

  return (
    <Sidebar collapsible="icon">
      {/* The whole sidebar is the app's navigation landmark (logo, places and the user menu). */}
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" aria-label="Litt's Loans home" />}>
              <LogoMark className="size-8!" />
              <Wordmark className="text-lg" inverse />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV.map((group) => {
          const items = group.items.filter((item) => !item.capability || can(role, item.capability));
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.label} data-tour={`group-${group.label.toLowerCase()}`}>
              <SidebarGroupLabel className="text-[0.6875rem] font-semibold tracking-wider text-sidebar-muted-foreground uppercase">{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => {
                    const active = item.href === current;
                    const badge = item.badge ? badges[item.badge] : undefined;
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          isActive={active}
                          tooltip={item.title}
                          // The current page: a brand-green bar as well as the highlight, so it doesn't rely on a subtle shade alone.
                          className="relative text-sidebar-foreground/90 data-active:before:absolute data-active:before:inset-y-1.5 data-active:before:left-0 data-active:before:w-0.5 data-active:before:rounded-full data-active:before:bg-sidebar-primary data-active:[&_svg]:text-sidebar-primary"
                          render={<Link href={item.href} aria-current={active ? "page" : undefined} />}
                        >
                          <item.icon aria-hidden />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                        {badge ? (
                          <SidebarMenuBadge className="bg-[oklch(0.81_0.144_79.3)] font-semibold text-[oklch(0.175_0.004_164.6)]" aria-label={`${badge} transactions need review`}>
                            {badge}
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter data-tour="account">
        <UserMenu viewer={viewer} />
      </SidebarFooter>
      </nav>
      <SidebarRail />
    </Sidebar>
  );
}
