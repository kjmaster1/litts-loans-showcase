import { categoryAllows, type Category, type Direction } from "@/domain/ledger/categories";
import { STATE_LENDING_WALLET, TAX_ESCROW_WALLET } from "./constants";

/**
 * Rule-based classification of bank rows (docs/design/LEDGER.md).
 * Bump RULESET_VERSION whenever a rule changes meaning; it's stored per row so
 * old classifications can be identified and re-run deliberately.
 *
 * Two kinds of rows:
 * - game-generated: fixed wording → "certain";
 * - manual (staff typed the comment): explicit `[TAG]` → "tag", keyword match →
 *   "heuristic", nothing → "unclassified" (goes to the review queue).
 */
export const RULESET_VERSION = 2;

export type Confidence = "certain" | "tag" | "heuristic" | "unclassified";

export type ClassifyInput = {
  direction: Direction;
  txType: string;
  comment: string;
  targetWallet: string | null;
};

export type Classification = {
  category: Category;
  confidence: Confidence;
  /** Stable rule identifier, shown in the UI to explain the decision. */
  rule: string;
  /** Property address for mortgage pass-through legs. */
  address?: string;
};

type Rule = {
  id: string;
  confidence: Exclude<Confidence, "unclassified" | "tag">;
  category: Category;
  when: (r: ClassifyInput & { text: string }) => boolean;
};

const MORTGAGE_LEG = /^(.+?): (Down Payment & Fees|Property Loan & Fees|(?:Final )?Loan Repayment)\s*$/;
/** The game words a mortgage's last instalment "Final Loan Repayment" (first seen 5 Nov 2026). */
const MORTGAGE_REPAYMENT = /: (?:Final )?Loan Repayment\s*$/;

/** Tags staff can put at the start of a manual comment (shown in the app). */
export const COMMENT_TAGS = {
  REPO: { in: "collateral_sale", out: null, description: "Sale of repossessed collateral" },
  TOW: { in: null, out: "collection_cost", description: "Towing, impound or other repossession cost" },
  LEGAL: { in: null, out: "legal", description: "Attorney, filing or other legal fee" },
  COMM: { in: null, out: "commission", description: "Commission paid to staff" },
  PAY: { in: null, out: "staff_pay", description: "Staff wages, bonus or severance" },
  REFUND: { in: "refund", out: "refund", description: "Refund paid, or a mistaken payment recovered" },
  CAPITAL: { in: "capital.contribution", out: null, description: "Investment into the company" },
  PAYBACK: { in: null, out: "capital.return", description: "Investment returned / profit distributed" },
  STAFFLOAN: { in: "staff_loan.received", out: "staff_loan.repaid", description: "Money borrowed from / repaid to staff" },
  MARKETING: { in: null, out: "marketing", description: "Marketing and advertising" },
  OTHER: { in: "other_income", out: "other_expense", description: "Anything else" },
} as const satisfies Record<string, { in: Category | null; out: Category | null; description: string }>;

const TAG = /^\s*(?:(?:Employee Pay|Charge|Cash Deposit|Transfer|Invoice Payment)\s*:?\s*)*\[([A-Za-z]+)\]/;

