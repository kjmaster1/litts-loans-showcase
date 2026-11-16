import type { Tone } from "@/components/data/status-badge";

/** Human-readable labels for audit actions. Unknown actions fall back to the raw key. */
const LABELS: Record<string, { label: string; tone: Tone }> = {
  "auth.sign_in.succeeded": { label: "Signed in", tone: "success" },
  "auth.sign_in.password_ok": { label: "Password accepted (awaiting 2FA)", tone: "neutral" },
  "auth.sign_in.failed": { label: "Failed sign-in", tone: "danger" },
  "auth.2fa.failed": { label: "Wrong 2FA code", tone: "danger" },
  "auth.2fa.verified": { label: "2FA verified", tone: "neutral" },
  "auth.2fa.enabled": { label: "Turned on 2FA", tone: "success" },
  "auth.2fa.enrollment_started": { label: "Started 2FA setup", tone: "neutral" },
  "auth.2fa.enrollment_failed": { label: "2FA setup failed", tone: "warning" },
  "auth.2fa.backup_code_failed": { label: "Invalid backup code", tone: "danger" },
  "auth.2fa.backup_codes_regenerated": { label: "Regenerated backup codes", tone: "info" },
  "auth.2fa.disabled": { label: "Turned off 2FA", tone: "danger" },
  "auth.password.changed": { label: "Changed password", tone: "info" },
  "auth.password.change_failed": { label: "Password change failed", tone: "warning" },
  "auth.sign_out": { label: "Signed out", tone: "neutral" },
  "auth.session.revoked": { label: "Ended a session", tone: "info" },
  "auth.session.revoked_others": { label: "Ended all other sessions", tone: "info" },
  "staff.invite.created": { label: "Invited staff member", tone: "info" },
  "staff.invite.reissued": { label: "Re-issued invite", tone: "info" },
  "staff.invite.accepted": { label: "Accepted invite", tone: "success" },
  "staff.role.changed": { label: "Changed role", tone: "warning" },
  "staff.name.changed": { label: "Changed name", tone: "info" },
  "staff.suspended": { label: "Suspended access", tone: "danger" },
  "staff.reactivated": { label: "Reactivated access", tone: "success" },
  "staff.departed": { label: "Marked as departed", tone: "neutral" },
  "staff.two_factor.reset": { label: "Reset someone's two-factor", tone: "danger" },
  "auth.2fa.backup_codes_failed": { label: "Backup codes not regenerated", tone: "warning" },
  "auth.step_up.succeeded": { label: "Confirmed with authenticator", tone: "neutral" },
  "auth.step_up.failed": { label: "Wrong code when confirming", tone: "danger" },
  "auth.passkey.added": { label: "Added a passkey", tone: "info" },
  "auth.passkey.add_failed": { label: "Passkey not added", tone: "warning" },
  "auth.passkey.removed": { label: "Removed a passkey", tone: "info" },
  "auth.passkey.remove_failed": { label: "Passkey not removed", tone: "warning" },
  "bank.import.committed": { label: "Imported a bank export", tone: "info" },
  "bank.transaction.reclassified": { label: "Reclassified a transaction", tone: "warning" },
  "ledger.legacy_loans.closed": { label: "Booked the old manual loans", tone: "warning" },
  "loans.paste.committed": { label: "Pasted phone cards", tone: "info" },
  "loans.officer_assigned": { label: "Set a loan's officer", tone: "info" },
  "loans.written_off": { label: "Wrote off a loan", tone: "danger" },
  "loans.marked_repaid": { label: "Marked a loan as repaid", tone: "warning" },
  "loans.collateral_added": { label: "Recorded collateral", tone: "info" },
  "loans.collateral_status": { label: "Updated collateral", tone: "info" },
  "loans.note_added": { label: "Added a note to a loan", tone: "info" },
  "mortgages.note_added": { label: "Added a note to a mortgage", tone: "info" },
  "mortgages.tablet.committed": { label: "Pasted tablet agreements", tone: "info" },
  "mortgages.officer_assigned": { label: "Set a mortgage's officer", tone: "info" },
  "mortgages.merged": { label: "Merged a duplicate mortgage record", tone: "warning" },
  "loans.card_only.merged": { label: "Merged a duplicate card-only loan", tone: "warning" },
  "loans.card_only.retired": { label: "Retired a mistaken card-only loan", tone: "warning" },
  "allowance.reading.added": { label: "Recorded an allowance reading", tone: "info" },
  "allowance.reading.voided": { label: "Voided an allowance reading", tone: "warning" },
  "allowance.rule.adopted": { label: "Chose the allowance rule", tone: "warning" },
  "commissions.roster.saved": { label: "Saved the pool roster", tone: "info" },
  "commissions.roster.locked": { label: "Locked the pool roster", tone: "info" },
  "commissions.week.closed": { label: "Closed a commission week", tone: "warning" },
  "commissions.payout.assigned": { label: "Assigned a commission payout", tone: "info" },
  "commissions.wallet_linked": { label: "Linked a payout wallet", tone: "info" },
  "settings.changed": { label: "Changed company settings", tone: "warning" },
  "borrowers.flag.set": { label: "Marked a borrower do-not-lend", tone: "warning" },
  "borrowers.flag.cleared": { label: "Cleared a do-not-lend flag", tone: "info" },
  "loans.collection.logged": { label: "Logged a collections action", tone: "info" },
  "legal.terms_set": { label: "Set a loan’s contract details for Legal", tone: "info" },
  "legal.details_requested": { label: "Asked the officer for contract details", tone: "info" },
  "legal.contract_shared": { label: "Marked the contract as shared with Legal", tone: "info" },
  "legal.default_date_set": { label: "Corrected a case’s default date", tone: "warning" },
  "legal.contract_note_set": { label: "Noted a case’s contract differs from the game", tone: "warning" },
  "legal.handed_over": { label: "Handed a case to Legal", tone: "info" },
  "legal.closed": { label: "Closed a legal case", tone: "neutral" },
  "legal.fee_confirmed": { label: "Linked an attorney & filing fee payment", tone: "info" },
  "legal.fee_unlinked": { label: "Unlinked an attorney & filing fee payment", tone: "warning" },
  "legal.lawyer_wallet_learned": { label: "Learned the lawyer’s wallet from a fee payment", tone: "info" },
  "ledger.staff_loans.closed": { label: "Cleared the old staff loans", tone: "warning" },
  "data.export.downloaded": { label: "Downloaded a full data export", tone: "warning" },
  "report.exported": { label: "Downloaded a report", tone: "neutral" },
  "staff.password_reset.issued": { label: "Issued a password reset link", tone: "warning" },
  "staff.password_reset.completed": { label: "Set a new password from a reset link", tone: "info" },
  "ledger.legacy_loans.restated": { label: "Booked the old manual loans loan by loan", tone: "warning" },
  "list.exported": { label: "Downloaded a list to Excel", tone: "neutral" },
  "mortgages.collection.logged": { label: "Logged a collections action on a mortgage", tone: "info" },
  "loans.payments.relinked": { label: "Corrected which loan payments belong to", tone: "warning" },
  "loans.offer.created": { label: "Drafted a loan offer", tone: "neutral" },
  "loans.offer.updated": { label: "Changed a loan offer", tone: "neutral" },
  "loans.offer.issued": { label: "Issued a loan contract", tone: "info" },
  "loans.offer.cancelled": { label: "Cancelled a loan offer", tone: "warning" },
  "mortgages.quote.created": { label: "Made a mortgage quote", tone: "neutral" },
  "mortgages.quote.updated": { label: "Changed a mortgage quote", tone: "neutral" },
  "mortgages.quote.confirmed": { label: "Confirmed a mortgage quote", tone: "success" },
  "mortgages.quote.unconfirmed": { label: "Moved a mortgage quote back to draft", tone: "neutral" },
  "mortgages.quote.signed": { label: "Marked a mortgage quote signed in game", tone: "info" },
  "mortgages.quote.cancelled": { label: "Cancelled a mortgage quote", tone: "warning" },
  "loans.offer.unlinked": { label: "Unlinked a loan offer from its loan", tone: "warning" },
  "loans.offer.linked": { label: "Linked a loan offer to a loan by hand", tone: "info" },
  "mortgages.quote.unlinked": { label: "Unlinked a quote from its mortgage", tone: "warning" },
  "mortgages.quote.linked": { label: "Linked a quote to a mortgage by hand", tone: "info" },
  "mortgages.quote.note_added": { label: "Asked for changes to a quote", tone: "info" },
  "mortgages.quote.note_resolved": { label: "Marked a quote note done", tone: "neutral" },
  "mortgages.quote.approved": { label: "Approved a large mortgage quote", tone: "success" },
  "mortgages.approved_after": { label: "Approved a large mortgage after the fact", tone: "warning" },
};

