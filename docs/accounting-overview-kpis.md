# Accounting Overview KPI definitions (#912)

Canonical page: `/accounting/overview`. All amounts are stored integer Rial; the
overview API returns exact integer-Rial **strings** (BigInt-safe) and the UI
formats them with `money.formatText` in the business's Rial/Toman display unit.

| Tile | Definition | Period / cutoff |
| --- | --- | --- |
| Usable liquidity (cash/bank/petty cash) | Normal-balance sum of accounts classified cash/bank/petty_cash by `account-classification` | Balance-sheet position: journal entries with `entry_date <= asOfDate` (business-local today by default; `GET /api/ledger/overview?asOf=YYYY-MM-DD`) |
| Clearing in transit | Classified clearing roles; explicitly not spendable | Same as-of cutoff |
| Customer receivables / other / VAT recoverable | Classified trade_receivable, other_receivable, vat_receivable kept separate | Same |
| Supplier payables | Classified trade_payable only — not total liabilities | Same |
| Revenue / expenses / net income | Operational P&L **excluding** `closing` entries (`source_type`/`posting_kind = 'closing'`), so a closed fiscal year still shows its performance | Current fiscal year covering the as-of date when one exists (`scope.fiscalYearLabel/periodFrom/periodTo`); otherwise all-time operational (`scope.period = "all_time_operational"`) |
| Provisional online profit | Lines whose `cost_status` is not `known`/`not_applicable`, non-voided, with `returned_quantity < quantity`; exposure is prorated `net_rial × (quantity − returned_quantity) / quantity`. Fully returned lines contribute 0. `costCoverage.affected` lists up to 20 source lines for drill-down | Outstanding at read time |

Policy (issue #912 §8): `ledger.view` grants business-wide ledger visibility —
the overview deliberately aggregates all branches (`scope.branches = "all"`),
consistent with the trial balance. Branch-limited roles must not be granted
`ledger.view`; per-branch operational reports remain governed by their own
report scopes.

Shift quick report: operational (orders/payments, not the ledger). Its
drill-down uses `mode=settled-since&since=<windowStart>&status=completed` in the
shift-orders report, i.e. orders **completed/closed** at or after the same
server-provided window start, all channels — identical count/total definitions
to the card. The report's original opened-in-shift mode is unchanged for its
other callers. Legacy `employee_shifts` rows with `location_id IS NULL` only
count toward a branch's last-close/open state when the business has a single
location, so they cannot contaminate another branch in multi-branch tenants.
