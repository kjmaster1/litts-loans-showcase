"use client";

import { createContext, useContext, useState } from "react";
import type { Role } from "@/lib/roles";
import type { Notification } from "@/server/notifications";

/** The bell's list as last fetched or marked read, and the layout's list it replaced. */
export type BellState = { from: Notification[]; items: Notification[] } | null;

type Shell = { role: Role; staffId: string; notifications: Promise<Notification[]> };

/** What the shell's client widgets (search, Add data, the bell) need to know about the viewer. */
const ShellContext = createContext<(Shell & { bell: BellState; setBell: React.Dispatch<React.SetStateAction<BellState>> }) | null>(null);

export function ShellProvider({ role, staffId, notifications, children }: Shell & { children: React.ReactNode }) {
  // Held here, not in the bell: the bell is in each page's header and remounts on every navigation, while the
  // layout's list isn't fetched again — kept in the bell, what was read came back as new on the next page.
  const [bell, setBell] = useState<BellState>(null);
  return <ShellContext.Provider value={{ role, staffId, notifications, bell, setBell }}>{children}</ShellContext.Provider>;
}

export function useShell() {
  const v = useContext(ShellContext);
  if (!v) throw new Error("useShell outside ShellProvider");
  return v;
}
