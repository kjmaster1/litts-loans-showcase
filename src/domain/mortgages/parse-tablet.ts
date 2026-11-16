import { dollarsToCents } from "@/lib/money";

/**
 * Parser for the tablet's "Sale Agreement – Financed" details text
 * (docs/research/07). One paste may hold several agreements copied one after
 * another; each ends with "After Tax" and its value. Label/value pairs are
 * matched by label, so a missing or reordered field produces a warning rather
 * than a failed paste.
 */

export type Party = { stateId: number | null; name: string };

export type TabletMortgage = {
  index: number;
  raw: string;
  address: string;
  /** False when no line looked like an address — then `address` is only the block's first line. */
  addressRecognised: boolean;
  /** Lines copied above the address (the tablet's heading and tabs), left out of the agreement. */
  skippedLines: string[];
  propertyType: string | null;
  landCount: number | null;
  priceCents: number | null;
  paidSoFarCents: number | null;
  instalments: number | null;
  weeklyCents: number | null;
  remainingCents: number | null;
  paidCount: number | null;
  upcomingCount: number | null;
  downPaymentCents: number | null;
  loanCents: number | null;
  /** Broker interest over the whole term ("Interest"). */
  brokerInterestCents: number | null;
  federalInterestCents: number | null;
  termMonths: number | null;
  /** Hundredths of a percent (3.00% → 300). */
  fedRateBp: number | null;
  brokerRateBp: number | null;
  lateFeeCents: number | null;
  gracePeriodDays: number | null;
  brokerFeeCents: number | null;
  agencyCommissionCents: number | null;
  status: string | null;
  owner: string | null;
  agency: string | null;
  agent: Party | null;
  financeCompany: string | null;
  officer: Party | null;
  buyer: Party | null;
  totalValueCents: number | null;
  afterTaxCents: number | null;
  warnings: string[];
};

const MONEY = /^\$[\d,]+(?:\.\d+)?$/;
const PERSON = /^#(\d{1,7})\s+(.+)$/;
const SECTIONS = new Set(["OWNER", "REAL ESTATE", "FINANCE", "BUYER", "Total Value", "After Tax", "Loan details"]);

/**
 * Every property address in the game starts with a house number ("107 Amarillo Vista",
 * "103 Forum Dr, Apt 2I"). The tablet's own heading ("Sale Agreement - Financed") and
 * tabs ("PROPERTIES", "PAYMENTS") don't — copying from too high up once made one of
 * them a mortgage's address (2026-10-12).
 */
export function looksLikeAddress(line: string): boolean {
  return /^\d+[A-Za-z]?(?:-\d+)?\s+[A-Za-z]/.test(line) && !/^\d+\s+land$/i.test(line);
}

const money = (s: string | undefined) => (s && MONEY.test(s) ? dollarsToCents(Number(s.replace(/[$,]/g, ""))) : null);
const percentBp = (s: string | undefined) => {
  const m = s && /^([\d.]+)\s*%$/.exec(s);
  return m ? Math.round(Number(m[1]) * 100) : null;
};
const count = (s: string | undefined, unit: string) => {
  const m = s && new RegExp(`^(\\d+)\\s+${unit}s?$`, "i").exec(s);
  return m ? Number(m[1]) : null;
};
const person = (s: string | undefined): Party | null => {
  if (!s) return null;
  const m = PERSON.exec(s);
  return m ? { stateId: Number(m[1]), name: m[2].trim() } : null;
};

/** Splits a paste into agreement blocks; each ends after the "After Tax" value. */
function blocks(lines: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    current.push(lines[i]);
    if (lines[i] === "After Tax" && MONEY.test(lines[i + 1] ?? "")) {
      current.push(lines[++i]);
      out.push(current);
      current = [];
    }
  }
  if (current.some((l) => /^Loan amount$/i.test(l))) out.push(current);
  return out;
}

export function parseTablet(text: string): { mortgages: TabletMortgage[]; ignoredLines: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const found = blocks(lines);
  const used = found.reduce((n, b) => n + b.length, 0);
  return { mortgages: found.map((b, i) => parseBlock(b, i)), ignoredLines: lines.slice(used) };
}

