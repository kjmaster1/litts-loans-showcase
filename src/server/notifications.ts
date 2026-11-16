import "server-only";
import { dateFormat } from "@/lib/dates";
import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { CATCH_UP_KEY, periodLabel, periodRange, weeksSinceStart } from "@/domain/commissions/week";
import { writeOffEligibleAt } from "@/domain/loans/status";
import { quoteApproval } from "@/domain/mortgages/approval";
import { FEDERAL_MAXIMUMS_FROM } from "@/domain/mortgages/federal";
import { quoteMortgage } from "@/domain/origination/mortgage-quote";
import { LIVE_QUOTE_STATUSES } from "@/domain/origination/quote-status";
import { mortgageGuidelines } from "@/domain/mortgages/schedule";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import type { Viewer } from "@/server/authz/viewer";
import { unconfirmedRecords } from "@/server/data-quality";
import { db } from "@/server/db";
import { commissionWeek, liveLoan, loan, mortgage, mortgageQuote, mortgageQuoteNote, notificationRead, staff } from "@/server/db/schema";
import { collectionsQueueForRequest } from "@/server/loans/collections";
import { unapprovedMortgages } from "@/server/mortgages/approval";
import { inputOf } from "@/server/origination/mortgage-quotes";
import { getServerOutlook } from "@/server/mortgages/allowance-outlook";
import { getSettings } from "@/server/settings";
import { listCases } from "@/server/legal/cases";
import { ACTIVE_FEE_LINKS } from "@/server/legal/fees";

/**
 * The bell (research/12): things that need someone's attention, worked out fresh
 * from the data each time — nothing is sent anywhere. A notification goes away by
 * itself once the situation is resolved; "read" only stops it counting as new.
 * Officers see their own cases; Management+ everything (same visibility as the lists).
 */

export type Notification = {
  key: string;
  kind:
    | "broken_promise"
    | "follow_up"
    | "write_off"
    | "close_week"
    | "unconfirmed_record"
    | "federal_breach"
    | "quote_changes"
    | "quote_reply"
    | "quote_approval"
    | "quote_approved"
    | "quote_signing_passed"
    | "quote_awaiting_tablet"
    | "quote_pushed_short"
    | "unapproved_mortgage"
    | "legal_details_requested"
    | "legal_fee_unpaid";
  title: string;
  detail: string;
  href: string;
  /** When it became due — the list is newest first. */
  at: Date;
  read: boolean;
};

