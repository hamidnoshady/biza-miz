# The ledger model: a continuous history with documentary carry-forwards

_Resolution of GH #1334 / ESH-165 — "Trial balance double-counts carry-forward
entries against history" (P0)._

## The decision, in one paragraph

The ledger is **one continuous history per business**. A fiscal-year
carry-forward posts an ordinary, numbered, reversible journal entry at the new
year's first day — but that entry is a **documentary snapshot** of balances the
ledger already carries from prior years. Every **balance read** excludes the
snapshot through a single predicate, `is_carry_forward_snapshot(entry)`
(migration `0297_carry_forward_snapshot.sql`), so the carried balance appears
exactly once: inside the history it mirrors. Every **document read** keeps the
snapshot visible, because it is a real, auditable, reversible voucher. No
historical journal is ever rewritten, and no production data migration is
required: the predicate recognises already-posted snapshots retroactively.

## Why a snapshot, not "opening entries are all suspect"

The obvious shortcut — `WHERE source_type <> 'opening'` — is wrong and the
tests pin it: `source_type = 'opening'` also carries **real history**. A
business's manual initial-opening set (`opening_balance_sets.source =
'manual'`) and the setup wizard's own opening entry (`source_id` naming no set
at all) are genuine ledger history; a blanket filter would silently erase them
(the reproduced failure: a manual 100,000 Rial opening reported as 0). The
discriminator is therefore the **set's own** row:

```sql
-- entry is a carry-forward snapshot iff
je.source_type = 'opening'
AND EXISTS (SELECT 1 FROM opening_balance_sets s
             WHERE s.id = je.source_id AND s.source = 'carry_forward')
```

Cheap-first (a `CASE` so ordinary rows never probe `opening_balance_sets`),
`STABLE`, `SECURITY INVOKER`, NULL-safe. It lives in the database as
`is_carry_forward_snapshot(journal_entries)`; TypeScript call sites wrap it
with `notCarryForwardSnapshotSql(alias)` from
`src/lib/carry-forward-exclusion.ts`.

## The boundary: what excludes the snapshot, what does not

### Balance reads — excluded

Anything whose answer is "how much money is there" runs through the predicate
(or, for the reporting view, through `v_ledger_by_account`, which embeds it in
migration 0297):

- **Trial balance** (`getTrialBalance`) — opening, period and closing columns,
  and the as-of variant; **`lifetimeAccountMovements`** (KPI overview).
- **Reporting view `v_ledger_by_account`** — every standard report and export
  driven by it (balance sheet, P&L, business overview, rollups, COGS, …).
- **Account statement** (opening sum and the lines list) and **account
  drill-down**.
- **Cash flow** — opening/closing cash, net change, per-entry activity
  classification (without the exclusion a snapshot reads as a phantom
  financing inflow), VAT account totals, clearing change.
- **Subledgers** — the A/R and A/P attribution fragments (which is what makes
  the reconciliation control, aging and per-party balances agree), the
  reconciliation control CTEs, `wellKnownAccountBalance`.
- **Dimension reports** (matrix, P&L by dimension, rollup — all three query
  shapes).
- **Financial accounts** — list balances, as-of balance, movement statement,
  archive guard.
- **Growth bridge**, **shareholder** reconciliation/statement/retained-earnings
  gate, **multicurrency** foreign trial balance, party balances, book/foreign
  balances, **FNB** waste ledger, **petty cash** fund balances,
  **payroll/commission liability** reads, **Holoo discrepancy** comparison.
- **`readCarryForwardInput`** — the carry-forward derivation itself. This is
  what stops compounding: at the next transition the generator reads balances
  with the snapshot excluded, so a 1405 snapshot never migrates into the 1406
  snapshot (reproduced pre-fix: A/R and A/P "unattributed residual" notes
  equal to the previous snapshot).

### Document reads — kept visible, deliberately

The snapshot is a document, and document-scoped code treats it as one:

- Journal list and detail, including `source_type = 'opening'` filters.
- Whole-ledger integrity totals and the activity window
  (`integrity.entryCount` / `activity.entryCount` include the snapshot).
- Voucher numbering — the snapshot consumes the next `OP-<year>-000001`
  number through the ordinary per-entry counter.
- Bank-reconciliation candidates, statement-match preview, cleared-line
  validation (the completion proof is opening + cleared; candidates enumerate
  documents to tick).
- Closing-entry lookups (`source_type = 'closing'`), reversal machinery, and
  posting-side guards (fiscal lock, approval reconciliation) — a reversal of a
  snapshot shares its `source_id`, so both halves are excluded from balance
  reads together (net-zero either way, and a reversal restores every figure a
  buggy reader would have doubled).

## Reversal and retry semantics

A carry-forward can be reversed like any entry (`reverseJournalEntry`): the
original and its reversal both match the predicate and both vanish from
balance reads, leaving history untouched — figures identical to the
never-reversed state. A new carry-forward can then be generated and posted
after the periods are re-opened. Posting retries remain idempotent through the
existing `opening_set_already_posted` path; nothing about posting changed.

## RLS posture

- The function is `SECURITY INVOKER`: inside a tenant-scoped request the
  `opening_balance_sets` policy (`app_rls_bypass() OR business_id =
  app_current_business()`) applies to the caller, exactly like every direct
  query. Tests run as the `pos` superuser (bypass). If a session reached the
  predicate **without** any tenant scope, the set row would be invisible and
  the predicate would fail *open* — the pre-fix behaviour, counted, never
  silently dropped history. The application never runs reports outside
  tenant scope (every request sets it).
- `v_ledger_by_account` keeps `security_invoker = on` (re-asserted in 0297 —
  `migration-view-security.test.ts` and `tenant-isolation.integration.test.ts`
  pin this), so the view follows the caller's rights like every reporting
  view.

## Read-only detection (informational)

This model needs **no repair** — no tenant's data is wrong once the predicate
is deployed, because nothing was ever rewritten and the exclusion is
retroactive. The query below is the detection report the issue asked for:
which businesses carry posted carry-forward snapshots and how large they are.
It is read-only.

```sql
-- Snapshots in place, per tenant (read-only).
SELECT s.business_id,
       b.name                              AS business_name,
       fy.label                            AS carry_forward_from_year,
       s.id                                AS set_id,
       s.status,
       je.voucher_number,
       je.entry_date,
       (SELECT count(*) FROM journal_lines jl WHERE jl.entry_id = je.id)  AS line_count,
       (SELECT COALESCE(sum(jl.debit), 0) FROM journal_lines jl WHERE jl.entry_id = je.id) AS gross_debit
  FROM opening_balance_sets s
  JOIN businesses b   ON b.id = s.business_id
  LEFT JOIN fiscal_years fy ON fy.id = s.carry_forward_from_year_id
  LEFT JOIN journal_entries je ON je.id = s.journal_entry_id
 WHERE s.source = 'carry_forward'
   AND s.status = 'posted'
 ORDER BY b.name, je.entry_date;

