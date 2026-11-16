import { Bell, KeyRound, Keyboard, Plus, Search, type LucideIcon } from "lucide-react";
import { can, SENSITIVE } from "@/lib/permissions";
import { ROLE_LABEL, rankOf, type Role } from "@/lib/roles";
import { ADD_DATA, NAV } from "./nav";

/**
 * The app tour's content (docs/design/TUTORIAL-2026-10-12.md). Pure: which stops a role gets,
 * worded for what that role can actually do. The tour points at the app's own chrome — the
 * sidebar groups, the top bar and the account menu — so it never goes stale as pages change.
 * Each sidebar place links to its page, which opens behind the tour without ending it.
 */

export type TourItem = { title: string; text: string; icon?: LucideIcon; href?: string };
export type TourStep = {
  id: string;
  /** `data-tour` value of the element to point at; null = a card in the middle of the screen. */
  target: string | null;
  /** Where to point instead on a phone, where the sidebar sits behind the menu button. */
  phoneTarget?: string;
  title: string;
  intro?: string;
  items?: TourItem[];
};
export type TourAction = { label: string; href: string };
export type Tour = {
  kind: "full" | "new_role";
  role: Role;
  steps: TourStep[];
  finish: { title: string; text: string; actions: TourAction[] };
};
export type Device = "desktop" | "phone";

const officerOnly = (role: Role) => !can(role, "loans.view_all");

/** What each sidebar place is for, for this role, in a sentence (null: the role doesn't have it). */
function describe(href: string, role: Role): string | null {
  const item = NAV.flatMap((g) => g.items).find((i) => i.href === href);
  if (!item || (item.capability && !can(role, item.capability))) return null;
  const own = officerOnly(role);
  switch (href) {
    case "/":
      return "What needs attention today, the headline figures and the money coming in.";
    case "/my-work":
      return own ? "Your home page: who to chase, what’s due this week, your deals in progress." : "Your own borrowers and deals, if you take some on yourself.";
    case "/loans/collections":
      return `${own ? "Your borrowers" : "Everyone"} behind on payments, most urgent first. Log each call or promise to pay.`;
    case "/loans/legal":
      return own
        ? "Your defaulted loans going to court: fill in the contract details Legal asks for."
        : "Defaulted loans going to court: the case sheet to send, the attorney’s fee, and what’s come back.";
    case "/loans":
      return own ? "Loans you look after: schedule, payments, history." : "Every private loan, from the bank export and the phone’s weekly cards.";
    case "/mortgages":
      return own ? "Mortgages you arranged, and any payment that’s late." : "Every mortgage from the tablet: payments, what’s owed to the State, what Litt’s earns.";
    case "/loans/borrowers":
      return "Look anyone up by name or State ID, with a “Can we lend?” check.";
    case "/finance":
      return "The books: transactions to classify, the ledger, reports, the State allowance and bank imports.";
    case "/commissions":
      return can(role, "commissions.manage") ? "Close each week’s commission and pay it from the pay sheet." : "What you’ve earned this week, and what you’ve been paid.";
    case "/staff":
      return can(role, "staff.reset_password")
        ? "Invite people, change roles, and send a one-time reset link to anyone locked out."
        : "Invite people and change the roles of those below you.";
    case "/settings":
      return can(role, "settings.manage")
        ? "Commission rates, loan rules and mortgage guidelines, plus a full backup download."
        : "Commission rates, loan rules and mortgage guidelines. Executives change them.";
    case "/audit":
      return "Every sign-in and change: who, when and why. Tampering would show.";
    default:
      return null;
  }
}

/** The New menu in a sentence, by what the role may start or bring in (the menu's own items, `ADD_DATA`). */
function newMenu(role: Role): string | null {
  const has = (href: string) => ADD_DATA.some((a) => a.href === href && can(role, a.capability));
  const parts = [
    has("/loans/new") ? "start a loan or a mortgage quote" : null,
    has("/loans/import") ? "paste phone cards or a tablet agreement" : null,
    has("/finance/imports") ? "import a bank export" : null,
  ].filter((p): p is string => p !== null);
  if (!parts.length) return null;
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} and ${parts[parts.length - 1]}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Whether `role` can do anything that asks for an authenticator code. */
const hasSensitive = (role: Role) => [...SENSITIVE].some((c) => can(role, c));