const DATE = dateFormat({ timeZone: "Europe/London", day: "numeric", month: "short" });
const LIMIT = 40;
/** How long a reply or an approval stays in the bell. */
const RECENT_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;
const clip = (t: string, n = 140) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export async function notificationsFor(viewer: Viewer, now: Date = new Date()): Promise<Notification[]> {
  const items: Omit<Notification, "read">[] = [];

  const queue = await collectionsQueueForRequest(viewer);
  for (const r of queue) {
    for (const b of r.broken) {
      items.push({
        key: `broken:${b.id}`,
        kind: "broken_promise",
        title: `${r.borrower} broke a promise to pay`,
        detail: `${formatCents(b.promiseCents ?? 0)} by ${DATE.format(b.promiseBy!)}; ${b.outcome?.paidCents ? `${formatCents(b.outcome.paidCents)} paid` : "nothing paid"}.`,
        href: r.href,
        at: new Date(Date.UTC(b.promiseBy!.getUTCFullYear(), b.promiseBy!.getUTCMonth(), b.promiseBy!.getUTCDate() + 1)),
      });
    }
    const last = r.last;
    if (r.status !== "written_off" && last?.nextActionAt && last.nextActionAt <= now && last.outcome?.state !== "broken") {
      items.push({
        key: `followup:${last.id}`,
        kind: "follow_up",
        title: `Follow up with ${r.borrower}`,
        detail: `${r.type === "mortgage" ? "Mortgage" : "Loan"}${r.missed ? ` · ${r.missed} missed` : ""} · due ${DATE.format(last.nextActionAt)}`,
        href: r.href,
        at: last.nextActionAt,
      });
    }
  }

  if (can(viewer.role, "loans.charge_off")) {
    const days = (await getSettings()).loans.writeOffAfterDays;
    const rows = await db
      .select({ id: loan.id, name: loan.borrowerName, stateId: loan.borrowerStateId, firstDefaultAt: loan.firstDefaultAt })
      .from(loan)
      .where(and(liveLoan, eq(loan.status, "defaulted"), sql`${loan.firstDefaultAt} <= ${new Date(now.getTime() - days * 86_400_000)}`));
    // One notification for the lot; it comes back as new whenever another loan becomes eligible.
    if (rows.length) {
      const eligible = rows.map((l) => ({ ...l, at: writeOffEligibleAt(l.firstDefaultAt!, days) })).sort((a, b) => b.at.getTime() - a.at.getTime());
      const newest = eligible[0];
      items.push({
        key: `writeoff:${rows.length}:${newest.at.toISOString().slice(0, 10)}`,
        kind: "write_off",
        title: rows.length === 1 ? `${newest.name ?? `State ID ${newest.stateId}`} can be written off` : `${rows.length} defaulted loans can be written off`,
        detail: rows.length === 1 ? `Defaulted over ${days} days ago` : `Latest: ${newest.name ?? `State ID ${newest.stateId}`}. Review them on the Loans page.`,
        href: rows.length === 1 ? `/loans/${newest.id}` : "/loans?status=defaulted",
        at: newest.at,
      });
    }
  }

  if (can(viewer.role, "records.merge")) {
    for (const r of await unconfirmedRecords()) {
      const who = r.borrowerName ?? (r.borrowerStateId ? `State ID ${r.borrowerStateId}` : "unknown");
      items.push({
        key: `unconfirmed:${r.kind}:${r.id}`,
        kind: "unconfirmed_record",
        title: r.kind === "mortgage" ? `“${r.label}” isn’t in the bank data` : `${who}’s ${formatCents(r.principalCents ?? 0)} loan isn’t in the bank data`,
        detail: `${r.kind === "mortgage" ? `Mortgage for ${who}, pasted` : "Added from a phone card"} ${DATE.format(r.createdAt)}; the bank export has moved past it. Duplicate or typo?`,
        href: r.href,
        at: r.createdAt,
      });
    }
  }

  // Over the federal maximums (owner, 2026-10-15): the tablet can't be stopped, so the executives are told.
  if (can(viewer.role, "settings.manage")) {
    const g = (await getSettings()).mortgages;
    const rows = await db
      .select()
      .from(mortgage)
      .where(and(isNull(mortgage.mergedIntoId), eq(mortgage.funding, "state"), gte(mortgage.originatedAt, FEDERAL_MAXIMUMS_FROM)));
    for (const m of rows) {
      const over = mortgageGuidelines(m, { buyerHasOtherMortgage: false, funding: m.funding, originatedAt: m.originatedAt }, g).filter((f) => f.rule === "federal_maximum");
      if (!over.length) continue;
      items.push({
        key: `federal:${m.id}:${m.brokerFeeCents ?? ""}:${m.brokerRateBp ?? ""}`,
        kind: "federal_breach",
        title: `${m.address} is over the federal maximums`,
        detail: `${over.map((f) => f.text).join(". ")}. Arranged by ${m.officerName ?? "an unknown officer"}.`,
        href: `/mortgages/${m.id}`,
        at: m.originatedAt!,
      });
    }
  }

  // Quote review (research/18). The officer: notes asking for changes on their open quotes, until done.
  const note = mortgageQuoteNote;
  const done = alias(mortgageQuoteNote, "done");
  const author = alias(staff, "author");
  const asked = await db
    .select({ id: note.id, text: note.text, at: note.at, by: author.characterName, quoteId: mortgageQuote.id, number: mortgageQuote.number })
    .from(note)
    .innerJoin(mortgageQuote, eq(mortgageQuote.id, note.quoteId))
    .leftJoin(done, eq(done.resolvesId, note.id))
    .leftJoin(author, eq(author.id, note.staffId))
    .where(and(isNull(note.resolvesId), isNull(done.id), inArray(mortgageQuote.status, [...LIVE_QUOTE_STATUSES]), eq(mortgageQuote.officerStaffId, viewer.staffId)));
  for (const n of asked) {
    items.push({
      key: `quote-note:${n.id}`,
      kind: "quote_changes",
      title: `${n.by ?? "Management"} asked for changes on quote #${n.number}`,
      detail: clip(n.text),
      href: `/mortgages/quotes/${n.quoteId}`,
      at: n.at,
    });
  }
  // The note's author: the answer, for a week.
  const original = alias(mortgageQuoteNote, "original");
  const replies = await db
    .select({ id: note.id, text: note.text, at: note.at, by: author.characterName, quoteId: mortgageQuote.id, number: mortgageQuote.number })
    .from(note)
    .innerJoin(original, eq(original.id, note.resolvesId))
    .innerJoin(mortgageQuote, eq(mortgageQuote.id, note.quoteId))
    .leftJoin(author, eq(author.id, note.staffId))
    .where(and(eq(original.staffId, viewer.staffId), ne(note.staffId, viewer.staffId), gte(note.at, new Date(now.getTime() - RECENT_MS))));
  for (const r of replies) {
    items.push({
      key: `quote-reply:${r.id}`,
      kind: "quote_reply",
      title: r.text ? `${r.by ?? "The officer"} replied on quote #${r.number}` : `${r.by ?? "The officer"} marked your note on quote #${r.number} done`,
      detail: r.text ? clip(r.text) : "No reply.",
      href: `/mortgages/quotes/${r.quoteId}`,
      at: r.at,
    });
  }

  // Large mortgages (research/18). The officer: their quote was approved, for a week while it's open.
  const approverStaff = alias(staff, "approver");
  const approved = await db
    .select({ q: mortgageQuote, by: approverStaff.characterName })
    .from(mortgageQuote)
    .leftJoin(approverStaff, eq(approverStaff.id, mortgageQuote.approvedByStaffId))
    .where(
      and(
        inArray(mortgageQuote.status, [...LIVE_QUOTE_STATUSES]),
        eq(mortgageQuote.officerStaffId, viewer.staffId),
        ne(mortgageQuote.approvedByStaffId, viewer.staffId),
        gte(mortgageQuote.approvedAt, new Date(now.getTime() - RECENT_MS)),
      ),
    );
  for (const { q, by } of approved) {
    items.push({
      key: `quote-approved:${q.id}:${q.approvedAt!.toISOString()}`,
      kind: "quote_approved",
      title: `${by ?? "An executive"} approved quote #${q.number}`,
      detail: `${q.address}: it can go on the tablet now.`,
      href: `/mortgages/quotes/${q.id}`,
      at: q.approvedAt!,
    });
  }

  if (can(viewer.role, "mortgages.approve_large")) {
    const g = (await getSettings()).mortgages;
    const officer = alias(staff, "quote_officer");
    const open = await db
      .select({ q: mortgageQuote, officerName: officer.characterName })
      .from(mortgageQuote)
      .leftJoin(officer, eq(officer.id, mortgageQuote.officerStaffId))
      .where(and(inArray(mortgageQuote.status, [...LIVE_QUOTE_STATUSES]), isNull(mortgageQuote.approvedAt)));
    for (const { q, officerName } of open) {
      const base = quoteMortgage(inputOf(q)).baseCents;
      if (quoteApproval({ baseCents: base, approvedAt: q.approvedAt }, g) !== "needed") continue;
      items.push({
        // Comes back as new if the terms change after an approval was cleared.
        key: `quote-approval:${q.id}:${q.updatedAt.toISOString()}`,
        kind: "quote_approval",
        title: `Quote #${q.number} needs an executive’s approval`,
        detail: `${q.address}, ${formatCents(base)} down payment + loan. Quoted by ${officerName ?? "an officer"}.`,
        href: `/mortgages/quotes/${q.id}`,
        at: q.updatedAt,
      });
    }
    for (const { m, officer: arrangedBy, flag } of await unapprovedMortgages()) {
      items.push({
        key: `unapproved:${m.id}`,
        kind: "unapproved_mortgage",
        title: `${m.address} wasn’t approved by an executive`,
        detail: `Arranged by ${arrangedBy ?? "an unknown officer"}: ${flag.text.replace("Not approved by an executive: ", "")}.`,
        href: `/mortgages/${m.id}`,
        at: m.originatedAt ?? m.createdAt,
      });
    }
  }

  // Confirmed quotes (research/19 §5). The officer and management: a signing that has passed, or a signed quote still
  // waiting for its tablet agreement. The officer alone: a colleague's confirmation pushed their quote short.
  if (can(viewer.role, "loans.originate")) {
    const quoteOfficer = alias(staff, "confirmed_officer");
    const confirmed = await db
      .select({ q: mortgageQuote, officerName: quoteOfficer.characterName })
      .from(mortgageQuote)
      .leftJoin(quoteOfficer, eq(quoteOfficer.id, mortgageQuote.officerStaffId))
      .where(eq(mortgageQuote.status, "confirmed"));
    const overseer = can(viewer.role, "loans.reassign_officer");
    const stale = now.getTime() - HOUR_MS;
    for (const { q } of confirmed) {
      if (!overseer && q.officerStaffId !== viewer.staffId) continue;
      const href = `/mortgages/quotes/${q.id}`;
      if (q.signedAt && q.signedAt.getTime() < stale) {
        items.push({
          key: `quote-tablet:${q.id}`,
          kind: "quote_awaiting_tablet",
          title: `Paste the tablet agreement for quote #${q.number}`,
          detail: `${q.address}: signed in game ${DATE.format(q.signedAt)}. Paste the tablet agreement so it becomes a mortgage.`,
          href,
          at: q.signedAt,
        });
      } else if (!q.signedAt && q.expectedSigningAt && q.expectedSigningAt.getTime() < stale) {
        items.push({
          key: `quote-signing:${q.id}:${q.expectedSigningAt.toISOString()}`,
          kind: "quote_signing_passed",
          title: `Did quote #${q.number} sign?`,
          detail: `${q.address}: the bidding closed ${DATE.format(q.expectedSigningAt)}. Mark it signed, move the time, or cancel it.`,
          href,
          at: q.expectedSigningAt,
        });
      }
    }
    // Pushed short: only an officer's own unsigned quotes, and the outlook is worked out once, only if there is one.
    const mine = confirmed.filter(({ q }) => q.officerStaffId === viewer.staffId && !q.signedAt && q.confirmedAt);
    const outlook = mine.length ? await getServerOutlook(now) : null;
    if (outlook) {
      const byId = new Map(confirmed.map(({ q, officerName }) => [q.id, { q, officerName }]));
      for (const { q } of mine) {
        const own = outlook.confirmed.find((c) => c.quoteId === q.id);
        if (!own || own.verdict !== "short") continue;
        const pushers = outlook.confirmed
          .filter((c) => c.quoteId !== q.id && c.signingAt.getTime() < own.signingAt.getTime())
          .map((c) => byId.get(c.quoteId))
          .filter((x): x is NonNullable<typeof x> => !!x?.q.confirmedAt && x.q.confirmedAt.getTime() > q.confirmedAt!.getTime())
          .sort((a, b) => b.q.confirmedAt!.getTime() - a.q.confirmedAt!.getTime());
        const latest = pushers[0];
        if (!latest) continue;
        items.push({
          key: `quote-short:${q.id}:${latest.q.confirmedAt!.toISOString()}`,
          kind: "quote_pushed_short",
          title: `Quote #${q.number} no longer fits the allowance`,
          detail: `#${latest.q.number} (${latest.officerName ?? "another officer"}) now signs first. Short by ${formatCents(Math.max(0, -own.afterCents))}.`,
          href: `/mortgages/quotes/${q.id}`,
          at: latest.q.confirmedAt!,
        });
      }
    }
  }

  if (can(viewer.role, "commissions.manage")) {
    const keys = [CATCH_UP_KEY, ...weeksSinceStart(now)].filter((k) => periodRange(k).to <= now);
    const closed = keys.length
      ? new Set((await db.select({ k: commissionWeek.weekKey }).from(commissionWeek).where(and(inArray(commissionWeek.weekKey, keys), eq(commissionWeek.status, "closed")))).map((r) => r.k))
      : new Set<string>();
    for (const k of keys.filter((k) => !closed.has(k))) {
      items.push({
        key: `week:${k}`,
        kind: "close_week",
        title: k === CATCH_UP_KEY ? "Close the catch-up period" : "Close the commission week",
        detail: `${periodLabel(k)} has ended. Close it to pay commission.`,
        href: `/commissions/${k}`,
        at: periodRange(k).to,
      });
    }
  }

  // Legal cases (2026-11-10): the officer is asked for the contract details; an unpaid attorney & filing fee reminds
  // whoever handed the case over, and the executives, a day later.
  for (const c of await listCases(viewer, now)) {
    if (c.state === "needs_details" && c.detailsRequestedAt && c.officerStaffId === viewer.staffId) {
      items.push({
        key: `legal-details:${c.caseId}:${c.detailsRequestedAt.getTime()}`,
        kind: "legal_details_requested",
        title: `Legal needs the contract details for ${c.borrowerName}`,
        detail: "The fee per day and the collateral from the signed contract. Please also share the contract with the lawyer in game.",
        href: `/loans/legal/${c.loanId}`,
        at: c.detailsRequestedAt,
      });
    }
  }
  const unpaid = await db.execute<{ id: string; loan_id: string; name: string | null; state_id: number; handed_at: Date | string; handed_by: string; fee_cents: string | number }>(sql`
    select h.id, lc.loan_id, l.borrower_name as name, l.borrower_state_id as state_id, h.handed_at, h.handed_by_staff_id as handed_by, h.fee_cents
      from legal_case lc join loan l on l.id = lc.loan_id
      join lateral (select * from legal_case_handover h where h.case_id = lc.id order by h.handed_at desc limit 1) h on true
     where l.retired_at is null and lc.closed_at is null and l.status in ('defaulted', 'written_off')
       and not exists (select 1 from ${ACTIVE_FEE_LINKS} f where f.case_id = lc.id)
       and h.handed_at <= ${new Date(now.getTime() - 24 * HOUR_MS)}`);
  for (const r of unpaid.rows) {
    if (r.handed_by !== viewer.staffId && !can(viewer.role, "settings.manage")) continue;
    const name = r.name ?? `State ID ${r.state_id}`;
    items.push({
      key: `legal-fee:${r.id}`,
      kind: "legal_fee_unpaid",
      title: `Attorney & filing fee not paid: ${name}`,
      detail: `${formatCents(Number(r.fee_cents))} to the lawyer, handed over ${DATE.format(new Date(r.handed_at))}. Pay it from the case page’s phone helper.`,
      href: `/loans/legal/${r.loan_id}`,
      at: new Date(new Date(r.handed_at).getTime() + 24 * HOUR_MS),
    });
  }

  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  const shown = items.slice(0, LIMIT);
  const read = shown.length
    ? new Set(
        (
          await db
            .select({ key: notificationRead.key })
            .from(notificationRead)
            .where(and(eq(notificationRead.staffId, viewer.staffId), inArray(notificationRead.key, shown.map((i) => i.key))))
        ).map((r) => r.key),
      )
    : new Set<string>();
  return shown.map((i) => ({ ...i, read: read.has(i.key) }));
}

export const markReadSchema = z.object({ keys: z.array(z.string().min(1).max(100)).min(1).max(LIMIT) });

/** Personal and harmless, so not audited: it only changes what the bell counts as new. */
export async function markNotificationsRead(viewer: Viewer, raw: z.input<typeof markReadSchema>): Promise<void> {
  const { keys } = markReadSchema.parse(raw);
  await db
    .insert(notificationRead)
    .values(keys.map((key) => ({ staffId: viewer.staffId, key })))
    .onConflictDoNothing();
}
