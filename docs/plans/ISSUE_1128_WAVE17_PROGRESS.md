# Issue #1128 — whole-project purchase commitments in project P&L

Continuation of merged #1311. This closes the specific missing **whole-project
approved/unbooked purchase aggregate**, not all remaining agency acceptance work.

## Report contract

The existing project commercial endpoint now adds:

```ts
report.commitments: {
  approvedVendorPurchaseRial: string; // exact integer-rial decimal text
  approvedVendorPurchaseCount: number;
}
```

- Sum/count every purchase for this business AND project where `status = approved`
  and `cost_id IS NULL`. There is no pagination or 200-row limit on the aggregate.
- Draft, submitted, rejected and booked purchases contribute nothing. Zero means
  no approved/unbooked commitments; it is not substituted for unknown ledger data.
- Ledger sums and commitment sums run in **one SQL statement snapshot**, each
  aggregated independently before combining. A booking transaction therefore
  cannot be seen halfway through, and multiple journal lines cannot multiply quote
  totals (or vice versa).
- Totals use PostgreSQL's exact numeric sum and decimal-text serialization, not
  JavaScript `Number`: several individually valid quotes can sum beyond the safe
  integer range. The screen uses the existing BigInt-safe money formatter.
- A booked quote leaves commitments. Its posted cost appears in the existing net
  pass-through or gross expense figures according to the policy applied at booking.
  No commitment is also added to those facts, and commitments are NEVER subtracted
  from posted gross margin. A quote does not yet state an expense presentation.
- The existing contracted/billed/collected/receivable, posted margin, pass-through
  and hours semantics remain unchanged. Actual hours are still unknown, not zero.

No migration, backfill, accounting posting, extra endpoint, new app or permission
change is needed. Existing agency-industry and project-view checks execute before
this aggregate. The MCP matrix documents the new read contract but adds no AI tool.

## Member screen

The agency project's finance P&L has a separate Persian-labelled commitment group:
whole-project approved/unbooked amount and count, explicitly outside posted margin.
It distinguishes that full aggregate from the purchase register's loaded-page
subtotal. Gross/net wording no longer implies that presentation proves ownership.

Successful purchase writes and explicit register refresh invalidate the adjacent
commercial card through a revision prop. This refreshes its report without
remounting the billing card or discarding open billing forms. Superseded effect
requests are aborted so an older response cannot overwrite a refreshed snapshot.
The callback does not grant authorization or locally predict accounting facts.

## Verification

- Database integration: **41/41** across project P&L (**13**), commercial billing
  (**17**) and vendor purchases (**11**).
- Added P&L assertions cover 201 approved quotes beyond the list limit; exclusion
  of draft/submitted/rejected rows; no multiplication by ledger lines; net and
  gross booking transitions; a booking held open in a real transaction with
  before/after-commit reads; exact totals above safe JS integer range; two clients
  in one tenant with separate projects; foreign tenants and non-member denial.
- Focused units/components/guards/loading/design/MCP: **152/152**. New component
  tests check separate labels and unchanged served margin, exact large display,
  revision-driven refresh, and the purchase-success notification. MCP drift was
  rerun afterward: **17/17**.
- Changed-file ESLint and `git diff --check`: pass.
- Targeted TypeScript (agency commercial libraries, project components, P&L
  integration and `src/types` declarations): pass, no errors. This is not a claim
  of a full-project typecheck.
- Full repository unit regression was not run locally for this slice; CI review
  remains required before merge. No auto-merge is enabled.

## Remaining acceptance gaps

This adds commitments, not a forecast margin or a new expense-ownership model.
Actual time/resource capture, campaign ledger dimensions, agency-owned procurement,
customer advances/overdue balances, campaign calendar/reporting/manual attribution,
dashboard/report/AI/print templates, renewal/versioned scope, preset-combination UX,
and rollout/security sweeps still need work. Approved-but-unbooked purchase
cancellation/change management is also not introduced; this report follows the
register's existing approved state rather than inventing cancellation facts.

The #1110 eligibility matrix remains absent. Do not mark that requirement complete
or treat #1128's pre-existing closed status as proof that every acceptance item
has shipped. The next work should retain the four-app architecture and existing
server authorization/posting engines, without fabricated performance metrics.
