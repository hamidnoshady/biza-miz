-- Issue #868 Phase 6 — hybrid sync for accounting-dimension master data.
--
-- The dimension tables (0222) are master data in the migration-0190 sense:
-- mutable, low-volume, owned by no single side's operations. The dimension
-- workspace is authored in the accounting screens (cloud), and a hybrid site
-- needs the values to *name* the attribution its pulled documents carry and
-- to resolve the posting-mapping rules without a round trip. They join the
-- same per-field hybrid-logical-clock feed as customers and the menu.
--
-- The one canonical owner is the cloud (data-ownership.ts,
-- `accounting_dimension_master`): the feed replicates rows down with their
-- UUIDs unchanged — a site's journal_lines.dimension columns and
-- opening_balance_lines reference exactly the values the cloud posted, and a
-- pulled entry can never resolve against a different, site-local copy.
--
-- What deliberately does NOT sync: payroll_run_allocations (a posted run's
-- immutable snapshot — cloud-owned like payroll itself) and the four
-- employees default-dimension columns (they ride the existing users
-- bootstrap; ongoing team edits are cloud-managed, see `users_permissions`).
-- journal_lines.dimension columns travel inside the ledger, which is
-- cloud-owned since Phase 45.
--
-- The trigger arguments below and MASTER_SYNC_TABLES in
-- src/lib/master-sync-registry.ts are one contract, compared verbatim by
-- master-sync-registry.test.ts. Settings before values before mappings.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('accounting_dimension_settings', 'business_id,kind', 'business', 'updated_at'),
      ('accounting_dimension_values',   'id',               'business', 'updated_at'),
      ('accounting_dimension_mappings', 'id',               'business', 'updated_at')
    ) AS v(table_name, pk, scope, excluded)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_sync_capture ON %I', t.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_sync_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_sync_capture_row(%L, %L, %L)',
      t.table_name, t.pk, t.scope, t.excluded);
  END LOOP;
END $$;

-- Backfill at the zero clock, as 0190 and 0206 did: a desktop paired from now
-- on receives the business's existing dimension values through the feed,
-- while two sides that already hold the same row compare equal and change
-- nothing. Business-scope rows carry no branch (0190 writes NULL here).
SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO sync_row_clocks (business_id, table_name, row_id, location_id, row_hlc)
SELECT business_id, 'accounting_dimension_settings', business_id || '|' || kind, NULL::uuid,
       '000000000000000.000000000000000.'
  FROM accounting_dimension_settings
UNION ALL
SELECT business_id, 'accounting_dimension_values', id::text, NULL::uuid,
       '000000000000000.000000000000000.'
  FROM accounting_dimension_values
UNION ALL
SELECT business_id, 'accounting_dimension_mappings', id::text, NULL::uuid,
       '000000000000000.000000000000000.'
  FROM accounting_dimension_mappings
ON CONFLICT (business_id, table_name, row_id) DO NOTHING;

SELECT set_config('app.rls_bypass', '', true);
