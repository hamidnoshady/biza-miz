# Payroll — gross to net, accrual and settlement

`/accounting/payroll` («حقوق و دستمزد») is **journal-level** compensation
accounting. A month's run turns each member's standing pay terms into a
gross-to-net line, books the whole month as one balanced accrual, pays it out,
and can void it. Salary advances (مساعده) are paid ahead and recovered from
the next run.

It is **not** a statutory payroll engine. Every rate — insurance shares, the
insurance ceiling, the income-tax brackets, the exempt threshold — is entered
by the business; nothing is hard-coded, exactly as the VAT rate is the
business's own. There are no payslips, no filing outputs, no workflow to remit
the withheld insurance and tax, no attendance and no benefits engine. The
extension points a fuller engine would hang off are the *run* (a month's
identity) and the *line* (a per-employee snapshot); nothing else is built.

This page is the current behaviour: audit F11's gross-to-net payroll
(migration 0214), hardened by
[issue #835](https://github.com/hamidnoshady/biza-miz/issues/835) (migration
0215). The original feature is described in
[Phase 16](phases/Phase-16-Accounting-Suite.md); that document is a historical
record and carries an update note pointing here.

Code map:

- `src/lib/payroll-service.ts` — runs, payment, void, pay terms, history (DB).
- `src/lib/payroll-advances-service.ts` — advances and what is still owed (DB).
- `src/lib/payroll-accounts.ts` — which account a payout leaves (DB).
- `src/lib/payroll-db.ts` — the transaction helpers (`inTransaction`,
  `lockPayroll`) the services share.
- Pure modules: `payroll-gross-to-net` (settings document and calculator),
  `payroll-period`, `payroll-amounts`, `payroll-history-query`,
  `payroll-payment-accounts`, `payroll-amount-drafts`, `payroll-draft-memory`,
  plus the shared `payroll-types`, `payroll-errors` and `payroll-http`.
- Routes under `src/app/api/ledger/payroll/`, the screen under
  `src/app/(app)/accounting/payroll-*.tsx`, and migrations
  `migrations/0214_payroll_gross_to_net.sql` and
  `migrations/0215_payroll_hardening.sql`.

## The accounting model

| Step | Entry | Notes |
|---|---|---|
| Accrue | Debit 5200 (حقوق و دستمزد) = **gross**, and 5220 (بیمه سهم کارفرما) = employer + unemployment share. Credit 2300 (حقوق پرداختنی) = **net**, 2460 (بیمه پرداختنی) = all insurance shares, 2470 (مالیات حقوق پرداختنی) = income tax, 1260 (مساعده کارکنان) = advances recovered, 2490 (سایر کسور حقوق پرداختنی) = other deductions | One entry, balanced to the Rial. A side that is zero is left out, so a business that has entered no rates posts exactly the two-line Dr 5200 / Cr 2300 entry. Posted with a NULL location. |
| Pay | Debit 2300 / Credit a cash, bank or petty-cash account | **Net wages and commission** of the run together. The withholdings stay in their payables. |
| Advance | Debit 1260 / Credit a cash, bank or petty-cash account | Recovered by the next run (the credit to 1260 above). |
| Void | An exact mirror of every entry the run (or advance) posted | Never a delete. A void releases the month, the commission the run had claimed and the advance recovery it had made. |

Every entry goes through the same `postExactJournalEntry` /
`postExactMirrorEntry` path as the rest of the ledger, so the fiscal-period
lock applies to the accrual date, the payment date and the void date alike, and
the chart is the business's own (café and non-café templates alike — payroll
looks accounts up by well-known code).

Remitting the withheld insurance and tax to the authorities is **not** a
payroll workflow: the amounts wait in 2460, 2470 and 2490 until a manual
journal or a payment flow clears them.

### Business-wide, not branch-scoped

A run covers **every** active member of the business that has pay to settle.
That is a business-wide fact, so a run, its accrual, its payment and its void —
and an advance's entry — are all posted with `location_id = NULL`:

- the branch a user happens to have active cannot move a run;
- branch-filtered statements do not include payroll — it appears in the
  business-wide view, which is the honest answer for a bill that belongs to no
  single branch;
- there is no way to accrue under branch A and pay or void under branch B.

The alternative (a branch-scoped run containing only that branch's people) was
rejected: staff are members of the *business*, a person can work at several
branches, and the data model has no per-branch wage. An advance is business-wide
for a second reason: the run that recovers it credits 1260 business-wide, so a
per-branch debit would leave that account permanently unbalanced by branch.

A **legacy** run (created before #835) may carry a location. Its payment reuses
that stored location, never the caller's active branch, and a void mirrors each
original entry with that entry's own location.

## One run per month, and retries

A run is a **Jalali month**. Its identity is `periodKey`, `YYYY-MM`
(«1404-05»); the label («مرداد ۱۴۰۴») is only a heading derived from it. The
screen picks the year and the month from two selectors and offers no month that
has not started; the server refuses one that has (`400 period_in_future`).

Only the *spelling* of a key is normalised — Persian and Arabic-Indic digits, a
typographic dash for the hyphen, spaces and invisible marks around it.
«۱۴۰۴-۰۵», « 1404 – 05 » and «1404-05» are one period; «1404-5» and «1404/05»
are not a key at all (`400 invalid_period`). The history's `period` filter is
more forgiving and also takes a heading as a person would write it.

The database enforces uniqueness: `uq_payroll_runs_period` (migration 0214) is a
partial unique index on `(business_id, period_key)` for runs that are not
voided. A second accrual for the same month is refused with
`409 period_already_accrued` and the response names the blocking run. A voided
run releases its month, so a mistaken run can be voided and redone. Accruals
are also serialised per business with a transaction advisory lock
(`payroll:<businessId>`, which the advance flow takes too), so two concurrent
requests get one run and one refusal rather than a unique-violation race. The
dialog the screen opens on that refusal is informational; **the server is the
boundary.** The screen no longer pre-checks the (paginated) history for a
standing run for the same reason.

Runs created before 0214 have no key and keep their NULL; the service compares
a new month against their normalised free-text labels so they still block a
duplicate. (They are not matched by the history `period` filter — see
Limitations.)

The accrual date defaults to the month's last day for a closed month and to the
business's today for the month in progress; it can be set, and the fiscal-period
lock applies to it.

**Idempotency.** `POST /api/ledger/payroll/runs` accepts an `Idempotency-Key`
header (or an `idempotencyKey` body field): 8–128 visible ASCII characters (no
spaces; a blank key counts as none). Retrying the same key with the same month
returns the run it created (`200`, `idempotentReplay: true`) instead of a
duplicate or an error; a new run is `201`. The same key with a different month
or date is `409 idempotency_key_conflict`. The screen generates one key per
attempt and reuses it when that attempt is retried; changing the month, the
date or the commission option starts a new attempt with a new key.

## Gross to net

### The business's rates

`GET`/`PUT /api/ledger/payroll/settings` (view / manage) hold the business's
payroll settings document: employee, employer and unemployment insurance
shares, the insurance ceiling, whether non-taxable allowances are insurable,
whether the employee's share is deductible before tax, the exempt threshold and
up to 20 ascending income-tax brackets (the last open-ended). Every field is
optional and an empty field means *not applied*: a business that has entered
nothing gets gross = net. A `PUT` body must be a JSON object, and a malformed
document is `400` with the offending field.

### The calculation

`computeGrossToNet` (pure, `BigInt`) is the one calculator the screen's
preview, the route's validation and the service's posting all use, so they
agree to the Rial. Percentages become basis points and every product is rounded
half-up once per figure. The order is fixed and stated, because it decides the
answer:

```
gross          = base + taxable allowances + non-taxable allowances + overtime
insurance base = base + overtime + taxable allowances
                 (+ non-taxable allowances when the business says they are insurable),
                 capped at the ceiling when one is set
insurance      = insurance base × each share (employee, employer, unemployment)
taxable income = base + overtime + taxable allowances
                 (− the employee's insurance share when the business says it is deductible)
income tax     = progressive over the brackets, above the exempt threshold
net            = gross − employee insurance − tax − other deductions − advance recovery
employer cost  = gross + employer insurance + unemployment insurance
```

A member's standing terms are `monthlyWage`, `taxableAllowance`,
`nonTaxableAllowance` and `fixedDeduction` (the last is *other deductions*);
**this month's overtime** is the one figure that is not standing and travels
with the accrual request: `overtime: { "<userId>": "<Rial>" }`, a number or
integer text (text is how an amount past 2^53 stays exact). An unknown member,
a non-amount or an amount for somebody not on the run is
`400 invalid_overtime` naming the offender.

**Advance recovery is the only partial deduction:** what a member owes beyond
this month's remaining pay is carried to the next run. Every other deduction
must fit inside gross, and a month where it does not is refused —
`400 deductions_exceed_gross` — rather than posted as a negative salary.

### What a run stores

The run keeps `total_amount` (gross — the debit to 5200),
`net_amount` (what the accrual credited to 2300), `commission_total`, the
`settings_snapshot` it was computed with and, per line, the whole breakdown,
the name snapshot and the commission. A past run is therefore auditable after
the rates change. On the wire a run's `totalAmount` is the gross, `netAmount`
the net and `payableAmount` = net + commission; a line carries `baseSalaryRial`,
`taxableAllowancesRial`, `nonTaxableAllowancesRial`, `overtimeRial`,
`grossRial`, the three insurance figures, `incomeTaxRial`,
`otherDeductionsRial`, `advanceRecoveryRial`, `netPayRial` and
`employerCostRial`, all as integer text, plus `commissionAmount` and
`payableAmount`.

A run whose whole pay was recovered against advances has nothing to pay out: it
is marked paid without a payment entry.

## Salary advances

`POST /api/ledger/payroll/advances` (manage) pays an advance: Debit 1260 /
Credit a payout account, chosen exactly as a run's payment chooses (below).
`amount` is a JSON number — a whole Rial amount up to 2^53 − 1; a string, `true`
or a fraction is `400 invalid_amount`. An optional `advanceDate` (ISO, default
today, fiscal lock applies) and `note` (200 characters) are stored with it.
`GET` lists the 200 most recent advances, newest first (view).

What a member still owes is **derived** — their standing advances minus what
standing (not voided) runs recovered — never a mutable balance, so voiding a run
gives its recovery back by construction. The staff list carries it as
`advanceOutstanding`, and the next accrual recovers it from the net (up to what
is left of the month's pay).

`POST …/advances/{id}/void` (manage) mirrors the entry exactly. It is refused
(`409 advance_already_recovered`) when what the member still owes is less than
this advance — that is, once a run has recovered pay against it: void that run
first, then the advance. A voided advance cannot be voided again
(`409 already_voided`).

## Commission is settled with payroll

Commission accrues Debit 5210 / Credit 2300 the moment a sale posts
(`commission_accruals`), so it is already inside 2300. Before #835 a run
settled only the wage bill, which left every commission credit in 2300 for
ever, and a run marked «پرداخت‌شده» implied compensation that had not been paid.

Now a run **claims** the commission it settles:

- `commission_accruals.payroll_run_id` links an accrual to one run, so an
  accrual cannot be settled twice. A concurrent run waits on the row lock,
  re-reads, and finds it taken.
- Per member, the claimed amount is the signed sum of their unsettled accruals
  (a return posts a negative one). A member whose **net is positive** is
  settled in full; a member whose net is zero or negative claims nothing, and
  those rows wait for a later run to net against.
- Only accruals dated on or before the run's accrual date are claimed, so a
  back-dated run does not swallow later sales.
- **Commission is not gross pay here.** It is not run through insurance or
  income tax (the business's rates apply to the wage terms), and it adds no
  second accrual: it is already in 2300. The line stores the snapshot
  (`commission_amount`) and the run stores `commission_total`; the payment
  debits 2300 for net wages + commission together.
- Voiding a run clears its claims, so the next run can settle them.
- `includeCommission: false` on the accrual (and `?includeCommission=false` on
  the preview) makes a wage-only run; the commission waits.
- A member with **no wage and a positive commission net** is included as a
  commission-only line; a commission-only run posts no accrual entry.

**Tie-out.** `GET /api/ledger/payroll/preview` returns the commission an
accrual would settle (`commission`), the usable payout accounts
(`paymentAccounts`) and a `liability` block: the 2300 ledger balance, the runs
awaiting payment (net + commission), the commission no run has claimed, and
`difference` — what is left unexplained (a manual journal on 2300, or
commission paid outside payroll). The screen shows it, so a settled run never
hides an unsettled balance. (The withheld insurance, tax and other deductions
sit in their own payables, not in 2300.)

## Payment accounts

A payment or an advance credits one of the business's own **cash, bank or
petty-cash** accounts — the same canonical classification the other settlement
flows use (`src/lib/payroll-payment-accounts.ts` over the chart; a leaf asset
account, never the card-clearing account). `GET …/preview` lists them under
`paymentAccounts`, and the body carries `paymentAccountId`. The older
`method: "cash" | "bank"` shorthand still works when no account is named:
`cash` → صندوق (1100), `bank` → بانک (1110). `bank` no longer maps to 1120, the
card-processor clearing account: that is money still on its way from the
processor, so a wage paid by transfer made the books claim the money left an
account that did not yet hold it, and the real bank account never moved.
(AR/AP/installment settlement still maps «bank» to 1120; that is outside this
page.) The screen defaults to cash and offers the shorthand only when the chart
has no account to pick.

## Dates

- The accrual date, the payment date and the advance date are ISO `YYYY-MM-DD`.
  A malformed value is a controlled `400 invalid_accrual_date` /
  `invalid_paid_date` / `invalid_advance_date`, never a database error. A blank
  value means the default above.
- The screen offers a Jalali date picker for the dates (optional) and converts
  to ISO for the API.
- **Chronology:** a payment may not be dated before the run's accrual date
  (`400 paid_date_before_accrual`). The default «today» (the business's own day)
  is read once, and that one value is checked against the accrual date, written
  to the journal entry and stored on the run, so the three cannot disagree even
  if a payment is made as midnight passes.
- The same payment date is written to the journal entry and to the run
  (`paid_date`); the fiscal-period lock applies to it (`409` with the lock code).
- A void is dated by the real instant it happens (`voidedDate`, an ISO
  timestamp), not backdated.

## Pay terms and the audit trail

`PATCH /api/ledger/payroll/staff/{id}` (`payroll.manage`) sets some of one
member's standing terms — `monthlyWage`, `taxableAllowance`,
`nonTaxableAllowance`, `fixedDeduction`:

| Body | Result |
|---|---|
| a term's key missing | that term is **left as it is** — a missing key never clears a salary or zeroes an allowance |
| no term key at all | `400 bad_request` |
| `monthlyWage: null` | clears the wage («no wage set») |
| `<term>: <integer Rial number>` | sets it (non-negative integer up to 2^53−1) |
| string, boolean, array, object, fraction, negative, a number past 2^53−1, `NaN`, or `null` for an allowance | `400 invalid_amount` naming the term (`field`) |

An optional `reason` is stored with the change: trimmed, at most 500
characters, and a blank one counts as no reason (it is not an error). Only the
four terms (and `reason`) are read from the body — a request cannot also change
a role or an active flag through this endpoint. Because only the keys present
are written, a request carrying just an allowance is valid, and the screen
sends only the terms that changed.

Every change writes an **immutable** row to `payroll_pay_term_changes`
(business, member, which `term`, previous amount, new amount, who, when,
optional reason, plus name snapshots). A trigger refuses `UPDATE` and `DELETE`;
only the cascade that removes a whole business may delete. The table has no
foreign key to `users` on purpose (a referential action would be an `UPDATE` of
an immutable row; the snapshots keep the row readable after a rename or
removal). A no-op save (same value) writes nothing. The history is served by
`GET /api/ledger/payroll/staff/{id}/history` and is visible only with
`payroll.view`. **Pay amounts are deliberately not written to the general audit
log**, because that log is readable by roles that must not see salaries.

Issue #835 asked for an audit of the *wage*; it is generalised to all four
terms because the allowances and the deduction decide the net just as the wage
does.

## Employee identity on a run

`payroll_run_lines` stores `employee_name_snapshot`, `employee_code_snapshot`
and `employee_role_snapshot` at accrual time, and a trigger makes the line
immutable afterwards (only the referential `user_id → NULL` of a deleted member
may touch it). Renaming a member does not rewrite history; deleting one keeps
the name on every historical line. `user_id` stays optional. Lines that predate
the migration were backfilled from the member as they are today; a line whose
member was already gone cannot be recovered and keeps the «عضو حذف‌شده»
fallback.

## History

`GET /api/ledger/payroll/runs` is bounded and newest-first:

| Query | Meaning |
|---|---|
| `limit` | 1–100, default 20 (larger is clamped; garbage is `400 invalid_limit`) |
| `cursor` | the previous page's `nextCursor` (opaque; a hand-edited one is `400 invalid_cursor`) |
| `status` | `accrued`, `paid` or `voided` |
| `from`, `to` | accrual date range, inclusive, ISO |
| `period` | a month, as a key or as a person would type it — matched by identity, not spelling |

Order is `(accrual_date, created_at, id)` descending. The cursor carries the
last row's own sort key (keyset, not offset), so a run created while somebody
pages does not shift or repeat rows. A page holds **summaries**; the lines of a
run are fetched lazily with `GET /api/ledger/payroll/runs/{id}`. The response is
`{ runs, nextCursor }`.

## Exact money

Amounts are `bigint` in Postgres, integer **text** (Rial) on the wire and in the
service, and `BigInt` wherever they are summed — including the gross-to-net
calculator. Nothing is converted through `Number` — wages, lines, totals,
aggregation, journal posting, the API and the screen are exact beyond
JavaScript's 2^53. The accepted ceiling is the shared `MAX_RIAL`; above it is
`400 amount_out_of_range` (an input, or a run's total) or `amount_too_large` (a
calculated figure). An amount that must be a JSON number (a pay term, an
advance) is refused client-side past 2^53 − 1 instead of being rounded. The
screen builds request bodies from digits and displays in the business's chosen
unit (Rial or Toman) through `useMoney`.

## The screen

- A member's four pay terms are four boxes, each held **canonically in Rial**
  and converted from the display unit on entry. Switching Rial ↔ Toman with an
  unsaved edit therefore re-displays the same amount instead of re-reading
  digits in the other unit (the old 10× error). Overtime and an advance's amount
  follow the same rule.
- The accrual form is a live preview: the saved terms and the overtime typed so
  far, run through the same calculator, with a total row; a member whose
  deductions exceed their gross is named and the button is disabled. Commission
  comes from `GET preview`. Nothing is previewed from a rate the screen could
  not read — it says so instead of guessing.
- Unsaved pay-term edits are guarded on in-app navigation as well as on
  `beforeunload`: leaving the section through the in-page chips, the app menu
  or any in-app link asks whether to stay or to leave and discard. The shared
  pattern is `src/components/navigation/unsaved-changes-guard.tsx`.
- Confirmation uses the shared RTL `Dialog`, not `window.confirm`.
- Each run shows the gross, net and commission components, status, payment date
  and who accrued it; its per-employee breakdown loads on demand.
- A member with `payroll.view` but not `payroll.manage` sees the screen
  read-only: the pay-term boxes are disabled, and nothing that saves, accrues,
  pays, voids or edits the rates is drawn. The server enforces both
  capabilities; the screen only decides which controls to show.

## Permissions

| Capability | Gates |
|---|---|
| `payroll.view` | the section and menu entry, `GET staff`, `GET staff/{id}/history`, `GET runs`, `GET runs/{id}`, `GET preview`, `GET advances`, `GET settings` |
| `payroll.manage` (implies view) | `PATCH staff/{id}`, `POST runs`, `POST runs/{id}/pay`, `POST runs/{id}/void`, `POST advances`, `POST advances/{id}/void`, `PUT settings` |

The default presets give both to the owner, the admin and the accountant and
neither to the manager; a business can grant or revoke either key per member.
Code tests the capability, never a role name. The AI tool `get_payroll_summary`
reads through the same service and is gated the same way.

## Errors

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | body is not a JSON object (or names no pay term) |
| `invalid_period`, `period_in_future` | 400 | the key is not a `YYYY-MM` Jalali month / the month has not started |
| `invalid_accrual_date`, `invalid_paid_date`, `invalid_advance_date` | 400 | malformed ISO date |
| `paid_date_before_accrual` | 400 | payment dated before the accrual |
| `invalid_method`, `invalid_payment_account` | 400 | unknown method / not a usable cash-bank account |
| `invalid_amount`, `amount_out_of_range`, `amount_too_large` | 400 | not an exact non-negative integer / above the ceiling (`amount_out_of_range`: an input or a run total; `amount_too_large`: one calculated figure) |
| `invalid_overtime` | 400 | an overtime entry that names nobody on the run, or is not an amount (`field` = the member) |
| `deductions_exceed_gross` | 400 | a member's deductions are more than their gross pay (`field` = the member) |
| `invalid_settings`, `invalid_percent`, `invalid_brackets`, `brackets_not_ascending`, `last_bracket_must_be_open`, `too_many_brackets` | 400 | the settings document |
| `invalid_wage_reason` | 400 | the pay-term `reason` is not a string, or is over 500 characters once trimmed |
| `note_too_long` | 400 | an advance's note is over 200 characters |
| `invalid_limit`, `invalid_cursor`, `invalid_run_status`, `invalid_date` | 400 | bad history query |
| `idempotency_key_invalid` | 400 | key is not a string of 8–128 visible ASCII characters (or the header and body keys differ) |
| `no_wages_set` | 400 | nobody has a wage (or commission) to settle |
| `run_not_found`, `user_not_found`, `advance_not_found` | 404 | not in this business |
| `period_already_accrued` | 409 | a standing run exists for the month (names it) |
| `idempotency_key_conflict` | 409 | the key was used for a different request |
| `already_paid`, `already_voided`, `run_voided` | 409 | wrong state for this action |
| `advance_already_recovered` | 409 | a run has already recovered part of the advance |
| `commission_already_settled` | 409 | another run claimed the commission first |
| `ledger_account_missing` | 409 | a system account the posting needs is absent |
| fiscal-period lock codes | 409 | the date falls in a closed or locked period |

The screen words each code in Persian: payroll's own map is
`payroll-error-messages.ts` (a source-scanning test keeps it complete and free
of dead entries), consulted first by the section and last by
`accounting-errors.ts`, so a code the payroll section shares with the receipts
and payments screens keeps *their* wording there.

## Limitations

- **Browser Back/Forward cannot be intercepted** in the Next.js App Router.
  Rather than pretend, unsaved pay-term drafts are kept in memory per member
  (30-minute expiry) and restored when the screen is reopened.
- **Legacy runs keep a NULL `period_key`**, so the history `period` filter does
  not match them (the duplicate check still does). Free-text periods are gone: a
  new run is always a Jalali month.
- **Commission expense stays attributed to the selling branch** (that is where
  5210 was posted), while its settlement through payroll is business-wide.
- **The first run after upgrade can settle all historical unsettled
  commission.** Use `includeCommission: false` to defer it.
- AR/AP/installment settlement still maps «bank» to 1120 (card clearing).
- Not built, on purpose: payslips, filing outputs, remitting the withheld
  amounts, attendance, and a benefits engine.
