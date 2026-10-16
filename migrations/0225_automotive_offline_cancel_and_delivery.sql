-- ============================================================================
-- 0225_automotive_offline_cancel_and_delivery.sql — issue #839 §19, two defects
-- the storage has to answer for before the code can.
--
-- ## 1. Withdrawing a queued vehicle request
--
-- Cancelling a queued request used to flip the request row and nothing else. The
-- `sync_events` row that carries the command was untouched, so the very next
-- push delivered a hold the operator had already withdrawn — and the board, which
-- had adopted `cancelled`, then *refused* the cloud's answer for it
-- (`planRequestStatusApply` is monotonic). The desk said «لغوشده» while the
-- cloud held the car and posted the deposit. Two facts are needed to decide
-- honestly, and neither existed:
--
--   * `dispatch_attempted_at` — monotonic: stamped the moment a delivery attempt
--     leaves this machine and never cleared. Before it is set the site can
--     *prove* the cloud has not seen the command, so a cancellation can retract
--     the event and be truthful with no round trip. After it is set nothing local
--     can prove anything, so cancellation becomes a command of its own
--     (`automotive.vehicle.reservation.withdrawn`) which the cloud honours — by
--     cancelling an unapplied request, or, when it had already applied it, by
--     releasing the hold through the canonical reservation service, with the
--     reasons, refund rules and audit trail that service already owns.
--   * `retracted_at` — the provable other half. An event that was never attempted
--     is withdrawn locally, in the same transaction as the request row, and the
--     record of what was queued and withdrawn survives (deleting the row would
--     lose the audit trail this module exists to keep).
--
-- The CHECK below is the invariant in one line: a retracted event is one no
-- delivery attempt was ever made for. A row cannot be both withdrawn locally and
-- in flight, because a row that was in flight might already be in the cloud.
--
-- ## 2. Delivering every answer, not the newest 200
--
-- The projection carried `ORDER BY requested_at DESC LIMIT 200`. A request that
-- fell out of that window while still unresolved never had its answer delivered,
-- so the site kept it `pending` forever and the operator never learned what the
-- cloud decided. The fix is a cursor over `resolved_at` (see
-- `automotive-stock-service.ts`): every unresolved request travels every time,
-- and resolved answers travel once, after a cursor the site keeps in its own
-- sync state. That needs no new column — only the index below, so "answers
-- resolved after my cursor" is an index range rather than a scan of the branch's
-- whole request history.
--
-- ## 3. Repairing the rows the old code left behind
--
-- Rows cancelled by the old code fall into exactly two classes, told apart by the
-- event that carried them:
--
--   * the event was never delivered (no attempt) — the cancellation was correct,
--     it was simply never recorded as such. The event is marked retracted, which
--     makes the cancellation provable and stops it from ever being pushed;
--   * the event was delivered or attempted — the cloud may hold the car, so the
--     row cannot claim to be cancelled. It becomes `cancelling`, which is the
--     honest state: the board shows «در حال لغو» and offers the withdrawal again,
--     and the ordinary idempotent cancel endpoint queues it.
--
-- Forward-only and additive: a tenant that never uses the offline queue sees two
-- nullable columns it never reads.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. What the site knows about its own delivery attempts
-- ---------------------------------------------------------------------------
ALTER TABLE sync_events
    ADD COLUMN IF NOT EXISTS dispatch_attempted_at timestamptz,
    ADD COLUMN IF NOT EXISTS retracted_at timestamptz,
    ADD COLUMN IF NOT EXISTS retracted_reason text;

-- The invariant, enforced rather than assumed: withdrawing locally is only
-- possible for an event no delivery attempt was ever made for, so nothing the
-- cloud might already hold can be retracted behind its back.
ALTER TABLE sync_events
    ADD CONSTRAINT sync_events_retraction_shape
        CHECK (retracted_at IS NULL OR (pushed_at IS NULL AND dispatch_attempted_at IS NULL));

-- 0189's index is the push selector's own predicate. A retracted row is not
-- deliverable, so the predicate gains that term rather than a second, nearly
-- identical index over the same rows: the push query and its index stay one
-- sentence. (The cancel transaction's lookup of an event by
-- `(location_id, client_event_id)` is already served by 0001's unique index.)
DROP INDEX IF EXISTS idx_sync_events_push_pending;
CREATE INDEX IF NOT EXISTS idx_sync_events_push_pending
    ON sync_events (location_id, id)
    WHERE pushed_at IS NULL AND origin = 'local' AND applied_at IS NOT NULL AND error IS NULL
      AND retracted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The delivery cursor
-- ---------------------------------------------------------------------------
-- Keyset pagination over `(resolved_at, id)`: the page is an index range, and the
-- order is total (a tie on `resolved_at` is broken by the id), so no answer can
-- be skipped or delivered twice by a cursor boundary.
CREATE INDEX IF NOT EXISTS idx_automotive_offline_request_delivery
    ON automotive_vehicle_offline_requests (business_id, location_id, resolved_at, id);

-- ---------------------------------------------------------------------------
-- 3. The legacy rows
-- ---------------------------------------------------------------------------
-- The status vocabulary gains `cancelling` for a withdrawal the cloud has not
-- answered yet; that is the one new value, and this is where the old rows that
-- actually meant it are moved to it.
ALTER TABLE automotive_vehicle_offline_requests
    DROP CONSTRAINT automotive_vehicle_offline_requests_status_check;

ALTER TABLE automotive_vehicle_offline_requests
    ADD CONSTRAINT automotive_vehicle_offline_requests_status_check
        CHECK (status IN ('pending', 'cancelling', 'confirmed', 'conflict', 'cancelled'));

-- A cancellation the old code performed on an event that had already left this
-- machine is not a cancellation the site can stand behind: the cloud may have
-- applied it. Those rows become `cancelling` and the board offers the withdrawal.
--
-- `origin = 'local'` is load-bearing: on the *cloud* database the same
-- `client_event_id` belongs to the incoming remote event, and a cloud row in
-- `cancelled` (a withdrawal it applied) is a decided row, not a stale one.
UPDATE automotive_vehicle_offline_requests r
   SET status = 'cancelling',
       updated_at = now()
 WHERE r.status = 'cancelled'
   AND EXISTS (
     SELECT 1 FROM sync_events se
      WHERE se.location_id = r.location_id
        AND se.client_event_id = r.id
        AND se.origin = 'local'
        AND se.retracted_at IS NULL
   );

-- …and the mirror of it: a cancellation whose event never left can be made
-- provable, so the row keeps `cancelled` and the event is retracted.
--
-- The reason text is what the panel's audit view shows, and it says which of the
-- two ways the row got there.
UPDATE sync_events se
   SET retracted_at = now(),
       retracted_reason = 'offline_request_cancelled_before_dispatch'
 WHERE se.origin = 'local'
   AND se.pushed_at IS NULL
   AND se.dispatch_attempted_at IS NULL
   AND se.retracted_at IS NULL
   AND se.event_type IN ('automotive.vehicle.reservation.requested', 'automotive.vehicle.reservation.released')
   AND EXISTS (
     SELECT 1 FROM automotive_vehicle_offline_requests r
      WHERE r.location_id = se.location_id
        AND r.id = se.client_event_id
        AND r.status = 'cancelled'
   );
