/** A loan operation refused for a reason that's safe to show the user. */
export class LoanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoanError";
  }
}