function parseBlock(block: string[], index: number): TabletMortgage {
  // Header: [heading and tabs copied by mistake], address, property type, "N land", price — up to "Paid so far".
  const headerEnd = block.findIndex((l) => l === "Paid so far");
  const header = block.slice(0, headerEnd < 0 ? Math.min(block.length, 8) : headerEnd);
  const at = header.findIndex(looksLikeAddress);
  const lines = at > 0 ? block.slice(at) : block;
  const after = (label: string) => {
    const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
    return i >= 0 ? lines[i + 1] : undefined;
  };
  const m: TabletMortgage = {
    index,
    raw: block.join("\n"),
    address: lines[0],
    addressRecognised: at >= 0,
    skippedLines: at > 0 ? block.slice(0, at) : [],
    propertyType: null,
    landCount: null,
    priceCents: null,
    paidSoFarCents: money(after("Paid so far")),
    instalments: null,
    weeklyCents: null,
    remainingCents: money(after("Remaining")),
    paidCount: null,
    upcomingCount: null,
    downPaymentCents: money(after("Down payment")),
    loanCents: money(after("Loan amount")),
    brokerInterestCents: money(after("Interest")),
    federalInterestCents: money(after("Federal Interest")),
    termMonths: count(after("Term"), "month"),
    fedRateBp: percentBp(after("Fed rate")),
    brokerRateBp: percentBp(after("Broker rate")),
    lateFeeCents: money(after("Late fee")),
    gracePeriodDays: count(after("Grace period"), "day"),
    brokerFeeCents: money(after("Broker fee")),
    agencyCommissionCents: money(after("Agency commission")),
    status: null,
    owner: null,
    agency: null,
    agent: null,
    financeCompany: null,
    officer: null,
    buyer: null,
    totalValueCents: money(after("Total Value")),
    afterTaxCents: money(after("After Tax")),
    warnings: [],
  };

  const priceEnd = lines.findIndex((l) => l === "Paid so far");
  for (const l of lines.slice(1, priceEnd < 0 ? 4 : priceEnd)) {
    if (MONEY.test(l)) m.priceCents ??= money(l);
    else if (/^\d+\s+land$/i.test(l)) m.landCount = Number(l.split(/\s+/)[0]);
    else m.propertyType ??= l;
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let r: RegExpExecArray | null;
    if ((r = /^Weekly:\s*(\d+)\s+payments?$/i.exec(l))) {
      m.instalments = Number(r[1]);
      m.weeklyCents = money(lines[i + 1]);
    } else if ((r = /^Paid (\d+)$/.exec(l))) m.paidCount = Number(r[1]);
    else if ((r = /^Upcoming (\d+)$/.exec(l))) m.upcomingCount = Number(r[1]);
    else if (/^(Financed|Cash|Paid off|Defaulted)$/i.test(l)) m.status ??= l;
  }

  // Parties: a section label followed by its lines until the next section label.
  const section = (label: string) => {
    const i = lines.indexOf(label);
    if (i < 0) return [];
    const rest = lines.slice(i + 1);
    const end = rest.findIndex((l) => SECTIONS.has(l));
    return end < 0 ? rest : rest.slice(0, end);
  };
  m.owner = section("OWNER")[0] ?? null;
  const agency = section("REAL ESTATE");
  m.agency = agency.find((l) => !PERSON.test(l)) ?? null;
  m.agent = person(agency.find((l) => PERSON.test(l)));
  const finance = section("FINANCE");
  m.financeCompany = finance.find((l) => !PERSON.test(l)) ?? null;
  m.officer = person(finance.find((l) => PERSON.test(l)));
  const buyer = section("BUYER");
  m.buyer = person(buyer.find((l) => PERSON.test(l))) ?? (buyer[0] ? { stateId: null, name: buyer[0] } : null);

  if (!m.addressRecognised) m.warnings.push("No property address found (a line starting with a house number, e.g. “107 Amarillo Vista”).");
  if (m.loanCents === null && m.downPaymentCents === null && lines.includes("Loan details")) {
    m.warnings.push("“Loan details” was closed on the tablet, so the down payment, loan and rates are missing. Open it, then copy again.");
  } else if (!m.loanCents) m.warnings.push("No loan amount.");
  if (!m.instalments) m.warnings.push("No number of weekly payments.");
  if (!m.buyer?.stateId) m.warnings.push("No buyer State ID.");
  if (m.financeCompany && !/litt/i.test(m.financeCompany)) m.warnings.push(`Financed by ${m.financeCompany}, not Litt's Loans.`);
  return m;
}
