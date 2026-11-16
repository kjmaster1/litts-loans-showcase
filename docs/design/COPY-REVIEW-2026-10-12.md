# Copy review — 12 October 2026

Owner brief: read the app as a reviewer looking for AI-generated text. Remove the generic AI language
and keep the professional descriptions and information.

## Method

1. **What to look for.** Sources: Wikipedia's "Signs of AI writing" (vocabulary, negative
   parallelisms, rule of three, em-dash overuse, promotional tone) and write-ups on AI-written UX copy
   (LogRocket: "Oops… Something went wrong", vague labels, casual tone in finance tools).
2. **Every string.** A TypeScript-AST script pulled every piece of user-facing text out of `src/`
   (JSX text, prose string and template literals; class names, SQL and keys skipped): 3,738 strings.
   All of them were read.
3. **Vocabulary sweep** for the usual words ("seamless", "robust", "leverage", "unlock", "empower",
   "platform", "get started", "you're all set", "Oops", exclamation marks, emoji…).

## What was found

The copy is mostly specific already: it names the game's screens, the handbook sections and the
accounts. The AI tells were:

| Tell | Where | Now |
|---|---|---|
| Em dashes as the default joint in sentences (~140 strings) | Everywhere | A full stop, colon, semicolon, comma or brackets. " · " separates a value from its note, as elsewhere in the app. |
| A marketing hero: a tagline ("The books behind every loan."), a pitch line and three ticked "proof points" | Sign-in brand panel | "Staff system", plus one sentence on what it covers and where its figures come from. |
| Time-of-day greetings ("Good morning, Kieran.") and a flourish ("…and deals — nobody else's.") | Dashboard, My work | Says what the page shows ("Your loans, mortgages and open deals."). |
| "Platform" | Page metadata, Staff | "Staff system", "Everyone with an account." |
| Chatty tour copy ("Show me around", "You're all set", "Lost? … type what you're after", "Here's where everything you can use lives") | App tour | "Start the tour", "End of the tour", "To find a record, press Ctrl K and type a name or State ID", "The tour covers:". |
| Selling lines ("Work faster without the mouse.", "see what colleagues are working on", "Protect your account") | Shortcuts, Offers, Quotes, 2FA set-up | What it is or does. |
| Generic or reassuring errors ("Something went wrong. Please try again.", "Nothing you entered has been lost") | Action errors, error page | What happened and what to check: "Unexpected server error. Check whether the change saved before trying again." |
| Empty filler ("Import a bank export to get started.", "You have been signed out securely.") | Transactions, sign-in | "No bank export has been imported yet.", "You've signed out of this device." |

## Kept on purpose

- **Contract templates** (`domain/origination/contracts.ts`): the owner's text, word for word.
- **Ledger memos and journal descriptions** ("Broker fee — <address>", "Commission — week of …"): stored
  with every posting. New entries keep the format so they read like the ones already in the books.
- **"Welcome, <name>"** on the tour's first card: a first visit is when a welcome belongs.
- **"Are you still there?"** on the idle sign-out warning: it's the plain question.

## Verification

Typecheck and lint clean. 523 unit/integration tests and all 30 browser tests pass against a
production build (7 assertions updated for the new wording). Sign-in page checked by eye. The rules
are in `DESIGN-SYSTEM.md` under "Writing".