function finish(role: Role, kind: Tour["kind"], device: Device): Tour["finish"] {
  const actions: TourAction[] = can(role, "dashboard.company")
    ? [
        { label: "See what needs attention", href: "/" },
        can(role, "finance.view") ? { label: "Open the books", href: "/finance" } : { label: "Open Collections", href: "/loans/collections" },
        { label: "Open Loans", href: "/loans" },
      ]
    : [
        { label: "Price your first loan", href: "/loans/new" },
        { label: "Paste this week’s phone cards", href: "/loans/import" },
        { label: "Open My work", href: "/my-work" },
      ];
  return {
    title: kind === "new_role" ? "End of what’s new" : "End of the tour",
    text:
      kind === "new_role"
        ? "Everything you could do before works the same way."
        : device === "phone"
          ? "Everything you saw is in the menu. To find a record, tap the magnifier and type a name or State ID."
          : "Everything you saw is in the sidebar. To find a record, press Ctrl K and type a name or State ID.",
    actions,
  };
}

const GROUP_TITLE: Record<string, string> = {
  Work: "Your day",
  Portfolio: "Loans, mortgages and borrowers",
  Money: "Money",
  Admin: "Running the company",
};

/**
 * The tour for `role`. With `since` (the role they last toured as), only what `role` adds or
 * changes; null when there's nothing new.
 */
export function buildTour(role: Role, since: Role | null = null, device: Device = "desktop"): Tour | null {
  const kind: Tour["kind"] = since ? "new_role" : "full";
  const changed = (href: string) => {
    const now = describe(href, role);
    return now !== null && (!since || now !== describe(href, since));
  };

  const steps: TourStep[] = [];
  for (const group of NAV) {
    const items = group.items.filter((i) => changed(i.href)).map((i) => ({ title: i.title, text: describe(i.href, role)!, icon: i.icon, href: i.href }));
    if (!items.length) continue;
    const id = `group-${group.label.toLowerCase()}`;
    steps.push({ id, target: id, phoneTarget: "menu", title: GROUP_TITLE[group.label] ?? group.label, items });
  }

  const menu = newMenu(role);
  if (menu && (!since || menu !== newMenu(since))) {
    const phone = device === "phone";
    steps.push({
      id: "topbar",
      target: "topbar",
      title: "Always at the top",
      items: [
        { title: "Search", icon: Search, text: phone ? "Tap the magnifier to find any borrower, loan, property, person or page." : "Ctrl K (⌘K on a Mac) finds any borrower, loan, property, person or page." },
        {
          title: "Notifications",
          icon: Bell,
          text: can(role, "commissions.manage") ? "What needs you: broken promises to pay, weeks to close, records to check." : "What needs you, such as a borrower who broke a promise to pay.",
        },
        { title: "New", icon: Plus, text: menu },
      ],
    });
  }

  if (!since) {
    steps.push({
      id: "account",
      target: "account",
      phoneTarget: "menu",
      title: "Your account",
      intro: hasSensitive(role) ? "Some actions ask for your authenticator code and a reason. That’s how Litt’s records who changed what." : undefined,
      items: [
        { title: "Security", icon: KeyRound, text: "Password, authenticator and passkeys (sign in with a fingerprint or face).", href: "/account/security" },
        ...(device === "phone" ? [] : [{ title: "Shortcuts", icon: Keyboard, text: "Press ? to see them: / searches a list, G then a letter opens a page." }]),
        { title: "This tour", text: "Take it again any time from this menu." },
      ],
    });
  }

  if (!steps.length) return null;
  return { kind, role, steps, finish: finish(role, kind, device) };
}

/** The welcome card's words for this tour. */
export function welcome(tour: Tour, firstName: string): { title: string; text: string } {
  const role = ROLE_LABEL[tour.role];
  return tour.kind === "new_role"
    ? { title: `You’re now ${role}`, text: "Your new role adds these pages and actions." }
    : { title: `Welcome, ${firstName}`, text: `You’re signed in as ${role}. The tour covers:` };
}

/**
 * Which tour to offer when someone opens the app: the full one if they've never finished or
 * skipped it, the new-role one if they've since been promoted to a role that adds something.
 */
export function tourToOffer(role: Role, completedAt: Date | string | null, touredAs: Role | null, device: Device = "desktop"): Tour | null {
  if (!completedAt) return buildTour(role, null, device);
  // Only a promotion adds anything; a move down or sideways (CEO to COO) has nothing to show.
  if (!touredAs || rankOf(role) <= rankOf(touredAs)) return null;
  return buildTour(role, touredAs, device);
}