/** Every action with a label (a test checks each recorded action has one). */
export const LABELLED_ACTIONS: ReadonlySet<string> = new Set(Object.keys(LABELS));

const TARGET_NAME: Record<string, string> = {
  allowance_reading: "Allowance reading",
  bank_transaction: "Bank transaction",
  borrower: "Borrower",
  commission_week: "Commission week",
  company_setting: "Company settings",
  setting: "Company settings",
  export: "Full data export",
  import_batch: "Bank import",
  journal_entry: "Journal entry",
  ledger: "Ledger",
  list: "List",
  loan: "Loan",
  loan_offer: "Loan offer",
  loan_paste: "Phone card paste",
  mortgage: "Mortgage",
  mortgage_paste: "Tablet paste",
  mortgage_quote: "Mortgage quote",
  report: "Report",
};

/** A readable subject for an audit entry, linked to its page where there is one. */
export function auditTarget(type: string | null, id: string | null, metadata: Record<string, unknown>): { label: string; href: string | null } | null {
  if (!type) return null;
  const name = TARGET_NAME[type] ?? type.replaceAll("_", " ");
  const num = typeof metadata.number === "number" ? ` #${metadata.number}` : "";
  const what =
    typeof metadata.address === "string" ? ` · ${metadata.address}`
    : (type === "list" || type === "report") && id ? ` · ${id.replaceAll(/[-_]/g, " ")}`
    : type === "borrower" && id ? ` #${id}`
    : "";
  const uuid = id && /^[0-9a-f-]{36}$/.test(id) ? id : null;
  const href =
    type === "loan" && uuid ? `/loans/${uuid}`
    : type === "mortgage" && uuid ? `/mortgages/${uuid}`
    : type === "loan_offer" && uuid ? `/loans/offers/${uuid}`
    : type === "mortgage_quote" && uuid ? `/mortgages/quotes/${uuid}`
    : type === "bank_transaction" && uuid ? `/finance/transactions/${uuid}`
    : type === "import_batch" && uuid ? `/finance/imports/${uuid}`
    : type === "borrower" && id && /^\d+$/.test(id) ? `/loans/borrowers/${id}`
    : null;
  return { label: `${name}${num}${what}`, href };
}

export function auditLabel(action: string): { label: string; tone: Tone } {
  return LABELS[action] ?? { label: action, tone: "neutral" };
}
