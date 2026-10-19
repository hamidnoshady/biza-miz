-- Issue #916: Floor & Table Management (میزها) audit — table notes and full
-- master-data sync coverage for floor_sections and dining_tables (including
-- section_id, status, geometry, and note).

ALTER TABLE dining_tables
  ADD COLUMN IF NOT EXISTS note text;

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
