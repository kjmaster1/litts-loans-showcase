import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { finalInstalment, matchCards, instalmentsFromComment, problemForNewLoan, type CandidateLoan, type CardMatch } from "@/domain/loans/match";
import { parseCards, type LoanCard } from "@/domain/loans/parse-cards";
import { estimateDefaultedAt, nextDueFrom, staleRepaste, statusFromCard, type LoanStatus, type LoanTab } from "@/domain/loans/status";
import { can, ForbiddenError } from "@/lib/permissions";
import { canBeOfficer, NOT_OFFICER_MESSAGE } from "@/server/authz/rules";
import type { Role } from "@/lib/roles";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { bankTransaction, liveLoan, loan, loanCard, loanEvent, loanPaste, loanPaymentLink, staff } from "@/server/db/schema";
import { getRequestMeta } from "@/server/request";
import { LoanError } from "./errors";
import { syncLoans } from "./sync";
import { WORKING_STATUSES } from "@/lib/roles";

/**
 * Weekly paste of a phone tab (docs/design/LOANS.md): preview → commit.
 *
 * Stateless: the preview never stores the text. Commit re-parses and re-matches
 * the same text and applies the user's choices, so nothing the browser sends
 * can point a card at a loan the matcher didn't offer.
 */

export const LOAN_TABS = ["active", "overdue", "default", "complete"] as const satisfies readonly LoanTab[];
export const MAX_PASTE_CHARS = 400_000;


export type LoanSummary = {
  id: string;
  borrowerStateId: number;
  borrowerName: string | null;
  principalCents: number;
  openedAt: string | null;
  status: LoanStatus;
  officerStaffId: string | null;
  officerName: string | null;
  returnedPct: number;
};

export type CardPreview = {
  index: number;
  stateId: number;
  headerAmountCents: number;
  cardPrincipalCents: number | null;
  progress: string | null;
  missed: number | null;
  statusText: string | null;
  warnings: string[];
  match:
    | { kind: "matched"; how: string; loan: LoanSummary }
    | { kind: "ambiguous"; candidates: LoanSummary[] }
    /** No loan in the bank data: someone must choose to add it (or skip). `refused` = it can't be added. */
    | { kind: "new"; principalCents: number | null; refused: string | null; borrowerLoans: LoanSummary[] }
    | { kind: "ignored"; reason: string };
  statusTo: LoanStatus | null;
};

export type PastePreview = {
  tab: LoanTab;
  cards: CardPreview[];
  ignoredLines: string[];
  /** Loans last seen in this tab that this paste doesn't contain (they may have moved tab). */
  missing: LoanSummary[];
  counts: { matched: number; ambiguous: number; new: number; ignored: number };
  /** When this exact text was pasted before, if its countdowns should have moved since (`staleRepaste`). */
  repeatOf: string | null;
  /** Staff the viewer may assign as officer. */
  officers: { id: string; name: string; role: Role }[];
};

const decisionSchema = z.object({
  /** For ambiguous cards: one of the offered loans; for new cards: "new" or "skip" (required — no default). */
  loan: z.union([z.uuid(), z.literal("new"), z.literal("skip")]).optional(),
  officerStaffId: z.uuid().nullable().optional(),
});

export const commitPasteSchema = z.object({
  tab: z.enum(LOAN_TABS),
  text: z.string().min(1, "Paste the tab's text first.").max(MAX_PASTE_CHARS, "That paste is too long."),
  decisions: z.record(z.string().regex(/^\d+$/), decisionSchema).default({}),
});
export type CommitPasteInput = z.input<typeof commitPasteSchema>;

const LIVE: LoanStatus[] = ["active", "overdue", "defaulted"];

function parseOrThrow(text: string) {
  if (text.length > MAX_PASTE_CHARS) throw new LoanError("That paste is too long.");
  const parsed = parseCards(text);
  if (parsed.cards.length === 0) throw new LoanError("No loan cards found. Copy the whole tab from the phone and paste it here.");
  const cut = parsed.cards.find((c) => c.brokerRatePct === null || c.instalments === null);
  if (cut) {
    throw new LoanError(
      `Card ${cut.index + 1} (State ID ${cut.stateId}) looks cut off: it has no ${cut.brokerRatePct === null ? "interest rates" : "payment count"}. Copy the whole tab from the phone and paste it again.`,
    );
  }
  return parsed;
}

