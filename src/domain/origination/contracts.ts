import { formatDollars } from "@/lib/format";
import type { LoanKind } from "./loan-offer";

/**
 * Loan agreements as text, ready to copy into a Google Doc or Discord (owner,
 * 2026-10-10). The motor vehicle and property agreements are the company's templates
 * word for word, with the blanks filled in; the personal loan agreement is drafted from
 * them for loans that aren't for a vehicle or a property. Pure.
 */

export type ContractData = {
  kind: LoanKind;
  date: Date;
  borrowerName: string;
  borrowerStateId: number;
  amountCents: number;
  ratePct: number;
  totalCents: number;
  weeks: number;
  schedule: { dueOn: Date; cents: number }[];
  /** Vehicle: make & model. Property: address/details. Personal: the collateral, or null when unsecured. */
  collateral: string | null;
  /** Personal loans: what the money is for. */
  purpose: string | null;
  defaultFeePerDayCents: number;
  purchaseDays: number;
  detailsHours: number;
  extraHours: number;
  defaultAfterDays: number;
  representativeName: string;
  representativeStateId: number;
};

const money = formatDollars;
const pct = (p: number) => `${Number.isInteger(p) ? p : p.toFixed(2).replace(/0+$/, "")}`;

/** "29th September 2026" (UK date). */
export function contractDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "long", year: "numeric" }).formatToParts(d);
  const day = Number(parts.find((p) => p.type === "day")!.value);
  const month = parts.find((p) => p.type === "month")!.value;
  const year = parts.find((p) => p.type === "year")!.value;
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix} ${month} ${year}`;
}

const TITLE: Record<LoanKind, string> = {
  vehicle: "LITT'S LOANS MOTOR VEHICLE LOAN AGREEMENT",
  property: "LITT'S LOANS PROPERTY LOAN AGREEMENT",
  general: "LITT'S LOANS PERSONAL LOAN AGREEMENT",
};
const NAME: Record<LoanKind, string> = { vehicle: "Motor Vehicle Loan Agreement", property: "Property Loan Agreement", general: "Personal Loan Agreement" };

export function renderLoanContract(c: ContractData): string {
  const who = (name: string, id: number) => `${name} [${id}]`;
  const regular = c.schedule.length > 1 ? c.schedule[0].cents : c.schedule[0]?.cents ?? 0;
  const last = c.schedule.at(-1)?.cents ?? 0;
  const scheduleLines =
    c.kind === "property"
      ? [
          `Repayment Schedule: ${money(regular)} a week starting ${contractDate(c.schedule[0].dueOn)}${c.schedule.length > 1 && last !== regular ? ` (final payment ${money(last)} on ${contractDate(c.schedule.at(-1)!.dueOn)})` : ""}`,
        ]
      : ["Repayment Schedule:", "", "Payment Date — Payment (*Amounts are Pre-Tax)", ...c.schedule.map((s) => `${contractDate(s.dueOn)} — ${money(s.cents)}`)];

  const out: string[] = [
    TITLE[c.kind],
    "",
    `This ${NAME[c.kind]} ("Agreement") is made and entered into on ${contractDate(c.date)}, by and between:`,
    "",
    `Litt's Loans, a registered lending entity in the State of San Andreas ("Lender"), and`,
    "",
    `${who(c.borrowerName, c.borrowerStateId)} ("Borrower").`,
    "",
    c.kind === "vehicle"
      ? "WHEREAS, Borrower desires to obtain a loan from Lender to purchase a motor vehicle, and Lender agrees to provide such a loan under the terms and conditions specified herein."
      : c.kind === "property"
        ? "WHEREAS, Borrower desires to obtain a loan from Lender to purchase a property, and Lender agrees to provide such a loan under the terms and conditions specified herein."
        : "WHEREAS, Borrower desires to obtain a loan from Lender, and Lender agrees to provide such a loan under the terms and conditions specified herein.",
    "",
    "1. LOAN DETAILS",
    "",
    `Loan Amount: ${money(c.amountCents)}`,
    `Interest Rate: ${pct(c.ratePct)}% interest on loan amount`,
    `Total Repayment Amount: ${money(c.totalCents)}`,
    `Loan Term: ${c.weeks} ${c.weeks === 1 ? "Week" : "Weeks"}`,
    ...scheduleLines,
    "",
  ];

  if (c.kind === "general") {
    out.push(
      "2. PURPOSE OF THE LOAN",
      "",
      `The Borrower states that the loan will be used for: ${c.purpose?.trim() || "general purposes"}.`,
      "",
      "3. COLLATERAL",
      "",
      ...(c.collateral
        ? [
            `The following asset is pledged as collateral for the loan: ${c.collateral}.`,
            "The borrower agrees that Lender holds a lien on the asset until the loan is paid in full.",
            "If the Borrower defaults, the Lender reserves the right to repossess the asset.",
          ]
        : ["This loan is unsecured: no collateral is pledged. The Borrower's repayment obligations are not reduced by this."]),
      "",
    );
  } else {
    out.push(
      `2. ${c.kind === "vehicle" ? "VEHICLE" : "PROPERTY"} PURCHASE REQUIREMENT`,
      "",
      `The borrower must use the loan to purchase a specific ${c.kind === "vehicle" ? "vehicle" : "property"} within ${c.purchaseDays} business days from the date of this Agreement.`,
      "",
      c.kind === "vehicle"
        ? "The vehicle must meet the agreed-upon Make & Model as detailed in Section 3 (Collateral)."
        : "The property must meet the agreed-upon details as specified in Section 3 (Collateral).",
      "",
      `Failure to purchase the ${c.kind === "vehicle" ? "vehicle" : "property"} within the specified timeframe may result in loan cancellation or renegotiation at the Lender's discretion.`,
      "",
      "3. COLLATERAL",
      "",
      c.kind === "vehicle"
        ? `The motor vehicle purchased with this loan shall serve as collateral for the loan. The borrower shall have ${c.detailsHours} hours to send the vehicle's information (license plate, registration number, and exact model name) and the name of the dealership the vehicle was purchased from, to the Lender. If the Borrower fails to do this, they have an additional ${c.extraHours} hours to return all borrowed funds to the Lender before they shall default.`
        : `The property purchased with this loan shall serve as collateral for the loan. The borrower shall have ${c.detailsHours} hours to send the property's information and the name of the real estate company they purchased the property from, to the Lender. If the Borrower fails to do this, they have an additional ${c.extraHours} hours to return all borrowed funds to the Lender before they shall default.`,
      "",
      c.kind === "vehicle" ? "Vehicle Details:" : `Property Details: ${c.collateral ?? ""}`,
      ...(c.kind === "vehicle" ? ["", `Make & Model: ${c.collateral ?? ""}`] : []),
      "",
      `The borrower agrees that Lender holds a lien on the ${c.kind === "vehicle" ? "vehicle" : "property"} until the loan is paid in full.`,
      "",
      `If the Borrower defaults, the Lender reserves the right to repossess the ${c.kind === "vehicle" ? "vehicle" : "property"}.`,
      "",
    );
  }

  // Sections 4–11 are the same in every agreement.
  const n = 4;
  out.push(
    `${n}. EARLY REPAYMENT`,
    "",
    "The borrower may repay the loan in full at any time without penalty.",
    "",
    "Partial early payments are permitted but do not change the repayment schedule unless otherwise agreed in writing.",
    "",
    `${n + 1}. LATE PAYMENT & DEFAULT`,
    "",
    "Late fees of 2% extra interest shall be applied automatically to late payments by the automated payment system.",
    "",
    `The Defaulted Account Fee for this loan is ${money(c.defaultFeePerDayCents)} per day that the loan remains in default. Until the amount is collected in full, through either agreed-upon payment or court filings, this fee will continue to accrue upon the Borrower's total loan repayment amount due.`,
    "",
    "The Borrower shall default on their loan if any of the following events occur:",
    "",
    `Overdue Payment: Borrower fails to pay any amount due on the dates specified in the repayment schedule within ${c.defaultAfterDays} days of the due date.`,
    "",
  );
  if (c.kind === "vehicle") {
    out.push(
      "Collateral: If the motor vehicle pledged as collateral as part of this agreement is transferred or sold before the loan is paid off in full.",
      "",
      "Vehicle Information: Failure to send vehicle information as specified in section 3.",
      "",
    );
  } else if (c.kind === "property") {
    out.push("Collateral: If the property pledged as collateral as part of this agreement is transferred in ownership or sold before the loan is paid off in full.", "");
  } else if (c.collateral) {
    out.push("Collateral: If the asset pledged as collateral as part of this agreement is transferred or sold before the loan is paid off in full.", "");
  }
  out.push(
    "When Borrower defaults on their loan, Lender reserves the right to take legal action, including but not limited to:",
    "",
    ...(c.kind !== "general" || c.collateral ? ["Repossession of pledged collateral.", ""] : []),
    "Demanding full repayment of the outstanding Loan amount, including accrued interest and fees.",
    "",
    "Seizure of further assets/property if the bank account balance is insufficient to cover accrued outstanding payment amount, including interest and fees.",
    "",
    `${n + 2}. CONTRACT MODIFICATIONS`,
    "",
    "Any modification to this Agreement must be in writing and signed by both parties.",
    "",
    `${n + 3}. NOTIFICATIONS`,
    "",
    "All communications and notices related to this Agreement shall be submitted in writing to the Lender.",
    "",
    `${n + 4}. GOVERNING LAW & DISPUTE RESOLUTION`,
    "",
    "This Agreement shall be governed by the laws of San Andreas.",
    "",
    "Any disputes shall be resolved through negotiation. If unresolved, parties may file with the Civil Docket as per Schwinghammer’s Contract Rules Over Loans and Legal Stuff (SCROLLS).",
    "",
    `${n + 5}. COMPLETE AGREEMENT`,
    "",
    "This Agreement constitutes the entire understanding between the parties and supersedes all prior agreements, whether written or oral, relating to the Loan.",
    "",
    `${n + 6}. SEVERABILITY`,
    "",
    "Should any provision of this Agreement be deemed invalid, the remaining provisions shall remain enforceable.",
    "",
    `${n + 7}. ACKNOWLEDGEMENT & SIGNATURES`,
    "",
    "By signing below, both parties acknowledge that they have read, understood, and agreed to the terms of this Agreement.",
    "",
    `LENDER: Litt's Loans Representative: ${who(c.representativeName, c.representativeStateId)}`,
    "",
    `BORROWER: Borrower Name: ${who(c.borrowerName, c.borrowerStateId)}`,
  );
  return out.join("\n");
}
