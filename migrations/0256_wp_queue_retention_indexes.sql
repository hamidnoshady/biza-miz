-- ============================================================================
-- 0256_wp_queue_retention_indexes.sql — issue #1077: WP/Woo queue retention.
--
-- The daily retention sweep (src/lib/integrations/queue-retention.ts) deletes
-- finished queue rows older than a fixed age. It reads by (status, age) across
-- every connection of a business, which none of the existing queue indexes
-- serve (they all lead with connection_id). These two partial indexes cover
-- exactly the terminal statuses the sweep may touch, so the scan never reads
-- a `pending` / `processing` / `needs_review` row and stays cheap on a table
-- that is mostly live work.
--
-- No new tables and no new columns, so no RLS change: both tables keep the
-- tenant policies they already have.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_integration_outbox_retention
    ON integration_outbox_events (updated_at)
    WHERE status IN ('sent', 'skipped', 'dead');

CREATE INDEX IF NOT EXISTS idx_integration_webhook_retention
    ON integration_webhook_events ((COALESCE(processed_at, created_at)))
    WHERE status IN ('processed', 'duplicate', 'failed');