type LoanRow = typeof loan.$inferSelect & { officerName: string | null; returnedCents: number; observedInstalments: number | null; paidUp: boolean };

async function loadLoans(executor: typeof db | Tx): Promise<LoanRow[]> {
  const rows = await executor
    .select({ l: loan, officerName: staff.characterName })
    .from(loan)
    .leftJoin(staff, eq(staff.id, loan.officerStaffId))
    // A retired card-only loan (a duplicate or a mistake) is never matched again.
    .where(liveLoan);
  const payments = await executor
    .select({ loanId: loanPaymentLink.loanId, role: loanPaymentLink.role, amountCents: bankTransaction.amountCents, comment: bankTransaction.comment, at: bankTransaction.occurredAt })
    .from(loanPaymentLink)
    .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
    .where(inArray(loanPaymentLink.role, ["principal", "early_principal", "late_principal"]))
    .orderBy(bankTransaction.occurredAt);
  const returned = new Map<string, number>();
  const paidUp = new Set<string>();
  // What a comment may call the loan: its principal, or (early versions) the total repayable.
  const amountsOf = new Map(
    rows.map(({ l }) => [l.id, [l.principalCents / 100, ...(l.brokerRateBp !== null ? [Math.round((l.principalCents / 100) * (1 + l.brokerRateBp / 10_000))] : [])]]),
  );
  const observed = new Map<string, number>();
  for (const p of payments) {
    returned.set(p.loanId, (returned.get(p.loanId) ?? 0) + p.amountCents);
    const n = p.role === "principal" ? instalmentsFromComment(p.comment) : null;
    if (p.role === "principal" && finalInstalment(p.comment, amountsOf.get(p.loanId))) paidUp.add(p.loanId);
    if (n !== null) observed.set(p.loanId, n);
  }
  return rows.map(({ l, officerName }) => ({
    ...l,
    officerName,
    returnedCents: returned.get(l.id) ?? 0,
    observedInstalments: observed.get(l.id) ?? l.instalments ?? null,
    paidUp: paidUp.has(l.id),
  }));
}

function summary(l: LoanRow): LoanSummary {
  return {
    id: l.id,
    borrowerStateId: l.borrowerStateId,
    borrowerName: l.borrowerName,
    principalCents: l.principalCents,
    openedAt: l.openedAt?.toISOString() ?? null,
    status: l.status,
    officerStaffId: l.officerStaffId,
    officerName: l.officerName,
    returnedPct: Math.round((l.returnedCents / l.principalCents) * 100),
  };
}

function candidates(loans: LoanRow[]): CandidateLoan[] {
  return loans.map((l) => ({
    id: l.id,
    borrowerStateId: l.borrowerStateId,
    principalCents: l.principalCents,
    // Card-only loans have no disbursement date; treat them as the newest.
    openedAt: l.openedAt ?? l.createdAt,
    observedInstalments: l.observedInstalments,
    returnedRatio: l.returnedCents / l.principalCents,
    paidUp: l.paidUp,
  }));
}

async function assignableOfficers(viewer: Viewer): Promise<PastePreview["officers"]> {
  if (!can(viewer.role, "loans.reassign_officer")) return canBeOfficer(viewer) ? [{ id: viewer.staffId, name: viewer.characterName, role: viewer.role }] : [];
  const rows = await db
    .select({ id: staff.id, name: staff.characterName, role: staff.role })
    .from(staff)
    .where(inArray(staff.status, [...WORKING_STATUSES]))
    .orderBy(staff.characterName);
  return rows.filter(canBeOfficer);
}

/** The previous paste of a tab, card by card, to spot the same text pasted again. */
async function previousPaste(executor: typeof db | Tx, tab: LoanTab): Promise<{ capturedAt: Date; raws: string[] } | null> {
  const [last] = await executor.select({ id: loanPaste.id, capturedAt: loanPaste.capturedAt }).from(loanPaste).where(eq(loanPaste.tab, tab)).orderBy(desc(loanPaste.capturedAt)).limit(1);
  if (!last) return null;
  const rows = await executor.select({ raw: loanCard.raw }).from(loanCard).where(eq(loanCard.pasteId, last.id)).orderBy(asc(loanCard.position));
  return { capturedAt: last.capturedAt, raws: rows.map((r) => r.raw) };
}

