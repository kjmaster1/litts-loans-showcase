"use client";

import { ChevronsUpDown, Compass, Keyboard, LogOut, Monitor, Moon, ShieldCheck, Sun } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { OPEN_SHORTCUTS } from "./keyboard-shortcuts";
import { START_TOUR } from "./app-tour";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { ROLE_LABEL } from "@/lib/roles";
import type { Viewer } from "@/server/authz/viewer";

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

export async function signOutAndLeave(router: ReturnType<typeof useRouter>, reason: "signed_out" | "idle") {
  await authClient.signOut();
  router.replace(`/sign-in?reason=${reason}`);
  router.refresh();
}

export function UserMenu({ viewer }: { viewer: Viewer }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent"
                aria-label={`Account menu for ${viewer.characterName}`}
              />
            }
          >
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="rounded-lg bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
                {initials(viewer.characterName)}
              </AvatarFallback>
            </Avatar>
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{viewer.characterName}</span>
              <span className="truncate text-xs text-sidebar-muted-foreground">{ROLE_LABEL[viewer.role]}</span>
            </span>
            <ChevronsUpDown className="ml-auto size-4 text-sidebar-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="min-w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <div className="text-sm font-medium text-foreground">{viewer.characterName}</div>
                <div className="text-xs text-muted-foreground">
                  {ROLE_LABEL[viewer.role]} · <span className="ident">#{viewer.stateId}</span> · @{viewer.username}
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/account/security" />}>
              <ShieldCheck aria-hidden />
              Security settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(OPEN_SHORTCUTS))}>
              <Keyboard aria-hidden />
              Keyboard shortcuts
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(START_TOUR))}>
              <Compass aria-hidden />
              Take the tour
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={(v) => setTheme(String(v))}>
                <DropdownMenuRadioItem value="light">
                  <Sun aria-hidden /> Light
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  <Moon aria-hidden /> Dark
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">
                  <Monitor aria-hidden /> System
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => signOutAndLeave(router, "signed_out")}>
              <LogOut aria-hidden />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
