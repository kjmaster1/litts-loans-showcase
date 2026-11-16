import "server-only";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { buildSheet, caseDefault, londonDay, sheetText, type CaseSheet, type DefaultRule } from "@/domain/legal/case-sheet";
import { formatCents } from "@/lib/format";
import { ForbiddenError } from "@/lib/permissions";
import { WORKING_STATUSES } from "@/lib/roles";
import { recordAudit } from "@/server/audit/audit";
import { canAnnotateLoan, canCloseCase, canHandToLegal, canSeeLoan, officerScope } from "@/server/authz/rules";
import type { Viewer } from "@/server/authz/viewer";
import { db, type Tx } from "@/server/db";
import { bankTransaction, legalCase, legalCaseHandover, legalFeeLink, liveLoan, loan, loanCollateral, loanCollectionAction, loanEvent, staff } from "@/server/db/schema";
import { LoanError } from "@/server/loans/errors";
import { getRequestMeta } from "@/server/request";
import { getSettings } from "@/server/settings";
import { ACTIVE_FEE_LINKS, activeFeeLink, feeSuggestions, type FeeRow } from "./fees";

/**
 * Legal cases (owner, 2026-11-10; docs/superpowers/specs/2026-11-10-legal-case-sheets-design.md). A defaulted or
 * written-off loan has a case. Its state is derived: Needs details (the sheet can't be written yet) → Ready → With
 * Legal (handed over: the sheet is frozen) → Closed. Pages only read; every change below is audited.
 */

type Executor = typeof db | Tx;

/** `loan` as the raw queries below alias it, for `officerScope`. */
const scopedLoan = alias(loan, "l");

export type CaseState = "needs_details" | "ready" | "with_legal" | "closed";
/** `collateral_conflict`: ticked Unsecured, yet collateral is recorded — one of them is wrong. */
export type CaseMissing = "card" | "default_date" | "fee_per_day" | "collateral" | "collateral_conflict";

export const CASE_LOAN_STATUSES = ["defaulted", "written_off"] as const;
export const UNSECURED = "None (unsecured)";

export type CaseRow = {
  loanId: string;
  caseId: string | null;
  number: number | null;
  borrowerName: string;
  stateId: number;
  officerStaffId: string | null;
  officerName: string | null;
  /** The officer still works here (active or invited) and can be asked. */
  officerWorking: boolean;
  state: CaseState;
  missing: CaseMissing[];
  defaultAt: Date | null;
  defaultRule: DefaultRule;
  /** Instalment × instalments left, from the latest card (null with no card). */
  claimCents: number | null;
  /** The sheet as it would be handed over now; null until nothing is missing. */
  preview: CaseSheet | null;
  /** The frozen total once handed over, else the preview's. */
  totalCents: number | null;
  handedAt: Date | null;
  feePaid: boolean;
  detailsRequestedAt: Date | null;
  contractSharedAt: Date | null;
  closedAt: Date | null;
};


/**
 * A note for Legal (owner, 2026-11-10): the signed contract states a different weekly payment from the game's (an
 * officer's mistake on the paper). The sheet still claims the phone card's amount; this only tells the lawyer why the
 * contract they file says something else.
 */
export type ContractNote = {
  /** The weekly payment the contract states. */
  cents: number;
  reason: string;
  byName: string | null;
  at: Date;
};

export type CaseDetail = CaseRow & {
  closeNote: string | null;
  /** The latest card's amount: the sheet's instalment. */
  cardInstalmentCents: number | null;
  contractNote: ContractNote | null;
  defaultAtOverride: Date | null;
  feePerDayCents: number | null;
  unsecured: boolean;
  collateral: string | null;
  handover: (typeof legalCaseHandover.$inferSelect) | null;
  earlierHandovers: number;
  /** The fee to pay: the hand-over's, else the current setting. */
  feeCents: number;
  payee: { staffId: string; name: string; stateId: number } | null;
  feePayments: FeeRow[];
  feeSuggestions: FeeRow[];
  recoveredSinceHandoverCents: number;
  feePaidCents: number;
  netForLittsCents: number;
  stillOwedCents: number | null;
  legalStaff: { id: string; name: string; stateId: number }[];
};