function progress(card: LoanCard): string | null {
  return card.instalments !== null ? `${card.completed ?? 0}/${card.instalments}` : null;
}

export async function previewPaste(viewer: Viewer, input: { tab: LoanTab; text: string }): Promise<PastePreview> {
  const { cards, ignoredLines } = parseOrThrow(input.text);
  // Make sure every imported disbursement has a loan before matching (idempotent).
  await syncLoans();
  const loans = await loadLoans(db);
  const byId = new Map(loans.map((l) => [l.id, l]));
  const results = matchCards(cards, candidates(loans));

  const preview: CardPreview[] = results.map((r) => {
    const base = {
      index: r.card.index,
      stateId: r.card.stateId,
      headerAmountCents: r.card.headerAmountCents,
      cardPrincipalCents: r.card.principalCents,
      progress: progress(r.card),
      missed: r.card.missedPayments,
      statusText: r.card.statusText,
      warnings: r.card.warnings,
    };
    switch (r.kind) {
      case "matched": {
        const l = byId.get(r.loanId)!;
        return { ...base, match: { kind: "matched", how: r.how, loan: summary(l) }, statusTo: l.statusLocked ? l.status : statusFromCard(l.status, input.tab) };
      }
      case "ambiguous":
        return {
          ...base,
          match: { kind: "ambiguous", candidates: r.candidateIds.map((id) => summary(byId.get(id)!)) },
          statusTo: statusFromCard(null, input.tab),
        };
      case "new":
        return {
          ...base,
          match: {
            kind: "new",
            principalCents: r.card.principalCents,
            refused: problemForNewLoan(r.card),
            // Context for the decision: what this borrower already has with Litt's.
            borrowerLoans: loans.filter((l) => l.borrowerStateId === r.card.stateId).map(summary),
          },
          statusTo: statusFromCard(null, input.tab),
        };
      case "ignored":
        return { ...base, match: { kind: "ignored", reason: r.reason }, statusTo: null };
    }
  });

  const seen = new Set(results.flatMap((r) => (r.kind === "matched" ? [r.loanId] : r.kind === "ambiguous" ? r.candidateIds : [])));
  const missing = loans.filter((l) => l.lastCardTab === input.tab && LIVE.includes(l.status) && !seen.has(l.id)).map(summary);

  return {
    tab: input.tab,
    cards: preview,
    ignoredLines,
    missing,
    counts: {
      matched: results.filter((r) => r.kind === "matched").length,
      ambiguous: results.filter((r) => r.kind === "ambiguous").length,
      new: results.filter((r) => r.kind === "new").length,
      ignored: results.filter((r) => r.kind === "ignored").length,
    },
    repeatOf: staleRepaste(cards, await previousPaste(db, input.tab), new Date())?.toISOString() ?? null,
    officers: await assignableOfficers(viewer),
  };
}

export type CommitPasteResult = { pasteId: string; updated: number; created: number; skipped: number; statusChanges: number; levyEntries: number };

