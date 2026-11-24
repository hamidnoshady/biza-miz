-- Preserve kitchen items already removed by the retired timer.
UPDATE order_items
   SET kitchen_archived_at = kitchen_clear_at, kitchen_archive_reason = 'timer'
 WHERE kitchen_archived_at IS NULL AND kitchen_clear_at <= now();