type Raw = {
  id: string;
  borrower_state_id: number;
  borrower_name: string | null;
  officer_staff_id: string | null;
  officer_name: string | null;
  officer_working: boolean;
  instalments: number | null;
  principal_cents: string | number;
  broker_rate_bp: number | null;
  last_completed: number | null;
  period_days: number | null;
  first_default_at: Date | string | null;
  default_fee_per_day_cents: string | number | null;
  unsecured: boolean;
  card: { headerAmountCents?: number; instalments?: number | null; completed?: number | null; missedPayments?: number | null; firstMissedAt?: string | null } | null;
  offer_fee: string | number | null;
  offer_collateral: string | null;
  collateral: string | null;
  case_id: string | null;
  number: number | null;
  default_at_override: Date | string | null;
  details_requested_at: Date | string | null;
  contract_shared_at: Date | string | null;
  closed_at: Date | string | null;
  close_note: string | null;
  contract_instalment_cents: string | number | null;
  contract_instalment_reason: string | null;
  contract_instalment_at: Date | string | null;
  contract_instalment_by: string | null;
  handed_at: Date | string | null;
  handover_total: string | number | null;
  fee_paid: boolean;
};

const date = (v: Date | string | null | undefined): Date | null => (v ? new Date(v) : null);
const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

async function loadRaw(executor: Executor, viewer: Viewer, filter?: SQL): Promise<Raw[]> {
  // The record-level rule from rules.ts, on the query's `l` alias of loan.
  const own = officerScope(viewer, scopedLoan.officerStaffId);
  const scope = own ? sql`and ${own}` : sql``;
  const extra = filter ? sql`and ${filter}` : sql``;
  const res = await executor.execute<Raw>(sql`
    select l.id, l.borrower_state_id, l.borrower_name, l.officer_staff_id, s.character_name as officer_name,
      coalesce(s.status in ('active', 'invited') and s.role <> 'legal', false) as officer_working,
      l.instalments, l.principal_cents, l.broker_rate_bp, l.last_completed, l.period_days, l.first_default_at, l.default_fee_per_day_cents, l.unsecured,
      c.parsed as card, o.default_fee_per_day_cents as offer_fee, o.collateral as offer_collateral,
      (select string_agg(k.description, '; ' order by k.created_at) from loan_collateral k
        where k.loan_id = l.id and k.status <> 'released') as collateral,
      lc.id as case_id, lc.number, lc.default_at_override, lc.details_requested_at, lc.contract_shared_at,
      lc.closed_at, lc.close_note, lc.contract_instalment_cents, lc.contract_instalment_reason, lc.contract_instalment_at,
      (select x.character_name from staff x where x.id = lc.contract_instalment_by_staff_id) as contract_instalment_by, h.handed_at, h.sheet->>'totalCents' as handover_total,
      exists (select 1 from ${ACTIVE_FEE_LINKS} a where a.case_id = lc.id) as fee_paid
    from loan l
    left join staff s on s.id = l.officer_staff_id
    left join lateral (
      select c.parsed from loan_card c join loan_paste p on p.id = c.paste_id
       where c.loan_id = l.id order by p.captured_at desc, c.id desc limit 1) c on true
    left join lateral (
      select o.default_fee_per_day_cents, o.collateral from loan_offer o
       where o.loan_id = l.id and o.status = 'funded' order by o.funded_at desc nulls last limit 1) o on true
    left join legal_case lc on lc.loan_id = l.id
    left join lateral (
      select h.id, h.handed_at, h.sheet from legal_case_handover h where h.case_id = lc.id order by h.handed_at desc limit 1) h on true
    where l.retired_at is null and l.status in ('defaulted', 'written_off') ${scope} ${extra}
    order by l.first_default_at desc nulls last, l.id`);
  return res.rows;
}

type Recovery = { loanId: string; occurredAt: Date; netCents: number };

