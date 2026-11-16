/**
 * Transaction categories and how each posts to the ledger (docs/design/LEDGER.md).
 *
 * - `account`: the counter-account to cash.
 * - `direction`: which bank direction the category is valid for.
 * - `tax`: for incoming rows with tax withheld — "expense" (the company bears
 *   it; credit the gross amount, debit 5200) or "passthrough" (the buyer's
 *   tax; credit the net amount only).
 */
export type Direction = "in" | "out";

type CategoryDef = {
  label: string;
  group: "Lending" | "Mortgages" | "Legacy loans" | "Staff" | "Capital" | "Operations" | "Tax" | "Review";
  account: string;
  direction: Direction | "either";
  tax: "expense" | "passthrough";
  /** Staff may pick this category when reclassifying. */
  selectable: boolean;
};

export const CATEGORIES = {
  "loan.disbursement": { label: "Loan disbursement", group: "Lending", account: "1100", direction: "out", tax: "expense", selectable: true },
  "loan.origination_fee": { label: "Loan broker fee", group: "Lending", account: "4200", direction: "in", tax: "expense", selectable: true },
  "loan.principal": { label: "Loan principal repayment", group: "Lending", account: "1100", direction: "in", tax: "expense", selectable: true },
  "loan.interest": { label: "Loan interest", group: "Lending", account: "4000", direction: "in", tax: "expense", selectable: true },
  "loan.early_principal": { label: "Early repayment (principal)", group: "Lending", account: "1100", direction: "in", tax: "expense", selectable: true },
  "loan.early_interest": { label: "Early repayment (interest)", group: "Lending", account: "4010", direction: "in", tax: "expense", selectable: true },
  "loan.late_principal": { label: "Late repayment", group: "Lending", account: "1100", direction: "in", tax: "expense", selectable: true },
  "loan.late_fee": { label: "Late fee", group: "Lending", account: "4000", direction: "in", tax: "expense", selectable: true },
  "loan.refund": { label: "Refund to a borrower (game error)", group: "Lending", account: "4390", direction: "out", tax: "expense", selectable: true },

  "mortgage.legacy_broker_interest": { label: "Legacy mortgage broker interest", group: "Mortgages", account: "4110", direction: "in", tax: "expense", selectable: true },
  "mortgage.legacy_banker_fee": { label: "Legacy mortgage banker fee", group: "Mortgages", account: "4100", direction: "in", tax: "expense", selectable: true },
  "mortgage.legacy_banker_fee_refund": { label: "Legacy mortgage banker fee refunded (charged twice)", group: "Mortgages", account: "4100", direction: "out", tax: "expense", selectable: true },
  "mortgage.origination_in": { label: "Mortgage down payment & fees (in)", group: "Mortgages", account: "1110", direction: "in", tax: "passthrough", selectable: false },
  "mortgage.origination_out": { label: "Mortgage property loan & fees (to State)", group: "Mortgages", account: "1110", direction: "out", tax: "passthrough", selectable: false },
  "mortgage.repayment_in": { label: "Mortgage instalment (in)", group: "Mortgages", account: "1110", direction: "in", tax: "passthrough", selectable: false },
  "mortgage.repayment_out": { label: "Mortgage instalment (to State)", group: "Mortgages", account: "1110", direction: "out", tax: "passthrough", selectable: false },

  "legacy_loan.disbursement": { label: "Legacy manual loan (disbursement)", group: "Legacy loans", account: "1190", direction: "out", tax: "expense", selectable: true },
  "legacy_loan.repayment": { label: "Legacy manual loan (repayment)", group: "Legacy loans", account: "1190", direction: "in", tax: "expense", selectable: true },

  commission: { label: "Commission", group: "Staff", account: "5000", direction: "out", tax: "expense", selectable: true },
  staff_pay: { label: "Staff pay & bonuses", group: "Staff", account: "5050", direction: "out", tax: "expense", selectable: true },
  "staff_loan.received": { label: "Loan from staff (received)", group: "Staff", account: "2200", direction: "in", tax: "expense", selectable: true },
  "staff_loan.repaid": { label: "Loan from staff (repaid)", group: "Staff", account: "2200", direction: "out", tax: "expense", selectable: true },

  "capital.contribution": { label: "Capital contributed", group: "Capital", account: "3000", direction: "in", tax: "expense", selectable: true },
  "capital.return": { label: "Capital returned / distribution", group: "Capital", account: "3200", direction: "out", tax: "expense", selectable: true },

  "recovery.settlement": { label: "Settlement or payment plan (recovery)", group: "Operations", account: "4300", direction: "in", tax: "expense", selectable: true },
  "recovery.seizure": { label: "Government seizure (recovery)", group: "Operations", account: "4300", direction: "in", tax: "expense", selectable: true },
  collateral_sale: { label: "Collateral sale (recovery)", group: "Operations", account: "4300", direction: "in", tax: "expense", selectable: true },
  collection_cost: { label: "Collection & repossession cost", group: "Operations", account: "5450", direction: "out", tax: "expense", selectable: true },
  legal: { label: "Legal fees", group: "Operations", account: "5400", direction: "out", tax: "expense", selectable: true },
  marketing: { label: "Marketing", group: "Operations", account: "5500", direction: "out", tax: "expense", selectable: true },
  refund: { label: "Refund / reimbursement", group: "Operations", account: "5600", direction: "either", tax: "expense", selectable: true },
  other_income: { label: "Other income", group: "Operations", account: "4900", direction: "in", tax: "expense", selectable: true },
  other_expense: { label: "Other expense", group: "Operations", account: "5900", direction: "out", tax: "expense", selectable: true },

  "tax.remittance_record": { label: "Monthly tax record (no cash)", group: "Tax", account: "9000", direction: "out", tax: "expense", selectable: false },
  unclassified: { label: "Needs review", group: "Review", account: "1900", direction: "either", tax: "expense", selectable: false },
} as const satisfies Record<string, CategoryDef>;

export type Category = keyof typeof CATEGORIES;

export function isCategory(value: string): value is Category {
  return Object.hasOwn(CATEGORIES, value);
}

export function categoryAllows(category: Category, direction: Direction): boolean {
  const d = CATEGORIES[category].direction;
  return d === "either" || d === direction;
}

/** Categories a person may assign to a row with this direction. */
export function selectableCategories(direction: Direction): Category[] {
  return (Object.keys(CATEGORIES) as Category[]).filter(
    (c) => CATEGORIES[c].selectable && categoryAllows(c, direction),
  );
}
