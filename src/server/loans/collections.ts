import "server-only";
import { canCollectOn } from "@/server/authz/rules";
import { cache } from "react";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import { collectionPriority, promiseOutcome, type PromiseOutcome } from "@/domain/loans/collections";
import { ForbiddenError } from "@/lib/permissions";
import { recordAudit } from "@/server/audit/audit";
import type { Viewer } from "@/server/authz/viewer";
import { db } from "@/server/db";
import { bankTransaction, liveLoan, loan, loanCollectionAction, loanEvent, loanPaymentLink, mortgage, mortgageEvent, staff } from "@/server/db/schema";
import { paymentsByMortgage } from "@/server/mortgages/payments";
import { analysisFor, listMortgages } from "@/server/mortgages/queries";
import { getRequestMeta } from "@/server/request";
import { LoanError } from "./errors";
import { listLoans } from "./queries";

/**
 * Collections log for overdue and defaulted loans and late mortgages (research/11,
 * research/12). Promises to pay are checked against the bank: kept, pending or broken.
 */

export const COLLECTION_KINDS = ["contacted", "no_answer", "promise", "handed_to_legal", "seizure", "note"] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];
export const COLLECTION_LABEL: Record<CollectionKind, string> = {
  contacted: "Spoke to them",
  no_answer: "No answer",
  promise: "Promised to pay",
  handed_to_legal: "Handed to Legal",
  seizure: "Seizure / repossession",
  note: "Note",
};

/** Loans collections applies to: behind, defaulted, or written off (recoveries still possible). */
export const COLLECTABLE = ["overdue", "defaulted", "written_off"] as const;

/** A defaulted card has no missed count; treat it as at least this many. */
const DEFAULTED_MISSED = 3;

/** The loan's or mortgage's officer, or Legal and above. */
const canCollect = canCollectOn;

/** Midnight UTC of today's UK date — dates arrive as noon UTC on the chosen day. */
function startOfToday(): Date {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(`${d}T00:00:00Z`);
}

const dateOrNull = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .transform((v) => (v ? new Date(`${v}T12:00:00Z`) : null));

export const logCollectionSchema = z
  .object({
    loanId: z.uuid().nullish(),
    mortgageId: z.uuid().nullish(),
    kind: z.enum(COLLECTION_KINDS),
    note: z.string().trim().max(1000).default(""),
    promiseDollars: z.number().int().positive().max(100_000_000).nullish(),
    promiseBy: dateOrNull,
    nextActionAt: dateOrNull,
  })
  .refine((v) => !v.loanId !== !v.mortgageId, { message: "Choose a loan or a mortgage.", path: ["loanId"] })
  .refine((v) => v.kind !== "promise" || (v.promiseDollars && v.promiseBy), { message: "A promise needs an amount and a date.", path: ["promiseDollars"] })
  .refine((v) => !v.promiseBy || v.promiseBy >= startOfToday(), { message: "The promise date can't be in the past.", path: ["promiseBy"] })
  .refine((v) => !v.nextActionAt || v.nextActionAt >= startOfToday(), { message: "The follow-up date can't be in the past.", path: ["nextActionAt"] })
  .refine((v) => v.kind === "no_answer" || v.note.length >= 3, { message: "Add a short note.", path: ["note"] });

export async function logCollection(viewer: Viewer, raw: z.input<typeof logCollectionSchema>): Promise<void> {
  const input = logCollectionSchema.parse(raw);
  const request = await getRequestMeta();
  const values = {
    staffId: viewer.staffId,
    kind: input.kind,
    note: input.note,
    promiseCents: input.kind === "promise" && input.promiseDollars ? input.promiseDollars * 100 : null,
    promiseBy: input.kind === "promise" ? input.promiseBy : null,
    nextActionAt: input.nextActionAt ?? (input.kind === "promise" ? input.promiseBy : null),
  };

  if (input.mortgageId) {
    const [m] = await db.select().from(mortgage).where(eq(mortgage.id, input.mortgageId));
    if (!m || m.mergedIntoId) throw new LoanError("Mortgage not found.");
    if (!canCollect(viewer, m)) throw new ForbiddenError("Only the mortgage's officer, Legal or management can log collections.");
    const state = analysisFor(m, (await paymentsByMortgage([m.id])).get(m.id) ?? [])?.state;
    const late = m.status === "active" && (state?.kind === "late" || state?.kind === "behind");
    const n = await db.$count(loanCollectionAction, eq(loanCollectionAction.mortgageId, m.id));
    // Once a case is open it stays open to notes even after they catch up.
    if (!late && n === 0) throw new LoanError("Collections only apply to mortgages that are behind on payments.");
    await db.transaction(async (tx) => {
      const [row] = await tx.insert(loanCollectionAction).values({ ...values, mortgageId: m.id }).returning({ id: loanCollectionAction.id });
      await tx.insert(mortgageEvent).values({ mortgageId: m.id, kind: "collection_logged", staffId: viewer.staffId, detail: { kind: input.kind, actionId: row.id } });
      await recordAudit(tx, {
        actor: { type: "staff", staffId: viewer.staffId },
        action: "mortgages.collection.logged",
        target: { type: "mortgage", id: m.id },
        metadata: { kind: input.kind, promiseDollars: input.promiseDollars ?? null },
        request,
      });
    });
    return;
  }

  await db.transaction(async (tx) => {
    const [l] = await tx.select().from(loan).where(and(liveLoan, eq(loan.id, input.loanId!)));
    if (!l) throw new LoanError("Loan not found.");
    if (!canCollect(viewer, l)) throw new ForbiddenError("Only the loan's officer, Legal or management can log collections.");
    if (!(COLLECTABLE as readonly string[]).includes(l.status)) throw new LoanError("Collections only apply to overdue, defaulted or written-off loans.");
    const [row] = await tx.insert(loanCollectionAction).values({ ...values, loanId: l.id }).returning({ id: loanCollectionAction.id });
    await tx.insert(loanEvent).values({ loanId: l.id, kind: "collection_logged", staffId: viewer.staffId, detail: { kind: input.kind, actionId: row.id } });
    await recordAudit(tx, {
      actor: { type: "staff", staffId: viewer.staffId },
      action: "loans.collection.logged",
      target: { type: "loan", id: l.id },
      metadata: { kind: input.kind, promiseDollars: input.promiseDollars ?? null },
      request,
    });
  });
}