async function recoveriesFor(executor: Executor, loanIds: string[]): Promise<Map<string, Recovery[]>> {
  const out = new Map<string, Recovery[]>();
  if (!loanIds.length) return out;
  const res = await executor.execute<{ loan_id: string; occurred_at: Date | string; net: string | number }>(sql`
    select k.loan_id, b.occurred_at, b.amount_cents - b.tax_cents as net
      from loan_payment_link k join bank_transaction b on b.id = k.bank_transaction_id
     where k.role = 'recovery' and k.loan_id in (${sql.join(loanIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  for (const r of res.rows) out.set(r.loan_id, [...(out.get(r.loan_id) ?? []), { loanId: r.loan_id, occurredAt: new Date(r.occurred_at), netCents: Number(r.net) }]);
  return out;
}

const sumBetween = (rs: Recovery[], from: Date | null, to: Date | null) =>
  rs.filter((r) => (!from || r.occurredAt >= from) && (!to || r.occurredAt < to)).reduce((s, r) => s + r.netCents, 0);

type Computed = {
  row: CaseRow;
  feePerDayCents: number | null;
  collateralText: string | null;
  defaultAtOverride: Date | null;
  closeNote: string | null;
  unsecured: boolean;
  cardInstalmentCents: number | null;
  contractNote: ContractNote | null;
};

function compute(r: Raw, recoveries: Recovery[], now: Date): Computed {
  const card = r.card;
  const cardInstalmentCents = card?.headerAmountCents ?? null;
  const instalments = card?.instalments ?? r.instalments;
  const contractCents = num(r.contract_instalment_cents);
  const contractNote: ContractNote | null =
    contractCents !== null
      ? { cents: contractCents, reason: r.contract_instalment_reason ?? "", byName: r.contract_instalment_by, at: date(r.contract_instalment_at)! }
      : null;
  // The sheet always claims what the game charges (owner, 2026-11-10), whatever the contract says.
  const instalmentCents = cardInstalmentCents;
  const completed = card?.completed ?? r.last_completed ?? 0;
  const override = date(r.default_at_override);
  const { at: defaultAt, rule: defaultRule } = caseDefault({
    firstDefaultAt: date(r.first_default_at),
    firstMissedAt: date(card?.firstMissedAt),
    missedPayments: card?.missedPayments ?? null,
    periodDays: r.period_days,
    override,
  });
  const feePerDayCents = num(r.default_fee_per_day_cents) ?? num(r.offer_fee);
  const collateralText = r.unsecured ? UNSECURED : (r.collateral ?? r.offer_collateral ?? null);
  const missing: CaseMissing[] = [];
  if (instalmentCents === null || !instalments) missing.push("card");
  if (!defaultAt || defaultRule === "unconfirmed") missing.push("default_date");
  if (!feePerDayCents || feePerDayCents <= 0) missing.push("fee_per_day");
  if (!collateralText) missing.push("collateral");
  if (r.unsecured && r.collateral) missing.push("collateral_conflict");
  const claimCents = instalmentCents !== null && instalments ? instalmentCents * Math.max(0, instalments - completed) : null;
  const preview =
    missing.length === 0
      ? buildSheet({
          borrowerName: r.borrower_name ?? `State ID ${r.borrower_state_id}`,
          stateId: r.borrower_state_id,
          instalmentCents: instalmentCents!,
          instalments: instalments!,
          completed,
          feePerDayCents: feePerDayCents!,
          defaultAt: defaultAt!,
          asOf: now,
          receivedCents: sumBetween(recoveries, defaultAt, now),
          collateral: collateralText!,
        })
      : null;
  const handedAt = date(r.handed_at);
  const closedAt = date(r.closed_at);
  const state: CaseState = closedAt ? "closed" : handedAt ? "with_legal" : missing.length ? "needs_details" : "ready";
  const row: CaseRow = {
    loanId: r.id,
    caseId: r.case_id,
    number: r.number,
    borrowerName: r.borrower_name ?? `State ID ${r.borrower_state_id}`,
    stateId: r.borrower_state_id,
    officerStaffId: r.officer_staff_id,
    officerName: r.officer_name,
    officerWorking: r.officer_working,
    state,
    missing,
    defaultAt,
    defaultRule,
    claimCents,
    preview,
    totalCents: handedAt ? num(r.handover_total) : (preview?.totalCents ?? null),
    handedAt,
    feePaid: r.fee_paid,
    detailsRequestedAt: date(r.details_requested_at),
    contractSharedAt: date(r.contract_shared_at),
    closedAt,
  };
  return { row, feePerDayCents, collateralText, defaultAtOverride: override, closeNote: r.close_note, unsecured: r.unsecured, cardInstalmentCents, contractNote };
}

export async function listCases(viewer: Viewer, now: Date = new Date()): Promise<CaseRow[]> {
  const raw = await loadRaw(db, viewer);
  const rec = await recoveriesFor(
    db,
    raw.map((r) => r.id),
  );
  return raw.map((r) => compute(r, rec.get(r.id) ?? [], now).row);
}

async function computedOne(executor: Executor, viewer: Viewer, loanId: string, now: Date): Promise<Computed | null> {
  if (!z.uuid().safeParse(loanId).success) return null;
  const [r] = await loadRaw(executor, viewer, sql`l.id = ${loanId}`);
  if (!r) return null;
  const rec = await recoveriesFor(executor, [r.id]);
  return compute(r, rec.get(r.id) ?? [], now);
}

/** Fee payments linked to the case; suggestions are added by `fees.ts`. */
async function feeRows(executor: Executor, caseId: string): Promise<FeeRow[]> {
  const res = await executor.execute<{ id: string; occurred_at: Date | string; amount_cents: string | number; comment: string }>(sql`
    select b.id, b.occurred_at, b.amount_cents, b.comment from ${ACTIVE_FEE_LINKS} f join bank_transaction b on b.id = f.bank_transaction_id
     where f.case_id = ${caseId} order by b.occurred_at`);
  return res.rows.map((r) => ({ txId: r.id, occurredAt: new Date(r.occurred_at), amountCents: Number(r.amount_cents), comment: r.comment }));
}

export async function legalStaffOptions(executor: Executor = db): Promise<{ id: string; name: string; stateId: number }[]> {
  const rows = await executor
    .select({ id: staff.id, name: staff.characterName, stateId: staff.stateId })
    .from(staff)
    .where(and(eq(staff.role, "legal"), inArray(staff.status, [...WORKING_STATUSES])))
    .orderBy(asc(staff.characterName));
  return rows;
}

/** Full detail, or null if the loan has no case or the viewer may not see it. */
export async function getCase(viewer: Viewer, loanId: string, now: Date = new Date()): Promise<CaseDetail | null> {
  const computed = await computedOne(db, viewer, loanId, now);
  if (!computed) return null;
  const c = computed.row;
  const settings = await getSettings();
  const handovers = c.caseId ? await db.select().from(legalCaseHandover).where(eq(legalCaseHandover.caseId, c.caseId)).orderBy(asc(legalCaseHandover.handedAt)) : [];
  const handover = handovers.at(-1) ?? null;
  let payee: CaseDetail["payee"] = null;
  let payeeWallet: string | null = null;
  if (handover) {
    const [p] = await db.select({ staffId: staff.id, name: staff.characterName, stateId: staff.stateId, walletId: staff.walletId }).from(staff).where(eq(staff.id, handover.payeeStaffId));
    payee = p ? { staffId: p.staffId, name: p.name, stateId: p.stateId } : null;
    payeeWallet = p?.walletId ?? null;
  }
  const feePayments = c.caseId ? await feeRows(db, c.caseId) : [];
  const rec = (await recoveriesFor(db, [c.loanId])).get(c.loanId) ?? [];
  const recoveredSinceHandoverCents = handover ? sumBetween(rec, handover.handedAt, null) : 0;
  const feePaidCents = feePayments.reduce((s, f) => s + f.amountCents, 0);
  const claim = handover ? (handover.sheet as CaseSheet).totalCents : (c.preview?.totalCents ?? null);
  return {
    ...c,
    closeNote: computed.closeNote,
    cardInstalmentCents: computed.cardInstalmentCents,
    contractNote: computed.contractNote,
    defaultAtOverride: computed.defaultAtOverride,
    feePerDayCents: computed.feePerDayCents,
    unsecured: computed.unsecured,
    collateral: computed.collateralText,
    handover,
    earlierHandovers: Math.max(0, handovers.length - 1),
    feeCents: handover?.feeCents ?? settings.legal.caseFeeDollars * 100,
    payee,
    feePayments,
    feeSuggestions: handover
      ? await feeSuggestions(db, {
          caseId: c.caseId!,
          caseNumber: c.number!,
          borrowerName: c.borrowerName,
          since: handovers[0].handedAt,
          feeCents: handover.feeCents,
          payeeWallet: payeeWallet ?? null,
        })
      : [],
    recoveredSinceHandoverCents,
    feePaidCents,
    // The fee counts once handed over, paid or not (the spec's "recovered − fee").
    netForLittsCents: recoveredSinceHandoverCents - (handover ? Math.max(feePaidCents, handover.feeCents) : feePaidCents),
    stillOwedCents: claim === null ? null : Math.max(0, claim - recoveredSinceHandoverCents),
    legalStaff: await legalStaffOptions(),
  };
}

// ---------------------------------------------------------------- changes

const loanIdSchema = z.object({ loanId: z.uuid() });

/** The loan behind a case, if the viewer may see it; throws otherwise. */
async function caseLoan(executor: Executor, viewer: Viewer, loanId: string): Promise<typeof loan.$inferSelect> {
  const [l] = await executor
    .select()
    .from(loan)
    .where(and(liveLoan, eq(loan.id, loanId), inArray(loan.status, [...CASE_LOAN_STATUSES])));
  if (!l || !canSeeLoan(viewer, l)) throw new LoanError("Case not found.");
  return l;
}

/** The loan's case row, created by the first action on it. */
async function ensureCase(tx: Tx, loanId: string): Promise<typeof legalCase.$inferSelect> {
  // Select first: an insert that conflicts still uses up a case number (LC numbers would skip).
  const [found] = await tx.select().from(legalCase).where(eq(legalCase.loanId, loanId));
  if (found) return found;
  await tx.insert(legalCase).values({ loanId }).onConflictDoNothing({ target: legalCase.loanId });
  const [c] = await tx.select().from(legalCase).where(eq(legalCase.loanId, loanId));
  return c;
}

/** The case row, locked for the rest of the transaction (two people acting at once go one after the other). */
async function lockCase(tx: Tx, loanId: string): Promise<typeof legalCase.$inferSelect> {
  const c = await ensureCase(tx, loanId);
  const [locked] = await tx.select().from(legalCase).where(eq(legalCase.id, c.id)).for("update");
  return locked;
}

const handedOver = async (tx: Tx, caseId: string) =>
  (await tx.select({ id: legalCaseHandover.id }).from(legalCaseHandover).where(eq(legalCaseHandover.caseId, caseId)).limit(1)).length > 0;

const audit = async (tx: Tx, viewer: Viewer, action: string, loanId: string, metadata: Record<string, unknown>) =>
  recordAudit(tx, { actor: { type: "staff", staffId: viewer.staffId }, action, target: { type: "loan", id: loanId }, metadata, request: await getRequestMeta() });

export const legalTermsSchema = z
  .object({
    loanId: z.uuid(),
    feePerDayDollars: z.number().int().positive("The fee per day must be more than $0.").max(10_000_000).nullable(),
    unsecured: z.boolean(),
    /** Collateral to record with them, in the same save. */
    collateral: z.string().trim().min(2, "Describe the collateral.").max(300).optional(),
  })
  .refine((v) => !(v.unsecured && v.collateral), { message: "An unsecured loan has no collateral.", path: ["collateral"] });

/**
 * The contract details only the officer has: the Defaulted Account Fee per day, whether the loan is unsecured, and
 * (optionally) its collateral — saved together. Once the case is with Legal only management changes them (to hand it
 * over again); a closed case is never changed.
 */
export async function setLegalTerms(viewer: Viewer, raw: z.input<typeof legalTermsSchema>): Promise<void> {
  const input = legalTermsSchema.parse(raw);
  await db.transaction(async (tx) => {
    const l = await caseLoan(tx, viewer, input.loanId);
    if (!canAnnotateLoan(viewer, l)) throw new ForbiddenError();
    const [c] = await tx.select().from(legalCase).where(eq(legalCase.loanId, l.id));
    if (c?.closedAt) throw new LoanError("This case is closed.");
    if (c && !canCloseCase(viewer) && (await handedOver(tx, c.id))) throw new LoanError("This case is already with Legal. Management can change its details and hand it over again.");
    const feeCents = input.feePerDayDollars === null ? null : input.feePerDayDollars * 100;
    if (input.collateral) {
      const [k] = await tx.insert(loanCollateral).values({ loanId: l.id, description: input.collateral, createdByStaffId: viewer.staffId }).returning({ id: loanCollateral.id });
      await tx.insert(loanEvent).values({ loanId: l.id, kind: "collateral_added", staffId: viewer.staffId, detail: { collateralId: k.id, description: input.collateral } });
      await audit(tx, viewer, "loans.collateral_added", l.id, { collateralId: k.id, description: input.collateral, estimatedValueCents: null });
    }
    await tx.update(loan).set({ defaultFeePerDayCents: feeCents, unsecured: input.unsecured, updatedAt: new Date() }).where(eq(loan.id, l.id));
    await tx.insert(loanEvent).values({ loanId: l.id, kind: "legal_terms_set", staffId: viewer.staffId, detail: { feePerDayCents: feeCents, unsecured: input.unsecured } });
    await audit(tx, viewer, "legal.terms_set", l.id, { from: { feePerDayCents: l.defaultFeePerDayCents, unsecured: l.unsecured }, to: { feePerDayCents: feeCents, unsecured: input.unsecured } });
  });
}

/** Ask the loan's officer for the contract details (their bell shows it until the case is ready). */
export async function requestDetails(viewer: Viewer, raw: z.input<typeof loanIdSchema>): Promise<void> {
  const input = loanIdSchema.parse(raw);
  await db.transaction(async (tx) => {
    const l = await caseLoan(tx, viewer, input.loanId);
    if (!l.officerStaffId) throw new LoanError("This loan has no officer to ask. Assign one, or fill in the details yourself.");
    const [o] = await tx.select({ name: staff.characterName, status: staff.status, role: staff.role }).from(staff).where(eq(staff.id, l.officerStaffId));
    if (!o || !(WORKING_STATUSES as readonly string[]).includes(o.status) || o.role === "legal") {
      throw new LoanError(`${o?.name ?? "The officer"} no longer works for Litt’s: fill in the details yourself, or give the loan a new officer.`);
    }
    const c = await ensureCase(tx, l.id);
    await tx.update(legalCase).set({ detailsRequestedAt: new Date(), detailsRequestedByStaffId: viewer.staffId }).where(eq(legalCase.id, c.id));
    await audit(tx, viewer, "legal.details_requested", l.id, { caseNumber: c.number, officerStaffId: l.officerStaffId });
  });
}

export const contractSharedSchema = z.object({ loanId: z.uuid(), shared: z.boolean() });

/** The officer has shared the signed in-game contract with the lawyer (informational). */
export async function markContractShared(viewer: Viewer, raw: z.input<typeof contractSharedSchema>): Promise<void> {
  const input = contractSharedSchema.parse(raw);
  await db.transaction(async (tx) => {
    const l = await caseLoan(tx, viewer, input.loanId);
    if (!canAnnotateLoan(viewer, l)) throw new ForbiddenError();
    const c = await ensureCase(tx, l.id);
    await tx
      .update(legalCase)
      .set(input.shared ? { contractSharedAt: new Date(), contractSharedByStaffId: viewer.staffId } : { contractSharedAt: null, contractSharedByStaffId: null })
      .where(eq(legalCase.id, c.id));
    await audit(tx, viewer, "legal.contract_shared", l.id, { caseNumber: c.number, shared: input.shared });
  });
}

export const caseDefaultDateSchema = z.object({
  loanId: z.uuid(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  reason: z.string().trim().min(3, "Say why the date is different.").max(300),
});

/** Correct the date the case counts from (an odd case); null goes back to the date from the cards. */
export async function setCaseDefaultDate(viewer: Viewer, raw: z.input<typeof caseDefaultDateSchema>, now: Date = new Date()): Promise<void> {
  const input = caseDefaultDateSchema.parse(raw);
  await db.transaction(async (tx) => {
    const l = await caseLoan(tx, viewer, input.loanId);
    if (!canHandToLegal(viewer, l)) throw new ForbiddenError();
    const c = await ensureCase(tx, l.id);
    const [handed] = await tx.select({ id: legalCaseHandover.id }).from(legalCaseHandover).where(eq(legalCaseHandover.caseId, c.id)).limit(1);
    if (handed && !canCloseCase(viewer)) throw new LoanError("This case is already with Legal. Management can correct it and hand it over again.");
    const at = input.date ? new Date(`${input.date}T12:00:00Z`) : null;
    // Compared as London days: today is allowed at any hour.
    if (input.date && input.date > londonDay(now)) throw new LoanError("The default date can't be in the future.");
    await tx.update(legalCase).set({ defaultAtOverride: at }).where(eq(legalCase.id, c.id));
    await audit(tx, viewer, "legal.default_date_set", l.id, { caseNumber: c.number, from: c.defaultAtOverride?.toISOString() ?? null, to: at?.toISOString() ?? null, reason: input.reason });
  });
}

export const contractNoteSchema = z.object({
  loanId: z.uuid(),
  /** The weekly payment the contract states, in whole dollars; null removes the note. */
  dollars: z.number().int().positive("The amount must be more than $0.").max(100_000_000).nullable(),
  reason: z.string().trim().min(3, "Say why the contract differs.").max(300),
});

/**
 * Management notes that the signed contract states a different weekly payment from the game's (an officer's one-off
 * mistake on the paper), for Legal. The sheet keeps claiming the phone card's amount; nobody else types this.
 */
export async function setContractNote(viewer: Viewer, raw: z.input<typeof contractNoteSchema>): Promise<void> {
  if (!canCloseCase(viewer)) throw new ForbiddenError();
  const input = contractNoteSchema.parse(raw);
  await db.transaction(async (tx) => {
    const l = await caseLoan(tx, viewer, input.loanId);
    const c = await lockCase(tx, l.id);
    if (c.closedAt) throw new LoanError("This case is closed.");
    const cents = input.dollars === null ? null : input.dollars * 100;
    if (cents === c.contractInstalmentCents) throw new LoanError(cents === null ? "There’s no contract note to remove." : "That’s already the contract’s amount.");
    await tx
      .update(legalCase)
      .set(
        cents === null
          ? { contractInstalmentCents: null, contractInstalmentReason: null, contractInstalmentByStaffId: null, contractInstalmentAt: null }
          : { contractInstalmentCents: cents, contractInstalmentReason: input.reason, contractInstalmentByStaffId: viewer.staffId, contractInstalmentAt: new Date() },
      )
      .where(eq(legalCase.id, c.id));
    await audit(tx, viewer, "legal.contract_note_set", l.id, { caseNumber: c.number, fromCents: c.contractInstalmentCents, toCents: cents, reason: input.reason });
  });
}

export const handToLegalSchema = z.object({
  loanId: z.uuid(),
  payeeStaffId: z.uuid(),
  reason: z.string().trim().max(300).optional(),
  /** The total the person saw; refused if the sheet has moved on since (midnight passed, a new card). */
  expectedTotalCents: z.number().int().optional(),
});

const MISSING_TEXT: Record<CaseMissing, string> = {
  card: "a phone card",
  default_date: "the default date",
  fee_per_day: "the fee per day",
  collateral: "the collateral (or tick Unsecured)",
  collateral_conflict: "Unsecured or the collateral (both are set)",
};

/**
 * Hand the case to Legal: the sheet is counted to today and frozen, the attorney & filing fee is set from the settings,
 * and Collections records "Handed to Legal". Handing over again (a mistake) is management's, with a reason; the earlier
 * hand-over stays as it was.
 */
export async function handToLegal(viewer: Viewer, raw: z.input<typeof handToLegalSchema>, now: Date = new Date()): Promise<void> {
  const input = handToLegalSchema.parse(raw);
  await db.transaction(async (tx) => {
    const l = await caseLoan(tx, viewer, input.loanId);
    if (!canHandToLegal(viewer, l)) throw new ForbiddenError();
    // Lock the case first: two people pressing at once go one after the other, and the second sees it's with Legal.
    await lockCase(tx, l.id);
    const c = (await computedOne(tx, viewer, l.id, now))?.row;
    if (!c) throw new LoanError("Case not found.");
    if (c.state === "closed") throw new LoanError("This case is closed.");
    const again = c.state === "with_legal";
    if (again && !canCloseCase(viewer)) throw new LoanError("This case is already with Legal. Management can hand it over again.");
    if (again && (input.reason ?? "").length < 3) throw new LoanError("Say why it's being handed over again (a reason).");
    if (!c.preview) throw new LoanError(`Fill in ${c.missing.map((m) => MISSING_TEXT[m]).join(", ")} first.`);
    if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== c.preview.totalCents) {
      throw new LoanError(`The figures changed since this page was loaded (now ${formatCents(c.preview.totalCents)}). Check the sheet and hand it over again.`);
    }
    const [payee] = await tx.select().from(staff).where(eq(staff.id, input.payeeStaffId));
    if (!payee || payee.role !== "legal" || !(WORKING_STATUSES as readonly string[]).includes(payee.status)) throw new LoanError("The fee is paid to a member of the Legal Team.");
    const settings = await getSettings(tx);
    const row = await ensureCase(tx, l.id);
    const text = sheetText(c.preview);
    const feeCents = settings.legal.caseFeeDollars * 100;
    const [h] = await tx
      .insert(legalCaseHandover)
      .values({ caseId: row.id, handedAt: now, handedByStaffId: viewer.staffId, payeeStaffId: payee.id, feeCents, sheet: c.preview, text, reason: again ? input.reason! : null })
      .returning({ id: legalCaseHandover.id });
    await tx.insert(loanCollectionAction).values({ loanId: l.id, staffId: viewer.staffId, kind: "handed_to_legal", note: `Case #LC${row.number} handed to Legal`, at: now });
    await tx.insert(loanEvent).values({ loanId: l.id, at: now, kind: "handed_to_legal", staffId: viewer.staffId, detail: { caseNumber: row.number, handoverId: h.id, totalCents: c.preview.totalCents } });
    await audit(tx, viewer, "legal.handed_over", l.id, { caseNumber: row.number, handoverId: h.id, again, reason: again ? input.reason : null, totalCents: c.preview.totalCents, feeCents, payeeStaffId: payee.id });
  });
}

