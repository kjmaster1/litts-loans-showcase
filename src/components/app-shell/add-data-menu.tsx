"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { can } from "@/lib/permissions";
import { ADD_DATA } from "./nav";
import { useShell } from "./shell-context";

const GROUPS = [
  { key: "start", label: "Start a deal" },
  { key: "import", label: "Bring in data" },
] as const;

/**
 * "New" (redesign 2026-10; renamed in the UX review of 2026-10-12): start a loan or quote, or
 * paste/import data. An outline button, so each page's own primary action is the one filled
 * button on screen.
 */
export function AddDataMenu() {
  const { role } = useShell();
  const items = ADD_DATA.filter((a) => can(role, a.capability));
  if (items.length === 0) return null;
  const groups = GROUPS.map((g) => ({ ...g, items: items.filter((a) => a.group === g.key) })).filter((g) => g.items.length);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8 gap-1.5" aria-label="New: start a deal or bring in data" />}>
        <Plus aria-hidden />
        <span className="hidden sm:inline">New</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        {groups.map((g, i) => (
          <Fragment key={g.key}>
            {i > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{g.label}</DropdownMenuLabel>
              {g.items.map((a) => (
                <DropdownMenuItem
                  key={a.href}
                  render={<Link href={a.href} />}
                  className="items-start gap-2.5 py-2"
                  aria-label={a.title}
                  aria-describedby={`add-data-${a.href.replace(/\W/g, "")}`}
                >
                  <a.icon aria-hidden className="mt-0.5" />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{a.title}</span>
                    <span id={`add-data-${a.href.replace(/\W/g, "")}`} className="text-xs text-muted-foreground">
                      {a.description}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
