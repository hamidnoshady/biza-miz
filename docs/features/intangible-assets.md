# دارایی‌های نامشهود — ثبت، استهلاک و کاهش ارزش

Intangible-asset accounting (issue #1326): purchased software, licences,
patents, trademarks, copyrights and qualifying development costs. This is a
**separate register** from tangible fixed assets, with its own tables, its own
control accounts and its own lifecycle.

## Why a separate register

`fixed_assets` is built around tangible assumptions — a salvage value, a
`cost > 0` check, depreciation methods (straight-line, declining balance,
units of production) and the 1500-block control accounts. An intangible has an
amortization period, may have **no** finite life, and must post to the
intangible control accounts. Adding a nullable "kind" to the existing table
would have merged two registers and their GL reconciliations, so migration
`0322_intangible_assets.sql` only adds tables and touches no existing row.

## Model

| Table | Holds |
| --- | --- |
| `intangible_assets` | Master: code, class, acquisition and in-service dates, capitalized cost (including directly attributable cost), finite/indefinite life, residual, the four/five mapped GL accounts, the capitalization policy note and approving user, evidence reference, branch, custodian, status and disposal facts. |
| `intangible_asset_amortization_entries` | One row per posted Jalali month. Reversal **marks** the row and mirrors the journal; the month may then be posted again (partial unique index on `(asset, period_key) WHERE reversed_at IS NULL`). |
| `intangible_asset_impairments` | Each assessment's evidence, effective date, recoverable amount, carrying amount before, and the posted amount. A reversal row points at the assessment it undoes, so history reads as a sequence of approved judgements. |
| `intangible_asset_estimate_changes` | Each prospective life/residual revision: effective date and month, previous and new values, the remaining amortizable base and life it left, the live balances at the decision, reason, evidence, approving and recording users, and an optional idempotency key. |

All child tables carry forced RLS scoped through the parent asset.

## Accounting rules

- **Capitalization is an explicit decision.** A policy note is required, and
  the approving user is recorded. Nothing is capitalized because it arrived on
  an invoice.
- **Finite life:** straight-line over a Jalali calendar, exact Rial, the final
  month absorbing rounding so the schedule lands exactly on the residual.
  The month arithmetic is `depreciation.ts`'s — the same code the tangible
  register uses, so the platform has one way to price a month.
- **Indefinite life:** never amortized. `POST …/amortize` refuses with
  `indefinite_life_not_amortized`; the asset is reviewed through
  `POST …/impair` instead.
- **Carrying amount** is always derived: `cost − accumulated amortization −
  accumulated impairment`. There is no balance column to drift.
- **Impairment:** `Dr impairment loss / Cr accumulated impairment` for the
  excess of carrying amount over the recoverable amount. A full reversal is the
  exact mirror of the original document; a partial reversal is its own approved
  document for the recovered amount.
- **Disposal (sale, retirement, write-off):** removes cost from the asset
  account, both accumulations from their contra accounts, recognizes proceeds
  and the gain/loss against **carrying amount**. After disposal the asset can
  never amortize again.
- **History is immutable:** amortization and impairment are reversed, never
  deleted; corrections are traceable documents.
- **Estimate changes are prospective:** revising the remaining life or residual
  records a new approved row and applies only from its effective month forward.
  The revised schedule spreads the remaining carrying amount (net of the new
  residual) over the revised life, the final month absorbs rounding, and every
  previously posted month and voucher stays exactly as it was. An effective
  date in a posted (or locked) period is refused; a residual above the current
  carrying amount is refused; a no-op change is refused.

## Posting identity

| `source_type` | `posting_kind` |
| --- | --- |
| `intangible_asset_acquisition` | `acquisition` |
| `intangible_asset_amortization` | `amortization` / `reversal` |
| `intangible_asset_impairment` | `impairment` / `reversal` |
| `intangible_asset_disposal` | `disposal` |

Every posting goes through the canonical ledger service, so fiscal-period locks,
voucher numbering, dimensions and tenant scoping are the ledger's own — not a
second implementation here.

## API

| Route | Method | Permission |
| --- | --- | --- |
| `/api/ledger/intangible-assets` | `GET` list + reconciliation, `POST` register | `ledger.view` / `finance.assets_manage` |
| `/api/ledger/intangible-assets/[id]` | `GET` asset, history, projected schedule | `ledger.view` |
| `/api/ledger/intangible-assets/[id]/amortize` | `POST` (`action: "reverse"` to undo a month) | `finance.assets_manage` |
| `/api/ledger/intangible-assets/[id]/impair` | `POST` assessment or `action: "reverse"` | `finance.assets_manage` |
| `/api/ledger/intangible-assets/[id]/dispose` | `POST` sale / retirement / write-off | `finance.assets_manage` |
| `/api/ledger/intangible-assets/[id]/estimate` | `GET` preview, `POST` prospective estimate change | `ledger.view` / `finance.assets_manage` |
| `/api/ledger/intangible-assets/reports` | `GET` the six reports | `ledger.view` |
| `/api/ledger/intangible-assets/export` | `GET` `format=csv|xlsx|pdf` and `report=…|all` | `ledger.view` |

Errors are stable codes (`indefinite_life_not_amortized`,
`period_already_amortized`, `no_impairment_required`, `intangible_asset_disposed`, …);
validation messages are Persian, matching the register's other forms.

## Reconciliation

`getIntangibleReconciliation` compares the register's cost, accumulated
amortization and accumulated impairment with the live balances of **exactly the
accounts each asset maps to** — no account-code ranges are assumed. Reversed
documents and their mirrors are both excluded, so a reversal contributes
nothing instead of cancelling twice. Assets with an incomplete mapping are
counted (`unmappedCount`) rather than silently reconciling.

## Tests

- `src/lib/intangible-assets.test.ts` — 18 unit tests: validation, schedule
  determinism and rounding, indefinite refusal, impairment and partial
  reversal, disposal gain/loss, reconciliation.
- `integration/intangible-assets.integration.test.ts` — 17 database tests:
  acquisition posting, deterministic amortization landing on the residual,
  reversal and re-posting, indefinite-life refusal, impairment + full/partial
  reversal, disposal gain/write-off, idempotency, tenant isolation and
  register↔ledger reconciliation before and after a reversal.

## Screen

The Accounting app has one section, «دارایی‌های نامشهود»
(`src/app/(app)/accounting/intangible-assets-section.tsx`): the register with
search, class/life/status/branch filters and pagination; a detail dialog with
tabs for general information, the amortization schedule (posted vs forecast),
posted vouchers, estimate-change history, impairment and reversals, disposal,
and reconciliation/audit history; and a reports tab with Jalali date ranges and
CSV/XLSX/PDF exports. Every amount it shows is the API's; the screen does not
calculate a financial balance itself.

## Reports and exports

`getIntangibleReports` returns six datasets over one filtered population:
register, period amortization schedule, posted amortization history,
impairment and reversals, disposals, and register↔ledger reconciliation. The
screen and the export route read that one function, so a filtered screen and
its file cannot disagree. `report=all` writes a workbook with a sheet per
report; CSV and PDF export the selected report. Amounts are exported as **exact
integer Rial** — the register's storage unit, the same figure the API returns —
and every money column says «ریال» in its label, so a file is never off by the
business's display-unit factor and never rounds a Rial away.

## Not yet built

- Impairment-review **reminders** for indefinite-life assets.
- A separate approval workflow for estimate changes: the capability
  (`finance.assets_manage`) and the recorded approving user are in place, but a
  second-person approval queue is not.