-- Per-account cross-check for one tenant: raw journal net vs the net the
-- reporting view serves. The difference is exactly the snapshot — anything
-- else would mean a reader that still counts it twice.
SELECT a.code, a.name,
       sum(jl.debit - jl.credit)                                              AS raw_net,
       sum(jl.debit - jl.credit)
         FILTER (WHERE NOT is_carry_forward_snapshot(je))                     AS reported_net,
       sum(jl.debit - jl.credit)
         FILTER (WHERE is_carry_forward_snapshot(je))                         AS snapshot_net
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  JOIN accounts a         ON a.id = jl.account_id
 WHERE je.business_id = $1
 GROUP BY a.code, a.name
HAVING sum(jl.debit - jl.credit) FILTER (WHERE is_carry_forward_snapshot(je)) <> 0
 ORDER BY a.code;
```

## What proves it

`integration/carry-forward-ledger.integration.test.ts` — five scenarios run
against real PostgreSQL:

1. **Count-once across every new-year read** — trial balance (opening/period/
   closing + integrity/activity), as-of, statement, drill-down, balance sheet
   (business + branch scope), cash flow (incl. classification), KPI overview,
   dimension matrix, financial-account balance, `v_ledger_by_account`, export
   filter; the raw snapshot rows still exist in `journal_lines`.
2. **Prior-year as-of stays untouched** once the next year's opening is
   posted.
3. **No compounding at the 1405 → 1406 transition** — proposal balances equal
   the known 1405 figures, no unattributed residual notes, exact line amounts.
4. **Only the carry-forward is excluded** — a manual initial opening and the
   wizard's opening entry remain counted (the blanket-filter regression).
5. **Document semantics** — the snapshot stays listed and numbered in the
   journal (`OP-1405-000001`), balances exclude it, and it reverses cleanly.

Pre-fix the suite failed 4/5 with the doubled figures this issue reports
(`periodDebit 100000000` where `0` belongs, `12100000` vs `100000`, A/P+A/R
residual notes); post-fix it is green.
