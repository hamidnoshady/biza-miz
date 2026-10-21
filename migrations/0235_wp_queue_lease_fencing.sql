-- ============================================================================
-- 0235_wp_queue_lease_fencing.sql — issue #942: WP/Woo queue correctness.
--
-- The outbox lease had a clock but no fence. `pluginPullJobs()` marked a row
-- `processing` with `leased_until`, but `pluginAckJobs()` updated by
-- `id + connection_id` alone — a worker whose lease had expired (and whose job
-- had been re-leased, possibly with a newer payload) could still ack the newer
-- attempt `sent` or `failed`. The REST drainer had the mirror-image problem:
-- it SELECTed due rows and then unconditionally flipped them to `processing`,
-- so a periodic tick and a manual flush could both execute the same job.
--
-- This migration gives every lease a generation:
--
--   * `lease_token` — a fresh uuid written atomically with every claim (the
--     plugin pull and the REST drain both claim with UPDATE ... FOR UPDATE
--     SKIP LOCKED ... RETURNING). Every state transition out of `processing`
--     is conditional on the token, so a stale holder's ack/write matches no
--     rows and changes nothing. Nullable: rows leased by a plugin that
--     predates lease tokens carry NULL and fall back to the status guard.
--
--   * `'skipped'` joins the outbox status set. When the WordPress plugin's
--     local policy switch (`apply_stock` / `apply_prices`) is off, the job
--     used to be acked `done` although nothing was written to WooCommerce —
--     and the platform then believed the remote value was current. A skip is
--     now its own terminal state: visible, never counted as delivered, and
--     never allowed to update the mapping's last-pushed value.
--
-- Plus the queue screen's listing indexes. The combined inbox/outbox list
-- filters by (connection, status) and sorts by created_at; the old indexes
-- covered the filter or the sort, never both, and the list SELECTed the full
-- payload jsonb for every row (the service no longer does that — diagnostics
-- are fetched per row, redacted).
--
-- No new tables, so no new RLS policies: `integration_outbox_events` and
-- `integration_webhook_events` keep the tenant scoping they already have, and
-- a column/index cannot widen a row's visibility.
-- ============================================================================

ALTER TABLE integration_outbox_events
    ADD COLUMN IF NOT EXISTS lease_token uuid;

ALTER TABLE integration_outbox_events
    DROP CONSTRAINT IF EXISTS integration_outbox_events_status_check;
ALTER TABLE integration_outbox_events
    ADD CONSTRAINT integration_outbox_events_status_check
        CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead', 'needs_review', 'skipped'));

-- The queue listing: one connection, one status bucket, newest first.
CREATE INDEX IF NOT EXISTS idx_integration_outbox_queue_list
    ON integration_outbox_events (connection_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_integration_webhook_queue_list
    ON integration_webhook_events (connection_id, status, created_at DESC, id DESC);

-- The atomic claim: due work for one connection in next-attempt order,
-- including `processing` rows whose lease expired (a crashed worker's rows
-- must come back instead of sitting `processing` forever).
CREATE INDEX IF NOT EXISTS idx_integration_outbox_claim
    ON integration_outbox_events (connection_id, next_attempt_at, created_at)
    WHERE status IN ('pending', 'failed', 'processing');
