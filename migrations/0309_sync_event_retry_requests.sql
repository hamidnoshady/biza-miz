-- 0309_sync_event_retry_requests.sql
--
-- Issue #1446: a central event whose application failed cached its error on
-- `sync_events` and was never re-applied, even after the missing master data
-- (a duplicate employee party) had been reconciled. There was no safe way for
-- an operator to ask for exactly that one event to be attempted again.
--
-- `retry_requested_at` is that ask. It is set only by the authenticated,
-- location-scoped retry endpoint (`POST /api/server-sync/retry-events`) and
-- only on rows that never applied (`applied_at IS NULL`). The apply path
-- claims the request atomically and then re-runs the event once; a successful
-- effect is still exactly-once, and an event that already applied can never be
-- selected, so a retry cannot duplicate a financial or operational effect.
--
-- Additive and safe for deployed desktop (embedded PostgreSQL) and central
-- databases: no existing row changes meaning, and dropping the column is the
-- rollback.

ALTER TABLE sync_events
  ADD COLUMN IF NOT EXISTS retry_requested_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sync_events_retry_requested
  ON sync_events (location_id, client_event_id)
  WHERE retry_requested_at IS NOT NULL AND applied_at IS NULL;
