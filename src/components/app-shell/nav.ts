import {
  ArrowLeftRight,
  BookOpenText,
  ClipboardList,
  ClipboardPaste,
  Coins,
  FileSpreadsheet,
  FilePlus2,
  FileSignature,
  FileUp,
  Gauge,
  Gavel,
  HandCoins,
  House,
  Landmark,
  LayoutDashboard,
  PhoneCall,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  TabletSmartphone,
  UserSearch,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Capability } from "@/lib/permissions";

/**
 * Navigation (redesign 2026-10): ten places in the sidebar. Actions that add data
 * live in the top bar's "New" menu and on their pages; Finance's sub-pages
 * are a tab bar inside Finance. Items appear only to roles holding the
 * capability — the server enforces the same rule.
 */
export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  capability?: Capability;
  /** Key into the badge counts passed from the layout. */
  badge?: "review";
  /** Other paths that light this item up (e.g. Loans for /loans/import). */
  also?: string[];
};
export type NavGroup = { label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    label: "Work",
    items: [
      { title: "Dashboard", href: "/", icon: LayoutDashboard, capability: "dashboard.company" },
      { title: "My work", href: "/my-work", icon: ClipboardList, capability: "loans.originate" },
      { title: "Collections", href: "/loans/collections", icon: PhoneCall },
      { title: "Legal cases", href: "/loans/legal", icon: Gavel },
    ],
  },
  {
    label: "Portfolio",
    items: [
      { title: "Loans", href: "/loans", icon: HandCoins },
      { title: "Mortgages", href: "/mortgages", icon: House },
      { title: "Borrowers", href: "/loans/borrowers", icon: UserSearch, capability: "borrower.lookup" },
    ],
  },
  {
    label: "Money",
    items: [
      { title: "Finance", href: "/finance", icon: Landmark, capability: "finance.view", badge: "review" },
      { title: "Commissions", href: "/commissions", icon: Coins },
    ],
  },
  {
    label: "Admin",
    items: [
      { title: "Staff", href: "/staff", icon: Users, capability: "staff.view" },
      { title: "Settings", href: "/settings", icon: SlidersHorizontal, capability: "finance.view" },
      { title: "Audit log", href: "/audit", icon: ScrollText, capability: "audit.view" },
    ],
  },
];

/** Finance's own sections, shown as a tab bar on its pages. */
export const FINANCE_TABS: { title: string; href: string; icon: LucideIcon; capability?: Capability }[] = [
  { title: "Overview", href: "/finance", icon: Landmark },
  { title: "Transactions", href: "/finance/transactions", icon: ArrowLeftRight },
  { title: "Ledger", href: "/finance/ledger", icon: BookOpenText },
  { title: "Reports", href: "/finance/reports", icon: FileSpreadsheet },
  { title: "State allowance", href: "/finance/allowance", icon: Gauge },
  { title: "Imports", href: "/finance/imports", icon: FileUp, capability: "bank.import" },
];

/** Things that start a deal or bring data in — the top bar's "New" menu and the search palette. */
export const ADD_DATA: { title: string; description: string; href: string; icon: LucideIcon; capability: Capability; group: "start" | "import" }[] = [
  { title: "New loan", description: "Price it and write the contract", href: "/loans/new", icon: FilePlus2, capability: "loans.originate", group: "start" },
  { title: "New mortgage quote", description: "Terms to type into the tablet", href: "/mortgages/quotes/new", icon: FileSignature, capability: "loans.originate", group: "start" },
  { title: "Paste phone cards", description: "Weekly loan cards from the phone", href: "/loans/import", icon: ClipboardPaste, capability: "imports.paste", group: "import" },
  { title: "Paste from tablet", description: "A mortgage's sale agreement", href: "/mortgages/import", icon: TabletSmartphone, capability: "imports.paste", group: "import" },
  { title: "Import bank export", description: "The business wallet's .xlsx", href: "/finance/imports", icon: FileUp, capability: "bank.import", group: "import" },
];

/** Pages offered by the search palette beyond the sidebar's. */
export const EXTRA_PAGES: { title: string; href: string; icon: LucideIcon; capability?: Capability }[] = [
  ...FINANCE_TABS.slice(1),
  { title: "Loan offers", href: "/loans/offers", icon: FileSignature, capability: "loans.originate" },
  { title: "Mortgage quotes", href: "/mortgages/quotes", icon: FileSignature, capability: "loans.originate" },
  { title: "Security", href: "/account/security", icon: ShieldCheck },
];