export const closeCaseSchema = z.object({ loanId: z.uuid(), note: z.string().trim().min(3, "Add a short note.").max(500) });

/** Take a case off the open list (management): e.g. collateral sold and the rest unrecoverable. */
export async function closeCase(viewer: Viewer, raw: z.input<typeof closeCaseSchema>): Promise<void> {
  const input = closeCaseSchema.parse(raw);
  if (!canCloseCase(viewer)) throw new ForbiddenError();
  await db.transaction(async (tx) => {
    const l = await caseLoan(tx, viewer, input.loanId);
    const c = await ensureCase(tx, l.id);
    if (c.closedAt) throw new LoanError("This case is already closed.");
    await tx.update(legalCase).set({ closedAt: new Date(), closedByStaffId: viewer.staffId, closeNote: input.note }).where(eq(legalCase.id, c.id));
    await audit(tx, viewer, "legal.closed", l.id, { caseNumber: c.number, note: input.note });
  });
}

export const confirmFeeSchema = z.object({ loanId: z.uuid(), txId: z.uuid() });

/** A fee payment typed without the case reference: a person says it's this case's (the officer, Legal and up). */
export async function confirmFeePayment(viewer: Viewer, raw: z.input<typeof confirmFeeSchema>): Promise<void> {
  const input = confirmFeeSchema.parse(raw);
  await db.transaction(async (tx) => {
    const l = await caseLoan(tx, viewer, input.loanId);
    if (!canAnnotateLoan(viewer, l)) throw new ForbiddenError();
    const [c] = await tx.select().from(legalCase).where(eq(legalCase.loanId, l.id));
    const [handed] = c ? await tx.select({ id: legalCaseHandover.id }).from(legalCaseHandover).where(eq(legalCaseHandover.caseId, c.id)).limit(1) : [];
    if (!c || !handed) throw new LoanError("This case hasn't been handed to Legal yet.");
    const [b] = await tx.select().from(bankTransaction).where(eq(bankTransaction.id, input.txId));
    if (!b || b.direction !== "out" || b.category !== "legal") throw new LoanError("That bank row isn't a legal fee payment.");
    if (await activeFeeLink(tx, b.id)) throw new LoanError("That payment is already linked to a case.");
    await tx.insert(legalFeeLink).values({ bankTransactionId: b.id, caseId: c.id, action: "link", method: "confirmed", staffId: viewer.staffId });
    await audit(tx, viewer, "legal.fee_confirmed", l.id, { caseNumber: c.number, bankTransactionId: b.id, amountCents: b.amountCents });
  });
}

export const unlinkFeeSchema = z.object({ loanId: z.uuid(), txId: z.uuid(), reason: z.string().trim().min(3, "Say why it isn't this case's fee.").max(300) });

/** A payment linked to the wrong case (a mistyped reference, a wrong "This is the fee"): management undoes it. */
export async function unlinkFeePayment(viewer: Viewer, raw: z.input<typeof unlinkFeeSchema>): Promise<void> {
  if (!canCloseCase(viewer)) throw new ForbiddenError();
  const input = unlinkFeeSchema.parse(raw);
  await db.transaction(async (tx) => {
    const l = await caseLoan(tx, viewer, input.loanId);
    const [c] = await tx.select().from(legalCase).where(eq(legalCase.loanId, l.id));
    const current = await activeFeeLink(tx, input.txId);
    if (!c || current?.caseId !== c.id) throw new LoanError("That payment isn't linked to this case.");
    await tx.insert(legalFeeLink).values({ bankTransactionId: input.txId, caseId: c.id, action: "unlink", reason: input.reason, staffId: viewer.staffId });
    await audit(tx, viewer, "legal.fee_unlinked", l.id, { caseNumber: c.number, bankTransactionId: input.txId, reason: input.reason });
  });
}
