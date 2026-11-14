-- 0297 — fiscal-year carry-forward is a snapshot, not ledger history (GH #1334 / ESH-165).
--
-- A carry-forward set posts through the ordinary journal path
-- (`source_type = 'opening'`, dated at the new year's first day), so every
-- balance read that sums journal lines used to count the carried balances
-- twice: once from the prior year's real history, once from the snapshot —
-- a known 100,000,000 Rial cash balance reported as 200,000,000 the moment a
-- year turned, a phantom financing inflow in the cash-flow statement, an
-- unattributed A/R residual equal to the snapshot, and a compounding
-- carry-forward at the *next* transition.
--
-- The ledger model is continuous (docs/architecture/ledger-model.md): history
-- is never rewritten, and the snapshot is excluded from balance reads by this
-- one predicate. The discriminator is the *set's own* `source` column, so a
-- manual initial-opening set (`source = 'manual'`) and the setup wizard's
-- opening entry (`source_id` naming no set) stay counted — a blanket
-- `source_type = 'opening'` filter would erase real history.
--
-- Retroactive: already-posted snapshots are recognised without touching a
-- single journal row, so no tenant data migration and no production repair
-- are needed. Document-scoped reads (journal list/detail, integrity totals,
-- voucher numbering, bank-reconciliation candidates) intentionally keep the
-- snapshot visible; only balance reads call this function.

CREATE OR REPLACE FUNCTION is_carry_forward_snapshot(entry journal_entries) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT CASE
           -- Cheap-first: ordinary rows never probe opening_balance_sets.
           WHEN entry.source_type = 'opening' THEN EXISTS (
             SELECT 1
               FROM opening_balance_sets s
              WHERE s.id = entry.source_id
                AND s.source = 'carry_forward'
           )
           ELSE false
         END
$$;

COMMENT ON FUNCTION is_carry_forward_snapshot(journal_entries) IS
  'TRUE when the entry is a fiscal-year carry-forward snapshot (an opening posting whose source set is source=carry_forward). Balance reads exclude these; document reads keep them. NULL-safe: a NULL entry is not a snapshot.';

-- The reporting view every standard report and export reads
-- (v_ledger_by_account, migration 0008) gains the same exclusion at the
-- source, so P&L, balance sheet, business overview, rollups and the export
-- route cannot disagree with the services that read journal lines directly.
-- Column list is unchanged (0008's nine columns), so CREATE OR REPLACE keeps
-- every grant and dependent object intact.
CREATE OR REPLACE VIEW v_ledger_by_account AS
SELECT
    je.business_id,
    je.location_id,
    je.entry_date,
    a.id   AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.type AS account_type,
    jl.debit,
    jl.credit
FROM journal_lines jl
JOIN journal_entries je
  ON je.id = jl.entry_id
 AND NOT is_carry_forward_snapshot(je)
JOIN accounts a ON a.id = jl.account_id;

-- CREATE OR REPLACE VIEW can reset pg_class.reloptions to NULL (that is
-- exactly the 0144 bug 0146 repaired): without security_invoker the view runs
-- with its OWNER's rights, bypassing every row-level tenant policy. Re-assert
-- the invoker posture at the point the definition is re-created —
-- migration-view-security.test.ts insists on it for every post-sweep
-- migration, and tenant-isolation.integration.test.ts asserts every
-- reporting view runs with the caller's rights.
ALTER VIEW v_ledger_by_account SET (security_invoker = on);
