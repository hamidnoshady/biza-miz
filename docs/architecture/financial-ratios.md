# Financial ratios and management analysis (issue #1324)

«تحلیل مالی» is a derived reporting layer, not an accounting document. It reads
the same journal lines as the trial balance, P&L, balance sheet and cash-flow
statement and computes ratios on request. It stores no balance, caches no
figure and writes no journal entry: the ledger remains the single source of
truth.

- Engine: `src/lib/financial-ratios.ts` (catalogue, formulas, formatting)
- Service: `src/lib/financial-ratios-service.ts` (account mapping, ledger reads,
  report assembly, trend)
- API: `GET /api/reports/financial-ratios`, `PUT /api/reports/financial-ratios/mapping`
- Screen: `src/app/dashboard/reports/financial-ratios-section.tsx` (tab «تحلیل مالی»)
- Export: `POST /api/reports/export` with `kind: "financial_ratios"`

## Where the numbers come from

Every read goes through `journal_lines → journal_entries → accounts`, with the
carry-forward snapshots excluded (`notCarryForwardSnapshotSql`) and the
authorized `ReportScope` applied (`je.location_id` for a branch, no location
predicate for business-wide). This is the same predicate set the statements
use.

| Input | Accounts | Period |
| --- | --- | --- |
| `cashAndEquivalents` | asset accounts whose classified role is usable liquidity | balance at `dateTo` |
| `tradeReceivables` | asset role `trade_receivable` | balance at `dateTo` |
| `tradePayables` | liability role `trade_payable` | balance at `dateTo` |
| `inventory` | asset codes 1300–1399 | balance at `dateTo` |
| `currentAssets` / `currentLiabilities` | assets/liabilities that are not non-current by code | balance at `dateTo` |
| `totalAssets` / `totalLiabilities` | all asset/liability accounts | balance at `dateTo` |
| `totalEquity` | equity accounts + unclosed revenue − unclosed expense | balance at `dateTo` |
| `netRevenue`, `costOfSales`, `netIncome` | revenue accounts; expense accounts in `costOfSalesCodesForIndustry`; all P&L accounts | movement in `[dateFrom, dateTo]` |
| `interestExpense` | account codes named in `reports.financial_ratio_mapping` | movement |
| `opening*` | the same balance definitions | balance at `dateFrom − 1` |

The retained-earnings component of equity matches `getBalanceSheet`; the
reconciliation is asserted by both the report (`checks.balanceSheetBalanced`)
and the integration test.

## Interest expense: the one reviewed mapping

The seeded charts have no interest-expense account, so there is no default
classification. The business names its interest-expense account(s) once in the
report's «حساب هزینهٔ بهره» card (permission `reports.manage`); the setting is
`reports.financial_ratio_mapping`. Codes must exist in the chart as expense
accounts. Until then interest coverage is `unavailable` with
`interest_expense_not_classified`, and operating profit does not exclude any
interest expense (the warning says so). No code block or account name is
guessed.

## Formulae and conventions

Units: ratios are plain multiples (2 decimals on screen), margins and returns
are percentages (1 decimal), day counts are days (1 decimal). Arithmetic uses
`decimal.js`; only presentation rounds. Values are returned unrounded and the
export carries the same `display` string the screen shows.

| Group | Ratio | Formula |
| --- | --- | --- |
| Liquidity | current | current assets ÷ current liabilities |
| | quick | (cash + trade receivables) ÷ current liabilities |
| | cash | cash ÷ current liabilities |
| Leverage | debt to assets | total liabilities ÷ total assets |
| | debt to equity | total liabilities ÷ total equity |
| | interest coverage | (net income + interest expense) ÷ interest expense |
| Profitability | gross margin | (revenue − cost of sales) ÷ revenue × 100 |
| | operating margin | (gross profit − operating expenses) ÷ revenue × 100 |
| | net margin | net income ÷ revenue × 100 |
| Returns | return on assets | net income ÷ average total assets × 100 |
| | return on equity | net income ÷ average total equity × 100 |
| Efficiency | inventory turnover | cost of sales ÷ average inventory |
| | days inventory outstanding | period days ÷ inventory turnover |
| | receivables turnover | net revenue ÷ average trade receivables |
| | days sales outstanding | period days ÷ receivables turnover |
| | payables turnover | cost of sales ÷ average trade payables |
| | days payable outstanding | period days ÷ payables turnover |
| | asset turnover | net revenue ÷ average total assets |

- **Periods.** Both bounds are inclusive. Average balances use the closing
  balance at `dateTo` and the balance at `dateFrom − 1`; there is no average
  against a missing opening — that ratio is unavailable.
- **Signs.** Assets and expenses are debit-positive; liabilities, equity and
  revenue are credit-positive. A negative result (negative margin, negative
  EBIT) is shown as a fact, not turned into an error.
- **Comparisons.** `compare=1` computes the immediately preceding period of the
  same length. Change is only shown when both periods are available.
- **Trend.** `trend=N` computes N rolling periods of the selected length ending
  at the selected period. Calendar (Jalali) months are not used because their
  lengths do not align with storage dates; like-length periods keep the
  comparison honest. Missing points are omitted from the chart, and the caption
  states how many of the computed periods had data.
- **Receivables/payables bases.** The ledger has no credit-sales or
  credit-purchase split, so turnover uses net revenue and COGS respectively.
  Both are labelled on screen.

## Unavailable, not invented

A ratio returns `available`, `unavailable` or `not_applicable`, with a reason
code and a Persian explanation:

`missing_input`, `zero_denominator`, `non_positive_denominator`,
`non_positive_numerator`, `no_revenue`, `no_opening_comparative`,
`no_period_days`, `invalid_period`, `derived_unavailable`,
`interest_expense_not_classified`.

A missing input or an invalid denominator never becomes zero, infinity or a
blank cell. The screen shows the status and reason, and the export writes
`—` with the same status and note.

## Scope, dimensions and permissions

- `reports.view` is required to read the report. Business-wide scope also
  requires `reports.business_wide`; otherwise the report is the member's
  authorized branch. A branch from the query string is never trusted.
- A dimension filter is an additional line filter and requires `ledger.view`,
  the same door as the dimension reports. Under a dimension filter the filtered
  lines are not a balanced trial balance, so the balance check is reported as
  `null` (not asserted) and the screen warns that the figures are that slice.
- The mapping write requires `reports.manage`; the account validation query is
  scoped to the business, and all reads run under the tenant-scoped connection
  (`withTenantScope`), so RLS and tenant isolation apply unchanged.
- Drill-down opens the existing `DrillDownPanel` against the account and the
  same period/scope; the journal itself enforces its own permissions.

## Verification

- `src/lib/financial-ratios.test.ts` — hand-calculated fixtures for all
  eighteen ratios, missing/zero/negative data, opening comparatives, period
  boundaries and formatting.
- `integration/financial-ratios.integration.test.ts` — posts a real book and
  compares every input with `getProfitAndLoss` and `getBalanceSheet`; covers
  the interest mapping (before and after), no opening balance, comparison
  period, branch isolation, dimension filtering, export/display parity, and a
  new posting changing the next calculation (no stored balances).
