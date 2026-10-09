# Commission settlement runs — approval, payout and reversal

Issue #869. Commission accrues per sale line (`commission_accruals`, #764 and #835),
and each accrual posts a liability to 2300 *حقوق پرداختنی*. This document covers
the step after accrual: grouping unclaimed accruals into an immutable **settlement
run**, approving it, paying it out, reversing a payout, and closing the run. It does
not cover commission rules, seller assignment or the rules-and-report screen (#764),
or payroll's own commission settlement (#835).

Code map:

| Concern | Where |
| --- | --- |
| Lifecycle, permissions, separation of duties | `src/lib/commission-settlement-lifecycle.ts` |
| What a run contains (pure) | `src/lib/commission-settlement-plan.ts` |
| Payout allocation and request fingerprint (pure) | `src/lib/commission-settlement-payout.ts` |
| Request parsing (pure) | `src/lib/commission-settlement-input.ts` |
| Database transitions, tie-out, statements | `src/lib/commission-settlement-service.ts` |
| CSV exports | `src/lib/commission-settlement-csv.ts` |
| HTTP mapping | `src/lib/commission-settlement-http.ts`, `src/app/api/commission/**` |
| Screens | `src/app/(app)/growth/commission/runs/**`, `growth/commission-runs-section.tsx`, `growth/commission-run-detail.tsx` |
| Schema | `migrations/0216_commission_settlement.sql` |

## The lifecycle

Forward path: `draft` → `calculated` (calculate) → `reviewed` (review) → `approved`
(approve) → `payable` (release) → `partially_paid` or `paid` (pay) → `closed` (close).

- `reject` returns `calculated`, `reviewed`, `approved` or `payable` to `draft`, only while
  nothing has been paid.
- `void` ends a run before any payout. A draft or calculated run is voided as calculation
  work; a later one as approval work.
- A reversed payout moves the run back down: `paid` → `partially_paid` → `payable`.

States in detail:

- **draft** — created, no lines, no claims, no money.
- **calculated** — the run's lines are written and the eligible accruals are claimed.
- **reviewed / approved** — review and approval are separate audited actions. The person
  who calculated a run cannot approve it (`403 approver_is_calculator`). There is no
  owner exemption.
- **payable** — released for payment. From here the run can be paid or closed, not edited.
- **partially_paid / paid** — money has left. A run is `paid` when every member is paid to
  the last rial.
- **closed** — final. A part-paid run closed here carries each member's remainder forward
  (see *Carry-forward*). A closed run cannot have a payout reversed.
- **voided** — ended before any payout. Its claims are released; its lines stay as history.

Policy constants (`commission-settlement-lifecycle.ts`):

- `REJECT_TO_DRAFT_ALLOWED = true` — a run may return to draft (lines purged, claims
  released) while nothing has been paid.
- A run with any payout cannot be rejected or voided. It must be reversed payout by payout.
- Closing requires that money has moved (`paid` or `partially_paid`).

## What a run contains

**Eligible rows.** A run takes every accrual row that is unclaimed by both processes
(`payroll_run_id IS NULL AND settlement_run_id IS NULL`), non-zero, dated on or before
the run's end (`COALESCE(journal entry date, created date) <= period_to`), in the run's
branch when it has one, and for the run's members when it has a filter. Earlier unclaimed
rows roll into the next run rather than being stranded between periods; rows dated before
the run's start are named in a warning.

**The positive-balance rule.** A member is paid only when their net claimable amount
(accruals plus carried balances) is strictly positive. A member whose returns outweigh
their sales keeps every row unclaimed, so the negative balance nets against their next
sales. This is the rule payroll already keeps (#835), and it is what makes a sale return
traceable: a return is a negative row, and a run that claims the member's sale also claims
the return.

**Snapshot.** Each line copies, at calculation time: the member's name, code, role and
active flag; the rule's terms and a 16-hex fingerprint of them (`rule_version`); the source
sale (order number, item name, branch, business date, journal entry id); the basis and the
signed amount. Nothing in a line references a live row, so a later rule edit, a rename or a
deleted user changes no line that already exists.

**Warnings** stored on the run, by code: `balance_not_positive` (members held back, by name),
`claimed_by_payroll` (rows a payroll run already holds, excluded), `earlier_rows_included`,
`inactive_member` (an inactive member who is being paid: confirm before paying), and
`rule_missing` (a claimed row whose rule has since been deleted).

**Refusal.** A calculation that would pay nothing is refused with `nothing_to_settle` and the
run stays a draft.

**Carry-forward.** When a part-paid run is closed, each member's outstanding balance becomes
a carry row (`commission_settlement_carries`). The next run that calculates for that member
claims the carry and shows it as a `carry_forward` line. A carry is claimed once. Voiding or
rejecting the claiming run releases it again. Carries are included in every run regardless of
its branch filter: they are balances owed, not sales.

## Paying out

A payout is a set of per-member allocations against what each member is still owed in that
run. `outstanding = Σ lines − Σ net allocations`, derived, never stored.

- Each allocation is either a typed amount (integer Rial, positive, at most the member's
  outstanding) or `all: true`, which the server resolves to the exact outstanding at the
  moment of the payout. `all` exists because the screen may show a unit (toman) that cannot
  display every Rial; the server, not the form, sets the amount.
- A payout posts once: **Dr 2300 *حقوق پرداختنی* total / Cr the chosen cash or bank account**,
  `source_type = commission_payout`, `posting_kind = commission_payout`, business-wide
  (no branch). The payment account is validated against the same eligibility rule payroll
  uses (`resolvePayoutAccount`), so a receivable or a card-clearing account is refused.
- The payout document and its allocations are written in the same transaction as the journal
  entry. The status moves to `partially_paid` or `paid` from the net paid total.
- **Idempotency.** `POST /api/commission/runs/[id]/payouts` requires an `Idempotency-Key`
  header (or body field) of 8–128 printable ASCII characters. The request is fingerprinted
  (`payoutRequestHash`: run, allocations with `all` kept distinct from a number, account,
  method, the *requested* paid date, memo). A retry with the same key and fingerprint returns
  the payout it made (`200`, `replayed: true`). The same key with a different request is
  `409 idempotency_key_conflict`. The fingerprint uses the requested date, not the resolved
  one, so a retry the next day still matches.
- The paid date defaults to the business's today and may not be in the future.

**Reversal.** `POST /api/commission/payouts/[id]/reverse` posts a mirror entry
(`postExactMirrorEntry`, source `commission_payout_reversal`), writes a `reversal` document
that points at the payout, and writes the allocations negated. Each member's outstanding
returns by exactly what was paid to them. A payout can be reversed once (a second call
returns the existing reversal), a reversal cannot itself be reversed, and reversal is refused
once the run is closed. The reversal is dated today, so a closed fiscal period is never
reopened to fix a mistake.

## Reconciliation

The 2300 tie-out is `GET /api/commission/liability` (and the card on the runs page).

Positions, all integer Rial:

- `unclaimed` — Σ accruals that no run and no payroll run has claimed.
- `payrollAwaitingCommission` — commission on accrued (unpaid) payroll runs.
- `settlementOutstanding` — Σ `commission_total − paid_total` over open settlement runs
  (calculated through paid; closed and voided excluded).
- `carriedForward` — Σ unclaimed carries.
- `unpaidCommission = unclaimed + payrollAwaitingCommission + settlementOutstanding + carriedForward`.
- `accruedTotal` — Σ all accruals, signed. `paidTotal` — paid payroll commission plus net
  settlement payouts.

Two identities, both expected to be zero:

- `subledgerDifference = accruedTotal − paidTotal − unpaidCommission`.
- `difference = ledger 2300 − payrollAwaiting(net + commission) − unclaimed − settlementOutstanding − carriedForward`.

Payroll's own tie-out (`getPayrollLiability`) now counts the standalone position as
unsettled, so its `difference` stays zero whichever process settles a row.

## Payroll and standalone settlement are exclusive

One column, `commission_accruals.settlement_run_id`, is the standalone claim; payroll's
`payroll_run_id` is the other. Three things make a double claim impossible:

1. A CHECK constraint: `payroll_run_id IS NULL OR settlement_run_id IS NULL`.
2. Every claim path (payroll's `collectCommission` and claim `UPDATE`, the standalone
   calculation) requires both columns to be NULL, and rechecks the row count.
3. Both paths run under the same per-business advisory lock (`lockPayroll`), and the rows are
   locked `FOR UPDATE` before they are read.

Known limitation: a run does not create lines for rows payroll has already settled. They are
excluded and counted in a warning, and the member statement names the settling run or payroll
period for each row. The issue's wording («link run lines to the payroll settlement») is met
at the statement, not at the line.

## Immutability

- `commission_settlement_lines` — no UPDATE; DELETE only through a cascade or a reject
  (a transaction-local flag `app.commission_settlement_reset` that nothing else sets).
- `commission_settlement_runs` — the identity (number, period, branch, member filter,
  idempotency key, creator, creation time) cannot change; the lifecycle columns do. A run is
  never deleted except with its business.
- `commission_settlement_carries` — only `claimed_by_run_id` may change.
- `commission_settlement_payouts`, `…_allocations`, `…_events` — append-only.
- Actor columns are plain uuids with no foreign key, so deleting a user never rewrites a
  settlement record and never trips a guard.

Every table has tenant isolation (`tenant_isolation`, `FORCE ROW LEVEL SECURITY`) in the same
migration.

## Permissions

| Key | Grants |
| --- | --- |
| `commission.view` | Reading runs, lines, statements, the tie-out and exports. |
| `commission.calculate` | Creating a draft, calculating it, voiding a draft or calculated run. |
| `commission.approve` | Review, approval, reject, voiding a later run. |
| `commission.payout` | Release, paying, closing, and the payment-account list. |
| `commission.reverse` | Reversing a payout. |

All four imply `commission.view`. Default presets: owner and admin hold everything; the
accountant holds all four; the manager holds `commission.calculate` (not approval or payment).
`commission.manage` (rules, #764) is unchanged. The route guards are declared in
`GROWTH_API_PERMISSIONS` and asserted by `growth-access.test.ts`.

## API

| Method and path | Permission |
| --- | --- |
| `GET /api/commission/runs` (`status`, `limit`, `offset`, `format=csv`) | view |
| `POST /api/commission/runs` (create a draft; optional `Idempotency-Key`) | calculate |
| `GET /api/commission/runs/[id]` (detail, `actions`, `today`) | view |
| `GET /api/commission/runs/[id]/lines` (`employeeId`, `limit`, `offset`, `format=csv`) | view |
| `POST …/calculate`, `POST …/void` | calculate, or approve for a later run (`void` takes either) |
| `POST …/review`, `…/approve`, `…/reject` | approve |
| `POST …/release`, `…/close`, `…/payouts` | payout |
| `POST /api/commission/payouts/[id]/reverse` | reverse |
| `GET /api/commission/payment-accounts` | payout |
| `GET /api/commission/statement?employeeId=` | view |
| `GET /api/commission/liability` | view |

Money is an integer Rial string on the wire. Dates are `YYYY-MM-DD` on the wire and Shamsi on
screen. Errors are `{ error: <code>, …details }`; the codes are translated in
`commission-settlement-messages.ts`, and a test fails if the settlement code raises a code it
does not translate.

## Audit and events

Each transition writes an `audit_log` row (`commission.run.*`, `commission.payout.*`) and a
`commission_settlement_events` row with the actor's name, the status before and after, and the
note (a void's reason is required). The run page shows the trail.

## Deliberate decisions

- **Self-approval is refused, for everyone.** The person who calculated a run cannot approve it,
  owner included. Reverse this in `mayApproveRun` if the business wants an owner exemption.
- **Payouts reach the sync outbox as business-scope events.** Each payout and each
  reversal writes one `commission.payout.recorded@1` or `commission.payout.reversed@1`
  event in the same transaction as its journal entry (migration 0217). The event has no
  location, because a run covers every branch. Only the cloud writes one; a site refuses.
  A replayed copy is refused, and a pulled copy is acknowledged, never applied again. The
  design, and who receives what, is in `docs/server-sync.md` (*Business-scope events*).
- **Corrections are reversals, not edits.** A closed run is final. A mistake found after closing is
  corrected by a reversal (before close) or by an adjustment that the next run carries.
- **Unpaid balances after a close move forward; they are not written off.**

## Known gaps

- Sales lines whose seller has no matching rule never accrue, so the run cannot warn about them
  (the warning would have to come from the sales path). Surface this from the sales side.
- Amounts are stored as integer Rial and shown in the business's display unit.
- Category-scoped commission rules never match: the retail invoice path does not pass a category
  (`retail-invoice-service.ts`). This predates #869 and is unchanged.
- The statement shows at most 500 accruals and 500 payouts per member, with a `truncated` flag.
