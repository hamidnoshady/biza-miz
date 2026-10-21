-- Issue #925 — product attribute definitions and variant snapshots are part
-- of the retail catalogue's hybrid master feed. Their values are independent
-- data, not derived stock, so the existing per-field HLC merge is appropriate.
-- Definition deletion nulls only the optional relationship; the historical
-- name/value snapshot itself remains in place.

ALTER TABLE item_attribute_definitions
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE item_variant_attributes
  ADD COLUMN IF NOT EXISTS attribute_definition_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'item_variant_attributes_definition_id_fkey'
       AND conrelid = 'item_variant_attributes'::regclass
  ) THEN
    ALTER TABLE item_variant_attributes
      ADD CONSTRAINT item_variant_attributes_definition_id_fkey
      FOREIGN KEY (attribute_definition_id)
      REFERENCES item_attribute_definitions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_item_variant_attributes_definition
  ON item_variant_attributes (attribute_definition_id)
  WHERE attribute_definition_id IS NOT NULL;

-- Link snapshots that can be matched unambiguously without changing their
-- original labels or values. Old/renamed snapshots with no safe match remain
-- nullable and continue to render exactly as stored.
WITH unambiguous_matches AS (
  SELECT a.id AS attribute_id,
         min(d.id::text)::uuid AS definition_id
    FROM item_variant_attributes a
    JOIN items i ON i.id = a.item_id
    JOIN item_attribute_definitions d
      ON d.location_id = i.location_id
     AND d.name = a.name
   WHERE a.attribute_definition_id IS NULL
   GROUP BY a.id
  HAVING count(DISTINCT d.id) = 1
)
UPDATE item_variant_attributes a
   SET attribute_definition_id = m.definition_id
  FROM unambiguous_matches m
 WHERE a.id = m.attribute_id
   AND a.attribute_definition_id IS NULL;

-- The definition edit counter travels with the edited master fields so an
-- editor opened on a paired device before a remote save will receive a version
-- conflict instead of overwriting newer work. updated_at remains receiver-local.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('item_attribute_definitions', 'id', 'location',             'updated_at'),
      ('item_variant_attributes',   'id', 'parent:items:item_id', '')
    ) AS v(table_name, pk, scope, excluded)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_sync_capture ON %I', t.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_sync_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_sync_capture_row(%L, %L, %L)',
      t.table_name, t.pk, t.scope, t.excluded);
  END LOOP;
END $$;

-- Zero-clock backfill makes existing definitions and snapshots visible to
-- already-paired sites and newly paired devices from the same commit-safe
-- cursor. It does not copy or derive stock, serialized units, or sales.
SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO sync_row_clocks (business_id, table_name, row_id, location_id, row_hlc)
SELECT l.business_id, 'item_attribute_definitions', d.id::text, d.location_id,
       '000000000000000.000000000000000.'
  FROM item_attribute_definitions d
  JOIN locations l ON l.id = d.location_id
UNION ALL
SELECT l.business_id, 'item_variant_attributes', a.id::text, i.location_id,
       '000000000000000.000000000000000.'
  FROM item_variant_attributes a
  JOIN items i ON i.id = a.item_id
  JOIN locations l ON l.id = i.location_id
ON CONFLICT (business_id, table_name, row_id) DO NOTHING;

SELECT set_config('app.rls_bypass', '', true);