export async function commitPaste(viewer: Viewer, raw: CommitPasteInput): Promise<CommitPasteResult> {
  const input = commitPasteSchema.parse(raw);
  const { cards } = parseOrThrow(input.text);
  const request = await getRequestMeta();
  const mayAssignOthers = can(viewer.role, "loans.reassign_officer");

  return db.transaction(async (tx) => {
    await syncLoans(tx);
    const loans = await loadLoans(tx);
    const byId = new Map(loans.map((l) => [l.id, l]));
    const results = matchCards(cards, candidates(loans));

    // Officers named in the decisions must be current staff (active or invited), and officers may only assign themselves.
    const officerIds = [...new Set(Object.values(input.decisions).flatMap((d) => (d.officerStaffId ? [d.officerStaffId] : [])))];
    if (!mayAssignOthers && officerIds.some((id) => id !== viewer.staffId)) {
      throw new ForbiddenError("Loan officers can only assign loans to themselves.");
    }
    const named = officerIds.length ? await tx.select({ id: staff.id, role: staff.role }).from(staff).where(and(inArray(staff.id, officerIds), inArray(staff.status, [...WORKING_STATUSES]))) : [];
    if (named.some((s) => !canBeOfficer(s))) throw new LoanError(NOT_OFFICER_MESSAGE);
    const activeOfficers = new Set(named.map((s) => s.id));
    if (officerIds.some((id) => !activeOfficers.has(id))) throw new LoanError("Officers must be current staff.");

    const now = new Date();
    // The text each loan's card had last time: the same text again carries no new countdown (`staleRepaste`).
    const lastRaw = new Map(
      (
        await tx.execute<{ loan_id: string; raw: string }>(sql`
          select distinct on (c.loan_id) c.loan_id, c.raw from loan_card c join loan_paste p on p.id = c.paste_id
           where c.loan_id is not null order by c.loan_id, p.captured_at desc, c.id desc`)
      ).rows.map((r) => [r.loan_id, r.raw]),
    );
    const pasteId = randomUUID();
    const cardRows: (typeof loanCard.$inferInsert)[] = [];
    const events: (typeof loanEvent.$inferInsert)[] = [];
    const claimed = new Set<string>();
    let created = 0;
    let skipped = 0;
    let statusChanges = 0;
    const updatedLoans = new Set<string>();

    const resolve = (r: CardMatch): { loanId: string | null; how: string } => {
      const decision = input.decisions[String(r.card.index)];
      switch (r.kind) {
        case "ignored":
          return { loanId: null, how: `ignored:${r.reason}` };
        case "matched":
          return { loanId: r.loanId, how: r.how };
        case "ambiguous": {
          const choice = decision?.loan;
          if (choice === "skip") return { loanId: null, how: "skipped" };
          if (!choice || !r.candidateIds.includes(choice)) {
            throw new LoanError(`Choose which loan card ${r.card.index + 1} (State ID ${r.card.stateId}) belongs to.`);
          }
          return { loanId: choice, how: "chosen" };
        }
        case "new": {
          if (problemForNewLoan(r.card)) return { loanId: null, how: "skipped:no_principal" };
          if (decision?.loan === "skip") return { loanId: null, how: "skipped" };
          if (decision?.loan !== "new") {
            throw new LoanError(`Card ${r.card.index + 1} (State ID ${r.card.stateId}) has no loan in the bank data. Choose “Add as a new loan” or “Skip”.`);
          }
          return { loanId: "new", how: "created" };
        }
      }
    };

    for (const r of results) {
      const card = r.card;
      const resolved = resolve(r);
      const how = resolved.how;
      let loanId = resolved.loanId;
      if (loanId && loanId !== "new") {
        if (claimed.has(loanId)) throw new LoanError(`Two cards point at the same loan (card ${card.index + 1}). Choose a different loan.`);
        claimed.add(loanId);
      }

      if (loanId === "new") {
        const id = randomUUID();
        await tx.insert(loan).values({ id, borrowerStateId: card.stateId, principalCents: card.principalCents!, status: "active" });
        events.push({ loanId: id, at: now, kind: "created_from_card", staffId: viewer.staffId, detail: { tab: input.tab } });
        const row: LoanRow = { ...(await tx.select().from(loan).where(eq(loan.id, id)))[0], officerName: null, returnedCents: 0, observedInstalments: null, paidUp: false };
        byId.set(id, row);
        loanId = id;
        created++;
      }
      if (how.startsWith("skipped")) skipped++;

      cardRows.push({ pasteId, loanId, position: card.index, raw: card.raw, parsed: card, matchHow: how });
      if (!loanId) continue;

      const l = byId.get(loanId)!;
      // Staff overrode the game's status (e.g. repaid but stuck in Default): the card can't change it.
      const status = l.statusLocked ? l.status : statusFromCard(l.status, input.tab);
      const set: Partial<typeof loan.$inferInsert> = {
        status,
        lastCardAt: now,
        lastCardTab: input.tab,
        lastCompleted: card.completed,
        lastMissed: card.missedPayments,
        lastRemainingCents: card.remainingCents,
        // A loan with a bank start gets the game's due date from the loan sync below; this is for the others.
        nextPaymentDueAt: status === "completed" ? null : lastRaw.get(loanId) === card.raw && l.nextPaymentDueAt ? l.nextPaymentDueAt : nextDueFrom(card, now),
        updatedAt: now,
      };

      // Terms come only from cards; they're fixed once set (levies were posted with them).
      if (l.instalments === null && card.instalments !== null) set.instalments = card.instalments;
      if (l.periodDays === null && card.periodDays !== null) set.periodDays = card.periodDays;
      if (l.brokerRateBp === null && card.brokerRatePct !== null) set.brokerRateBp = Math.round(card.brokerRatePct * 100);
      if (l.stateRateBp === null && card.stateRatePct !== null) set.stateRateBp = Math.round(card.stateRatePct * 100);
      if (set.instalments !== undefined || set.brokerRateBp !== undefined) {
        events.push({
          loanId,
          at: now,
          kind: "terms_set",
          staffId: viewer.staffId,
          detail: { instalments: card.instalments, periodDays: card.periodDays, brokerRatePct: card.brokerRatePct, stateRatePct: card.stateRatePct },
        });
      }

      if (status !== l.status) {
        statusChanges++;
        events.push({ loanId, at: now, kind: "status_changed", staffId: viewer.staffId, detail: { from: l.status, to: status, tab: input.tab } });
        if (status === "defaulted" && !l.firstDefaultAt) {
          const [paid] = await tx
            .select({ at: sql<Date | null>`max(${bankTransaction.occurredAt})` })
            .from(loanPaymentLink)
            .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
            .where(and(eq(loanPaymentLink.loanId, loanId), inArray(loanPaymentLink.role, ["principal", "early_principal", "late_principal"])));
          set.firstDefaultAt = estimateDefaultedAt({
            firstMissedAt: card.firstMissedAt ? new Date(card.firstMissedAt) : null,
            periodDays: card.periodDays ?? l.periodDays,
            lastPaidAt: paid?.at ? new Date(paid.at) : null,
            openedAt: l.openedAt,
            now,
          });
        }
        if (status === "completed" && !l.completedAt) {
          const [last] = await tx
            .select({ at: sql<Date>`max(${bankTransaction.occurredAt})` })
            .from(loanPaymentLink)
            .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
            .where(eq(loanPaymentLink.loanId, loanId));
          set.completedAt = last?.at ? new Date(last.at) : now;
        }
      }

      // Pasting only fills in a missing officer; changing one is done on the loan's page.
      const officer = input.decisions[String(card.index)]?.officerStaffId;
      if (officer && !l.officerStaffId) {
        set.officerStaffId = officer;
        events.push({ loanId, at: now, kind: "officer_assigned", staffId: viewer.staffId, detail: { from: null, to: officer } });
      }

      await tx.update(loan).set(set).where(eq(loan.id, loanId));
      updatedLoans.add(loanId);
    }

    await tx.insert(loanPaste).values({
      id: pasteId,
      tab: input.tab,
      capturedAt: now,
      createdByStaffId: viewer.staffId,
      cardCount: results.length,
      matchedCount: updatedLoans.size - created,
      createdCount: created,
      ignoredCount: results.filter((r) => r.kind === "ignored").length,
    });
    for (let i = 0; i < cardRows.length; i += 200) await tx.insert(loanCard).values(cardRows.slice(i, i + 200));
    for (let i = 0; i < events.length; i += 500) await tx.insert(loanEvent).values(events.slice(i, i + 500));

    // Terms just learned let the sync post the State levy for past receipts.
    const synced = await syncLoans(tx);

    const result: CommitPasteResult = { pasteId, updated: updatedLoans.size, created, skipped, statusChanges, levyEntries: synced.levyEntries };
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.paste.committed",
      target: { type: "loan_paste", id: pasteId },
      metadata: { tab: input.tab, cards: results.length, ...result },
      request,
    });
    return result;
  });
}

/** Latest paste per tab, for the stale-paste warning. */
export async function lastPasteByTab(): Promise<Record<LoanTab, Date | null>> {
  const rows = await db
    .select({ tab: loanPaste.tab, at: sql<Date>`max(${loanPaste.capturedAt})` })
    .from(loanPaste)
    .groupBy(loanPaste.tab);
  const out: Record<LoanTab, Date | null> = { active: null, overdue: null, default: null, complete: null };
  for (const r of rows) out[r.tab] = r.at ? new Date(r.at) : null;
  return out;
}

/** Tabs not pasted within `days` (or never) — statuses may be stale. */
export function staleTabs(last: Record<LoanTab, Date | null>, days = 8, now = Date.now()): LoanTab[] {
  return LOAN_TABS.filter((tab) => {
    const at = last[tab];
    return !at || now - at.getTime() > days * 86_400_000;
  });
}
