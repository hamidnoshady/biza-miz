-- Issue #844 — Hybrid must sync the canonical menu photo.
--
-- Migration 0190 created menu_items' capture trigger with `image_media_id`
-- excluded (media assets were assumed deployment-local). The column is now
-- part of the merged row: media ids are business-scoped, and a missing asset
-- degrades to the placeholder rather than a broken row. 0190 already carries
-- the new argument for fresh installs; this migration catches databases where
-- 0190 ran with the old one — same idempotent drop/create 0190 itself uses,
-- for menu_items only.

DROP TRIGGER IF EXISTS trg_sync_capture ON menu_items;
CREATE TRIGGER trg_sync_capture
  AFTER INSERT OR UPDATE OR DELETE ON menu_items
  FOR EACH ROW
  EXECUTE FUNCTION app_sync_capture_row('id', 'location', 'updated_at');
