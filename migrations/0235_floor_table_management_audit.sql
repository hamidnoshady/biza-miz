-- Issue #916: Floor & Table Management (میزها) audit — table notes and full
-- master-data sync coverage for floor_sections and dining_tables (including
-- section_id, status, geometry, and note).

ALTER TABLE dining_tables
  ADD COLUMN IF NOT EXISTS note text;

ALTER TABLE dining_tables
  DROP CONSTRAINT IF EXISTS dining_tables_shape_check;

ALTER TABLE dining_tables
  ADD CONSTRAINT dining_tables_shape_check
  CHECK (shape IN ('rect', 'round', 'square', 'booth'));

-- Attach master-sync change capture to floor_sections and include all mutable
-- columns on dining_tables (status, section_id, geometry, note).
DROP TRIGGER IF EXISTS trg_sync_capture ON floor_sections;
CREATE TRIGGER trg_sync_capture
  AFTER INSERT OR UPDATE OR DELETE ON floor_sections
  FOR EACH ROW
  EXECUTE FUNCTION app_sync_capture_row('id', 'location', '');

DROP TRIGGER IF EXISTS trg_sync_capture ON dining_tables;
CREATE TRIGGER trg_sync_capture
  AFTER INSERT OR UPDATE OR DELETE ON dining_tables
  FOR EACH ROW
  EXECUTE FUNCTION app_sync_capture_row('id', 'location', '');

-- Seed baseline row clocks for existing floor_sections and dining_tables rows.
SELECT set_config('app.rls_bypass', 'on', true);

-- Backfill legacy dining_tables.status = 'reserved' rows to 'seated' when
-- attached to an open table_session or 'free' otherwise (reservation visibility
-- is derived from the reservations table rather than manual table status).
UPDATE dining_tables dt
   SET status = CASE
     WHEN EXISTS (
       SELECT 1
         FROM table_session_tables tst
         JOIN table_sessions ts ON ts.id = tst.session_id
        WHERE tst.table_id = dt.id
          AND tst.released_at IS NULL
          AND ts.status = 'open'
     ) THEN 'seated'::table_status
     ELSE 'free'::table_status
   END
 WHERE dt.status = 'reserved';

INSERT INTO sync_row_clocks (business_id, table_name, row_id, location_id, row_hlc)
SELECT l.business_id, 'floor_sections', fs.id::text, fs.location_id,
       '000000000000000.000000000000000.'
  FROM floor_sections fs
  JOIN locations l ON l.id = fs.location_id
UNION ALL
SELECT l.business_id, 'dining_tables', dt.id::text, dt.location_id,
       '000000000000000.000000000000000.'
  FROM dining_tables dt
  JOIN locations l ON l.id = dt.location_id
ON CONFLICT (business_id, table_name, row_id) DO NOTHING;

SELECT set_config('app.rls_bypass', '', true);
