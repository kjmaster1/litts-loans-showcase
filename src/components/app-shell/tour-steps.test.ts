import { describe, expect, it } from "vitest";
import { can } from "@/lib/permissions";
import { ROLES } from "@/lib/roles";
import { NAV } from "./nav";
import { buildTour, tourToOffer, welcome } from "./tour-steps";

const titles = (role: Parameters<typeof buildTour>[0], since: Parameters<typeof buildTour>[1] = null) =>
  buildTour(role, since)!.steps.flatMap((s) => (s.items ?? []).map((i) => i.title));

describe("app tour", () => {
  it("covers every sidebar place each role can open, and nothing else", () => {
    for (const role of ROLES) {
      const seen = new Set(titles(role));
      for (const item of NAV.flatMap((g) => g.items)) {
        expect(seen.has(item.title), `${role}: ${item.title}`).toBe(!item.capability || can(role, item.capability));
      }
    }
  });

  it("walks a loan officer through their own work and ends at a first loan", () => {
    const tour = buildTour("loan_officer")!;
    expect(tour.steps.map((s) => s.id)).toEqual(["group-work", "group-portfolio", "group-money", "topbar", "account"]);
    expect(titles("loan_officer")).not.toContain("Dashboard");
    expect(tour.steps[1].items!.find((i) => i.title === "Loans")!.text).toMatch(/^Loans you look after/);
    expect(tour.steps.find((s) => s.id === "topbar")!.items!.find((i) => i.title === "New")!.text).toBe("Start a loan or a mortgage quote and paste phone cards or a tablet agreement.");
    // Every sidebar place links to its page.
    expect(tour.steps[0].items!.map((i) => i.href)).toEqual(["/my-work", "/loans/collections", "/loans/legal"]);
    expect(tour.finish.actions[0]).toEqual({ label: "Price your first loan", href: "/loans/new" });
    // Nothing they can do asks for an authenticator code.
    expect(tour.steps.find((s) => s.id === "account")!.intro).toBeUndefined();
  });

  it("tells management what's theirs to change and what executives change", () => {
    const tour = buildTour("management")!;
    expect(tour.steps.map((s) => s.id)).toContain("group-admin");
    const admin = tour.steps.find((s) => s.id === "group-admin")!.items!;
    expect(admin.find((i) => i.title === "Settings")!.text).toMatch(/Executives change them/);
    expect(admin.find((i) => i.title === "Staff")!.text).not.toMatch(/reset/);
    expect(tour.steps.find((s) => s.id === "account")!.intro).toMatch(/authenticator code/);
  });

  it("gives executives the powers only they have", () => {
    const admin = buildTour("ceo")!.steps.find((s) => s.id === "group-admin")!.items!;
    expect(admin.find((i) => i.title === "Staff")!.text).toMatch(/reset/);
    expect(admin.find((i) => i.title === "Settings")!.text).toMatch(/backup/);
    expect(buildTour("ceo")!.steps.find((s) => s.id === "topbar")!.items!.find((i) => i.title === "New")!.text).toMatch(/, and import a bank export\.$/);
  });

  it("after a promotion shows only what the new role adds or changes", () => {
    const tour = buildTour("management", "loan_officer")!;
    expect(tour.kind).toBe("new_role");
    expect(tour.steps.map((s) => s.id)).not.toContain("account");
    expect(titles("management", "loan_officer")).toEqual(expect.arrayContaining(["Dashboard", "Finance", "Staff", "Settings", "Audit log", "Loans"]));
    // Borrowers reads the same for both roles, so it isn't repeated.
    expect(titles("management", "loan_officer")).not.toContain("Borrowers");
    expect(titles("ceo", "management")).toEqual(["Staff", "Settings"]);
    expect(welcome(buildTour("ceo", "management")!, "Kieran").title).toBe("You’re now CEO");
  });

  it("words the tour for a phone: no keyboard shortcuts, the menu button instead of the sidebar", () => {
    const tour = buildTour("loan_officer", null, "phone")!;
    expect(tour.steps.find((s) => s.id === "account")!.items!.map((i) => i.title)).not.toContain("Shortcuts");
    expect(tour.steps.find((s) => s.id === "topbar")!.items![0].text).toMatch(/magnifier/);
    expect(tour.steps.filter((s) => s.id.startsWith("group-")).every((s) => s.phoneTarget === "menu")).toBe(true);
    expect(tour.finish.text).toMatch(/menu/);
  });

  it("offers the full tour once, a new-role tour only after a promotion", () => {
    expect(tourToOffer("legal", null, null)!.kind).toBe("full");
    expect(tourToOffer("legal", "2026-10-12T10:00:00Z", "legal")).toBeNull();
    expect(tourToOffer("management", "2026-10-12T10:00:00Z", "ceo")).toBeNull();
    expect(tourToOffer("coo", "2026-10-12T10:00:00Z", "ceo")).toBeNull();
    expect(tourToOffer("management", "2026-10-12T10:00:00Z", "legal")!.kind).toBe("new_role");
  });
});