export type CollectionEntry = {
  id: string;
  at: Date;
  kind: CollectionKind;
  note: string;
  promiseCents: number | null;
  promiseBy: Date | null;
  nextActionAt: Date | null;
  staffName: string;
  /** For promises: whether the bank shows it was kept. */
  outcome: PromiseOutcome | null;
};

type Payment = { at: Date; cents: number };

/** Money the borrower paid on each loan (every part except the loan going out). */
async function loanPayments(loanIds: string[]): Promise<Map<string, Payment[]>> {
  const out = new Map<string, Payment[]>();
  if (loanIds.length === 0) return out;
  const rows = await db
    .select({ loanId: loanPaymentLink.loanId, at: bankTransaction.occurredAt, cents: bankTransaction.amountCents })
    .from(loanPaymentLink)
    .innerJoin(bankTransaction, eq(bankTransaction.id, loanPaymentLink.bankTransactionId))
    .where(and(inArray(loanPaymentLink.loanId, loanIds), notInArray(loanPaymentLink.role, ["disbursement", "fee", "refund"])))
    .orderBy(asc(bankTransaction.occurredAt));
  for (const r of rows) out.set(r.loanId, [...(out.get(r.loanId) ?? []), { at: r.at, cents: r.cents }]);
  return out;
}

async function mortgagePayments(ids: string[]): Promise<Map<string, Payment[]>> {
  const out = new Map<string, Payment[]>();
  for (const [id, list] of await paymentsByMortgage(ids)) out.set(id, list.map((p) => ({ at: p.occurredAt, cents: p.grossCents })));
  return out;
}

