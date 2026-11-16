import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { MortgagePayment } from "@/domain/mortgages/schedule";
import { db } from "@/server/db";
import { bankTransaction, mortgagePayment, mortgageSettlement } from "@/server/db/schema";

const outTx = alias(bankTransaction, "out_tx");


/** Repayments (in-leg) with the principal forwarded to the State (out-leg, once paired). */
export async function paymentsByMortgage(ids: string[]): Promise<Map<string, MortgagePayment[]>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      mortgageId: mortgagePayment.mortgageId,
      txId: bankTransaction.id,
      occurredAt: bankTransaction.occurredAt,
      grossCents: bankTransaction.amountCents,
      taxCents: bankTransaction.taxCents,
      toStateCents: outTx.amountCents,
    })
    .from(mortgagePayment)
    .innerJoin(bankTransaction, eq(bankTransaction.id, mortgagePayment.bankTransactionId))
    .leftJoin(mortgageSettlement, and(eq(mortgageSettlement.inTxId, bankTransaction.id), isNull(mortgageSettlement.unwoundAt)))
    .leftJoin(outTx, eq(outTx.id, mortgageSettlement.outTxId))
    .where(inArray(mortgagePayment.mortgageId, ids))
    .orderBy(asc(bankTransaction.occurredAt));
  const out = new Map<string, MortgagePayment[]>();
  for (const r of rows) {
    const list = out.get(r.mortgageId) ?? [];
    list.push({ txId: r.txId, occurredAt: r.occurredAt, grossCents: r.grossCents, taxCents: r.taxCents, toStateCents: r.toStateCents ?? null });
    out.set(r.mortgageId, list);
  }
  return out;
}

