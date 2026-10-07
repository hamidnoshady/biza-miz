# Phase 30 — The Missing Account Headings, and Cheques (سرفصل‌های جاافتاده و چک)

## Why

Two problems that turned out to be the same shape: the chart of accounts was answering a
question ("what can this business record?") that nobody had asked it as a whole since Phase 7.

### The retail charts had drifted from the features every business gets

`src/lib/coa-template.ts` holds one seed chart per industry. F&B's was built first, and every
account a later phase needed was appended to it. The four retail templates (jewelry, watch,
accessories, cosmetics) were each written as *"the generic accounts plus this trade's
inventory/revenue/COGS triple"* and then never revisited when a **cross-industry** feature added
a well-known account.

But `industry-profile.ts` puts `ledger` in `CORE_MODULES`. Every business, whatever it sells, has
payroll, fixed assets, expenses, reconciliation and year-end closing. So:

| Feature, offered to every trade | Needs | Retail templates had it? |
|---|---|---|
| Payroll accrual (`payroll-service.ts`) | `5200 حقوق و دستمزد` | **no** — but they all had `2300 حقوق پرداختنی` |
| Monthly depreciation (`fixed-assets-service.ts`) | `1510` + `5700` | **no** — but they all had `1500 اثاثه و تجهیزات` |
| Markdown (`merchandising-posting-rules.ts`) | `5170` | **no** |
| Supplier return settled as a receivable (`retail-stock-posting-rules.ts`) | `1210` | **no** |

Each of those failed outright with `ledger_account_missing` in a real jewellery, watch,
accessories or cosmetics shop. The first two are not edge cases — they are the payroll run and
the month-end depreciation.

Two things hid it, and both are fixed here:

- `coa-template.test.ts` asserted only a hand-written subset per retail template — each trade's
  own three accounts — so nothing checked the accounts a *shared* feature needs.
- The integration tests hand-inserted the accounts they posted against instead of seeding from
  the template. `merchandising.integration.test.ts` inserted `5170` itself; a cosmetics markdown
  therefore posted fine in CI and failed in production.

### Headings no template had at all

Beyond the drift, a set of ordinary headings was missing from **every** chart, F&B included —
discounts given (order payment credits revenue *net* of them, so a discount never appeared in the
ledger at all), the service charge `orders` already carries a column for, bank and PSP charges, a
till over/short, petty cash, payroll withholdings, income tax, borrowings, the owner's drawings,
and fixed-asset disposal.

### And cheques, which did not exist

`payment_method` was `cash/card/card_to_card/online/credit/snappfood`. There were no cheque
tables, no اسناد دریافتنی or اسناد پرداختنی accounts, and no endorsement path —
`order-amendments.test.ts` literally used `"cheque"` as its example of an *invalid* payment
method. That is most of the trade credit in an Iranian business, and none of it was representable
except as manual journal entries against accounts that did not exist either.

## What changed

### The chart

Shared blocks (`SHARED_ASSET_ACCOUNTS` … `SHARED_EXPENSE_ACCOUNTS`, `RETAIL_ASSET_ACCOUNTS`,
`RETAIL_EXPENSE_ACCOUNTS`) spread into all five templates, so "every business gets these" is true
by construction rather than by five copies staying in sync. Existing businesses are backfilled by
`migrations/0094_missing_account_headings.sql`, additively and idempotently — a business that
already has a code, renamed it, or archived it is untouched, the same rule `seedChartOfAccounts`
and the platform console's industry-change path already follow.

The Tier-2 headings are deliberately **not** in `WELL_KNOWN_CODES`. That set is the "can never be
archived or deleted" list (`accounts-service.ts`); nothing posts to these automatically, so a
business that doesn't use one should be able to drop it.

### Reporting