async function collectionsFor(column: "loanId" | "mortgageId", ids: string[], now: Date): Promise<Map<string, CollectionEntry[]>> {
  const out = new Map<string, CollectionEntry[]>();
  if (ids.length === 0) return out;
  const [rows, payments] = await Promise.all([
    db
      .select({ a: loanCollectionAction, staffName: staff.characterName })
      .from(loanCollectionAction)
      .innerJoin(staff, eq(staff.id, loanCollectionAction.staffId))
      .where(inArray(loanCollectionAction[column], ids))
      .orderBy(desc(loanCollectionAction.at)),
    column === "loanId" ? loanPayments(ids) : mortgagePayments(ids),
  ]);
  for (const { a, staffName } of rows) {
    const key = a[column]!;
    const outcome =
      a.kind === "promise" && a.promiseCents !== null && a.promiseBy !== null
        ? promiseOutcome({ loggedAt: a.at, promiseCents: a.promiseCents, promiseBy: a.promiseBy }, payments.get(key) ?? [], now)
        : null;
    const e: CollectionEntry = { id: a.id, at: a.at, kind: a.kind, note: a.note, promiseCents: a.promiseCents, promiseBy: a.promiseBy, nextActionAt: a.nextActionAt, staffName, outcome };
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  return out;
}

/** Plain values for the client panel. */
export function serializeCollections(entries: CollectionEntry[]) {
  return entries.map((c) => ({
    id: c.id,
    at: c.at.toISOString(),
    kind: c.kind,
    note: c.note,
    promiseCents: c.promiseCents,
    promiseBy: c.promiseBy?.toISOString() ?? null,
    nextActionAt: c.nextActionAt?.toISOString() ?? null,
    staffName: c.staffName,
    outcome: c.outcome,
  }));
}

export function loanCollections(loanIds: string[], now: Date = new Date()) {
  return collectionsFor("loanId", loanIds, now);
}

export function mortgageCollections(mortgageIds: string[], now: Date = new Date()) {
  return collectionsFor("mortgageId", mortgageIds, now);
}

export type QueueRow = {
  type: "loan" | "mortgage";
  id: string;
  href: string;
  borrower: string;
  stateId: number | null;
  /** Loans: overdue / defaulted / written off. Mortgages: late (in grace) / behind. */
  status: "overdue" | "defaulted" | "written_off" | "late" | "behind";
  /** Missed instalments (null when the phone card doesn't say). */
  missed: number | null;
  officerName: string | null;
  officerStaffId: string | null;
  owedCents: number;
  last: CollectionEntry | null;
  nextActionAt: Date | null;
  withLegal: boolean;
  brokenPromises: number;
  /** The broken promises themselves, newest first. */
  broken: CollectionEntry[];
  pendingPromise: CollectionEntry | null;
  due: boolean;
  priority: number;
};

function caseFacts(log: CollectionEntry[], now: Date) {
  const last = log[0] ?? null;
  const nextActionAt = last?.nextActionAt ?? null;
  const broken = log.filter((e) => e.outcome?.state === "broken");
  return {
    broken,
    last,
    nextActionAt,
    withLegal: log.some((e) => e.kind === "handed_to_legal"),
    brokenPromises: broken.length,
    pendingPromise: log.find((e) => e.outcome?.state === "pending") ?? null,
    followUpDue: nextActionAt !== null && nextActionAt <= now,
  };
}

/**
 * What to chase, most urgent first: overdue and defaulted loans and late mortgages
 * the viewer may see. Written-off loans only once someone has logged something on
 * them (an active recovery); mortgages that have caught up drop off.
 */
export async function collectionsQueue(viewer: Viewer, now: Date = new Date()): Promise<QueueRow[]> {
  const [loans, mortgages] = await Promise.all([
    listLoans(viewer, { status: "all" }).then((all) => all.filter((l) => (COLLECTABLE as readonly string[]).includes(l.status))),
    listMortgages(viewer, { status: "behind" }),
  ]);
  const [loanLogs, mortgageLogs] = await Promise.all([loanCollections(loans.map((l) => l.id), now), mortgageCollections(mortgages.map((m) => m.id), now)]);
  const rows: QueueRow[] = [];

  for (const l of loans) {
    const log = loanLogs.get(l.id) ?? [];
    if (l.status === "written_off" && log.length === 0) continue;
    const f = caseFacts(log, now);
    const missed = l.status === "overdue" ? Math.max(1, l.lastMissed ?? 1) : l.status === "defaulted" ? Math.max(DEFAULTED_MISSED, l.lastMissed ?? 0) : null;
    const owedCents = Math.max(0, l.outstandingCents ?? 0);
    const due = l.status !== "written_off" && (!f.last || f.followUpDue || f.last.outcome?.state === "broken");
    rows.push({
      type: "loan",
      id: l.id,
      href: `/loans/${l.id}`,
      borrower: l.borrowerName ?? `State ID ${l.borrowerStateId}`,
      stateId: l.borrowerStateId,
      status: l.status as QueueRow["status"],
      missed,
      officerName: l.officerName,
      officerStaffId: l.officerStaffId,
      owedCents,
      last: f.last,
      nextActionAt: f.nextActionAt,
      withLegal: f.withLegal,
      brokenPromises: f.brokenPromises,
      broken: f.broken,
      pendingPromise: f.pendingPromise,
      due,
      priority:
        l.status === "written_off"
          ? 0
          : collectionPriority({ owedCents, missed: missed ?? 0, brokenPromises: f.brokenPromises, pendingPromise: f.pendingPromise !== null, followUpDue: f.followUpDue, neverContacted: !f.last }),
    });
  }

  for (const m of mortgages) {
    if (m.state?.kind !== "late" && m.state?.kind !== "behind") continue;
    const log = mortgageLogs.get(m.id) ?? [];
    const f = caseFacts(log, now);
    const owedCents = Math.max(0, m.principalRemainingCents ?? 0) + Math.max(0, m.brokerInterestRemainingCents ?? 0);
    // In grace a mortgage isn't chased yet unless someone already opened a case.
    const due = m.state.kind === "behind" && (!f.last || f.followUpDue || f.last.outcome?.state === "broken");
    rows.push({
      type: "mortgage",
      id: m.id,
      href: `/mortgages/${m.id}`,
      borrower: m.buyerName ?? m.address,
      stateId: m.buyerStateId,
      status: m.state.kind,
      missed: m.state.overdue,
      officerName: m.officerName,
      officerStaffId: m.officerStaffId,
      owedCents,
      last: f.last,
      nextActionAt: f.nextActionAt,
      withLegal: f.withLegal,
      brokenPromises: f.brokenPromises,
      broken: f.broken,
      pendingPromise: f.pendingPromise,
      due,
      priority: collectionPriority({
        owedCents,
        missed: m.state.overdue,
        brokenPromises: f.brokenPromises,
        pendingPromise: f.pendingPromise !== null,
        followUpDue: f.followUpDue,
        neverContacted: !f.last && m.state.kind === "behind",
      }) * (m.state.kind === "late" ? 0.5 : 1),
    });
  }

  return rows.sort((a, b) => Number(b.due) - Number(a.due) || b.priority - a.priority || b.owedCents - a.owedCents);
}

/** One queue per request, shared by the dashboard and the notification bell. */
export const collectionsQueueForRequest = cache((viewer: Viewer) => collectionsQueue(viewer));
