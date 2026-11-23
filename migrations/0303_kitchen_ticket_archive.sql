ALTER TABLE order_items
  ADD COLUMN kitchen_archived_at timestamptz,
  ADD COLUMN kitchen_archived_by uuid,
  ADD COLUMN kitchen_archive_reason text;

CREATE INDEX idx_order_items_kitchen_archive
  ON order_items (location_id, kitchen_archived_at DESC)
  WHERE kitchen_archived_at IS NOT NULL;