- `COST_OF_SALES_CODES` (one flat list of F&B's codes) became
  `costOfSalesCodesForIndustry(industry)`. It was not wrong by a little: a jeweller's `5110`, a
  watch shop's `5120` and an accessories shop's `5140` all fell into operating expense, so
  **`grossProfit` came out equal to total revenue** for three of the five trades. Cosmetics
  happened to work, and only because its COGS is `5150` — the code F&B uses for waste.
  `getProfitAndLoss` resolves the industry itself via `getBusinessIndustry`, so none of its six
  call sites changed.
- The balance sheet gained a جاری/غیرجاری split (`isNonCurrentCode`, a pure helper: assets
  1500–1599 and liabilities 2500+ are non-current). It partitions rather than filters — every
  line still appears exactly once, and the subtotals add to the existing totals.
- `CASH_EQUIVALENT_CODES` gained `1110 بانک`. It was excluded because nothing auto-posted to it;
  a cheque clears *into the bank*, so leaving it out would drop every cleared cheque from the
  cash-flow statement.

### Cheques

Accounts (these **are** well-known — posting paths look them up by code): `1240 اسناد دریافتنی`
with معین children `1241 چک‌های نزد صندوق`, `1242 چک‌های در جریان وصول`, `1244 چک‌های برگشتی`;
`2120 اسناد پرداختنی` with `2121 چک‌های صادرشده در جریان` and `2122 چک‌های پرداختنی برگشتی`; and
`5860 هزینه چک برگشتی و جرایم بانکی`.

Schema (`migrations/0095_cheques.sql`): `cheques` — one table for both directions, since a cheque
we hold and one we wrote have the same fields and differ only in which statuses they can be in —
plus `cheque_events`, the append-only transition log, each row pointing at the entry its step
posted. Both tables carry an RLS policy in the same migration.

Lifecycle and postings live in `src/lib/cheques.ts` (pure: the transition table, صیاد-id
normalisation, due-date bucketing) and `src/lib/cheques-service.ts` (the transaction that writes
the row and its entry together). The register is the «چک‌ها» tab of `/dashboard/ledger`.

| Step | Entry |
|---|---|
| received | Debit `1241` / Credit `1200` |
| deposit | Debit `1242` / Credit `1241` |
| clear (from collection) | Debit `1110` / Credit `1242` |
| endorse | Debit `2100` / Credit `1241` |
| clear (from endorsed) | **none** |
| bounce | Debit `1244` / Credit wherever it was (`2100` if endorsed) |
| issued | Debit `2100` / Credit `2121` |
| present | Debit `2121` / Credit `1110` |
| bounce (payable) | Debit `2121` / Credit `2122` |
| cancel | Debit `2121` / Credit `2100` |

## The load-bearing decisions

**1. `endorsed` is a status, not an account.** Iranian charts often carry a «چک‌های واگذارشده»
account, but an endorsed cheque is *contingent*: it has left our assets (the supplier's balance
really did go down) and comes back only if it bounces. Carrying it as an asset needs an
unbalanced memo pair. So the endorsement posts Debit `2100` / Credit `1241`, the contingency lives
as the cheque's status where the register can show it, and a bounce is a real entry (Debit `1244`
/ Credit `2100`) that puts the debt back on us and the bad cheque back on our books. Clearing an
endorsed cheque posts nothing at all — the debt already moved; the status advances so the register
stops calling it outstanding.

**2. A cheque is recorded in the register, not taken as a till tender.** The `cheque` settlement
class exists (`payment_method` gained the value in `0096`) so the ledger knows which account a
cheque lands in, and `SETTLEMENT_DEBIT_CODES` maps it to `1241`. But no «چک» payment way is
seeded, and `CUSTOM_PAYMENT_SETTLEMENTS` excludes `cheque` so nobody can mint one. Two reasons:

- a tender slot cannot hold a serial, a bank, a due date and a صیاد id, so `1241` would carry a
  balance no register could explain; and
- a shift reconciles `gross_total` against exactly four method buckets, and those buckets are
  `daily_rollups` columns, a sync payload and a reports registry. A cheque-settled order would sit
  in `gross_total` with nothing accounting for it, at every cash-up.

The money still works: the sale goes on نسیه (AR), and the cheque settles the customer's account —
which is how it happens at the counter anyway. Adding a till tender later is a self-contained
follow-up (cheque-detail capture in the checkout + a fifth rollup bucket), not something to bury
here.

**3. A bounced receivable is terminal.** Re-presenting is a new cheque row, because the
counterparty hands over a new cheque in practice, and because a status that can loop makes "what
happened to this cheque" unanswerable from the event log.

> **Revised by issue #828 (migrations 0211/0212).** The *instrument* is still dead — a bounce
> never loops back to `on_hand` — but the *balance* is not. A returned cheque left the value
> sitting in «۱۲۴۴ چک‌های برگشتی» / «۲۱۲۲ چک‌های پرداختنی برگشتی» with no supported way out, and
> registering a replacement as an ordinary new cheque credits/debits the control account a second
> time instead of moving the returned balance. A `bounced` cheque now offers exactly two
> resolutions — `settle` (paid another way: the returned account clears against بانک, status
> `cleared`) and `restore` (the debt goes back to حساب‌های دریافتنی/پرداختنی, status `resolved`,
> after which a replacement cheque is registered normally and the two entries net out). An
> optional returned-cheque charge posts to «۵۸۶۰ هزینه چک برگشتی و جرایم بانکی» on the bounce
> itself.

## Where the exit criteria are satisfied

- Retail payroll and depreciation post against the template's own chart —
  `integration/payroll.integration.test.ts` and `integration/fixed-assets.integration.test.ts`,
  both seeding via `seedChartOfAccounts` for all four retail trades.
- A markdown and a supplier-receivable return post against the seeded cosmetics chart —
  `integration/merchandising.integration.test.ts`, `integration/retail-stock.integration.test.ts`
  (both switched from hand-inserted accounts to the real template).
- Every template carries every account a cross-industry feature needs —
  `src/lib/coa-template.test.ts`'s `CORE_REQUIRED_CODES`, asserted across all five.
- Industry-aware gross profit and the balance-sheet split —
  `integration/financial-statements.integration.test.ts`.
- The cheque lifecycle, endorsement in both outcomes, the transition guards, RLS isolation and the
  fiscal-period lock — `integration/cheques.integration.test.ts`; the transition table itself in
  `src/lib/cheques.test.ts`.
- The backfill is additive and idempotent — replaying `0094` against a chart seeded from the old
  templates adds only the missing rows and a second replay adds none.
