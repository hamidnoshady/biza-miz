-- Issue #795 Phase 7 — hybrid sync for the serialized-retail catalogue.
--
-- A paired desktop at a watch branch needs the catalogue to work offline:
-- the models (items), their brands, and their structured attributes
-- (migration 0205). These are master data in exactly the migration-0190
-- sense — mutable, low-volume, owned by no single side — so they join the
-- same per-field hybrid-logical-clock feed as customers and the menu.
--
-- What deliberately does NOT sync: item_serials and everything downstream
-- of it (sales, warranties, repairs, reservations, returns). Serialized
-- stock is CLOUD-OWNED, like all stock and ledger state since Phase 45 —
-- there is exactly one authority that can move a serial from in_stock to
-- sold, which is what enforces the invariant that one physical watch can
-- never be sold twice across devices. A desktop reads the board from the
-- cloud; it does not replay serial movements. (Field-merging a serial's
-- status would silently reconcile two concurrent sales instead of refusing
-- one — the one conflict this domain must never "resolve".)
--
-- The trigger arguments below and MASTER_SYNC_TABLES in
-- src/lib/master-sync-registry.ts are one contract, compared verbatim by
-- master-sync-registry.test.ts.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('item_brands',           'id',      'location',               ''),
      ('items',                 'id',      'location',               'updated_at'),
      ('watch_item_attributes', 'item_id', 'parent:items:item_id',   'updated_at')
    ) AS v(table_name, pk, scope, excluded)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_sync_capture ON %I', t.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_sync_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_sync_capture_row(%L, %L, %L)',
      t.table_name, t.pk, t.scope, t.excluded);
  END LOOP;
END $$;

-- Backfill at the zero clock, as 0190 did: a desktop paired from now on
-- receives the branch's existing catalogue through the feed, while two sides
-- that already hold the same row compare equal and change nothing.
SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO sync_row_clocks (business_id, table_name, row_id, location_id, row_hlc)
SELECT l.business_id, 'item_brands', t.id::text, t.location_id, '000000000000000.000000000000000.'
  FROM item_brands t JOIN locations l ON l.id = t.location_id
UNION ALL
SELECT l.business_id, 'items', t.id::text, t.location_id, '000000000000000.000000000000000.'
  FROM items t JOIN locations l ON l.id = t.location_id
UNION ALL
SELECT l.business_id, 'watch_item_attributes', t.item_id::text, p.location_id, '000000000000000.000000000000000.'
  FROM watch_item_attributes t JOIN items p ON p.id = t.item_id JOIN locations l ON l.id = p.location_id
ON CONFLICT (business_id, table_name, row_id) DO NOTHING;

SELECT set_config('app.rls_bypass', '', true);
