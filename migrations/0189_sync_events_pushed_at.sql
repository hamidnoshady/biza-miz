-- 0189_sync_events_pushed_at.sql
-- Site → cloud push tracks delivery per row instead of by one high-water mark.
--
-- The push used to select `id > lastPushedEventId AND applied_at IS NOT NULL`
-- and then move the mark to the batch's last id. Two kinds of row fell behind
-- that mark and were never pushed:
--   * a row whose transaction committed after a higher id had already been
--     pushed (identity ids are allocated at INSERT, not at COMMIT), and
--   * a locally deferred row that was applied by reconciliation after later
--     rows had gone out.
-- `pushed_at` records that the cloud durably accepted this exact row; the push
-- selects `pushed_at IS NULL`, so no row can be passed over.

ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS pushed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sync_events_push_pending
  ON sync_events (location_id, id)
  WHERE pushed_at IS NULL AND origin = 'local' AND applied_at IS NOT NULL AND error IS NULL;

-- Backfill across every business (transaction-local bypass; the runner wraps
-- each file in its own transaction). Rows at or below the old mark that were
-- applied in the same moment they were received were sent by the old push.
-- Rows applied noticeably later (reconciled after a deferral) are left
-- unmarked so they go out now; re-sending one is harmless because the cloud
-- deduplicates on (location_id, client_event_id).
SELECT set_config('app.rls_bypass', 'on', true);

UPDATE sync_events se
   SET pushed_at = now()
  FROM locations l
  JOIN settings s
    ON s.business_id = l.business_id
   AND s.location_id IS NULL
   AND s.key = 'server_sync.state'
 WHERE se.location_id = l.id
   AND se.origin = 'local'
   AND se.pushed_at IS NULL
   AND (s.value->>'lastPushedEventId') ~ '^[0-9]+$'
   AND se.id <= (s.value->>'lastPushedEventId')::bigint
   AND se.applied_at IS NOT NULL
   AND se.applied_at <= se.received_at + interval '5 seconds';

SELECT set_config('app.rls_bypass', '', true);