/** Ordered: first match wins. Game-generated rules come first. */
const RULES: Rule[] = [
  // --- game-generated (certain) -------------------------------------------
  { id: "tax.record", confidence: "certain", category: "tax.remittance_record", when: (r) => r.txType === "deposit" && r.direction === "out" && r.text === "Tax Payment" && r.targetWallet === TAX_ESCROW_WALLET },
  { id: "loan.subscription", confidence: "certain", category: "loan.principal", when: (r) => r.txType === "transfer" && /^Subscription payment\b/.test(r.text) },
  { id: "mortgage.legacy_broker", confidence: "certain", category: "mortgage.legacy_broker_interest", when: (r) => r.txType === "transfer" && /^Broker percentage payment:/.test(r.text) && /Mortgage Agreement:/.test(r.text) },
  { id: "loan.broker_percentage", confidence: "certain", category: "loan.interest", when: (r) => r.txType === "transfer" && /^Broker percentage payment:/.test(r.text) },
  { id: "loan.early_interest", confidence: "certain", category: "loan.early_interest", when: (r) => r.txType === "transfer" && /^Early Finance Repayment Broker Interest\b/.test(r.text) },
  { id: "loan.early_principal", confidence: "certain", category: "loan.early_principal", when: (r) => r.txType === "transfer" && /^Early Finance Repayment\b/.test(r.text) },
  { id: "loan.late", confidence: "certain", category: "loan.late_principal", when: (r) => r.txType === "transfer" && /^Late Finance Repayment\b/.test(r.text) },
  { id: "loan.transfer", confidence: "certain", category: "loan.disbursement", when: (r) => r.txType === "transfer" && /^Loan Transfer\b/.test(r.text) },
  { id: "loan.broker_fee", confidence: "certain", category: "loan.origination_fee", when: (r) => r.txType === "charge" && r.text === "Broker Fee: Paid Broker Fee" },
  { id: "mortgage.down_payment", confidence: "certain", category: "mortgage.origination_in", when: (r) => r.txType === "transfer" && /: Down Payment & Fees\s*$/.test(r.text) },
  { id: "mortgage.property_loan", confidence: "certain", category: "mortgage.origination_out", when: (r) => r.txType === "transfer" && /: Property Loan & Fees\s*$/.test(r.text) },
  { id: "mortgage.repayment_in", confidence: "certain", category: "mortgage.repayment_in", when: (r) => r.txType === "transfer" && r.direction === "in" && MORTGAGE_REPAYMENT.test(r.text) },
  { id: "mortgage.repayment_out", confidence: "certain", category: "mortgage.repayment_out", when: (r) => r.txType === "transfer" && r.direction === "out" && r.targetWallet === STATE_LENDING_WALLET && MORTGAGE_REPAYMENT.test(r.text) },
  { id: "recovery.seizure", confidence: "certain", category: "recovery.seizure", when: (r) => r.txType === "seize" },

  // --- manual comments (heuristic) -----------------------------------------
  // Explicit doubt in the comment always goes to review.
  { id: "review.uncertain", confidence: "heuristic", category: "unclassified", when: (r) => /\bor something\b|\bask\b|\bI think\b/i.test(r.text) },
  { id: "staff_loan.received", confidence: "heuristic", category: "staff_loan.received", when: (r) => /\bPersonal Loan\b|loan to the company/i.test(r.text) },
  { id: "staff_loan.repaid", confidence: "heuristic", category: "staff_loan.repaid", when: (r) => /Personal Loan Repayment/i.test(r.text) },
  { id: "capital.return", confidence: "heuristic", category: "capital.return", when: (r) => /Investment (Returned|Repayment|Payback)|Profit Investment Payback|Investment Scheme.*Returned|Investments? Reimbursement/i.test(r.text) },
  { id: "capital.contribution", confidence: "heuristic", category: "capital.contribution", when: (r) => /\bInvestment\b|Start-Up Cash|even it out/i.test(r.text) },
  { id: "commission", confidence: "heuristic", category: "commission", when: (r) => /Commission/i.test(r.text) && !/Minus Commission/i.test(r.text) },
  { id: "staff_pay", confidence: "heuristic", category: "staff_pay", when: (r) => /\bBonus\b|\bSeverance\b/i.test(r.text) },
  { id: "legal", confidence: "heuristic", category: "legal", when: (r) => /Attorney|Lawyer|\bLegal\b/i.test(r.text) },
  { id: "collection_cost", confidence: "heuristic", category: "collection_cost", when: (r) => /\bTow\b|Impound|\bRepo\b|Reg repayment/i.test(r.text) },
  { id: "marketing", confidence: "heuristic", category: "marketing", when: (r) => /Flyers?|Leaflet|Promotional|printing/i.test(r.text) },
  { id: "refund", confidence: "heuristic", category: "refund", when: (r) => /Reimburs|Refund|broker fees?\b|Broker Fee ISSUES|Repayment Error|Recovery of mistake/i.test(r.text) },
  { id: "loan.late_fee", confidence: "heuristic", category: "loan.late_fee", when: (r) => /\bLate Fees?\b/i.test(r.text) },
  { id: "collateral_sale", confidence: "heuristic", category: "collateral_sale", when: (r) => /\bSale\b|\bPurchase\b/i.test(r.text) },
  { id: "legacy_loan.disbursement", confidence: "heuristic", category: "legacy_loan.disbursement", when: (r) => /\$[\d,]+ Loan\b|VEHICLE LOAN/i.test(r.text) },
  {
    id: "legacy_loan.repayment",
    confidence: "heuristic",
    category: "legacy_loan.repayment",
    // Excludes notes about modern-system loans paid by hand or money to fund a loan.
    when: (r) => r.txType === "charge" && /\bLoan\b|\bPayment\b|Repayment|\bWeek \d+\b/i.test(r.text) && !/pay ?off|to be given out/i.test(r.text),
  },
];

export function classify(input: ClassifyInput): Classification {
  const text = input.comment.trim();
  const ctx = { ...input, text };

  // Game-generated rules first (they must not be overridden by a tag).
  for (const rule of RULES) {
    if (rule.confidence !== "certain") continue;
    if (rule.when(ctx) && categoryAllows(rule.category, input.direction)) return result(rule.category, "certain", rule.id, text);
  }

  const tag = TAG.exec(text)?.[1]?.toUpperCase();
  if (tag && tag in COMMENT_TAGS) {
    const category = COMMENT_TAGS[tag as keyof typeof COMMENT_TAGS][input.direction];
    if (category) return { category, confidence: "tag", rule: `tag.${tag}` };
  }

  for (const rule of RULES) {
    if (rule.confidence === "certain") continue;
    if (!rule.when(ctx)) continue;
    if (rule.category === "unclassified") return { category: "unclassified", confidence: "unclassified", rule: rule.id };
    if (categoryAllows(rule.category, input.direction)) return { category: rule.category, confidence: "heuristic", rule: rule.id };
  }
  return { category: "unclassified", confidence: "unclassified", rule: "none" };
}

function result(category: Category, confidence: Confidence, rule: string, text: string): Classification {
  const address = category.startsWith("mortgage.") && category !== "mortgage.legacy_broker_interest" ? MORTGAGE_LEG.exec(text)?.[1] : undefined;
  return address ? { category, confidence, rule, address } : { category, confidence, rule };
}

/** Address of a mortgage pass-through leg, if the comment is one. */
export function mortgageAddress(comment: string): string | null {
  return MORTGAGE_LEG.exec(comment.trim())?.[1] ?? null;
}
