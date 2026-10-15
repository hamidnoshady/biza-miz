-- ============================================================================
-- 0223_automotive_offline_request_acknowledged.sql — issue #839 §19.
--
-- A refusal the cloud recorded (0222) is final, and the row that carries it must
-- stay: it is the audit trail of a request that was queued, sent and refused. So
-- the counter cannot *delete* a conflict — but the desk also cannot keep showing
-- a decided row as if it still needed a decision. This migration adds the one
-- column that separates the two: when an operator has read the refusal and acted
-- on it, the row is acknowledged, leaves the "needs a decision" count, and stays
-- in the history.
--
-- Why not reuse `status = 'cancelled'`: a cancelled request is one the cloud
-- never applied (it was withdrawn before the answer). Reusing that status would
-- make the record claim a request was withdrawn when in fact the cloud refused
-- it, and the two are different facts about the same car. Why not `resolved_at`:
-- that is when the *cloud* answered, not when a person dealt with it, and the
-- sync panel needs both.
--
-- Forward-only and additive; a tenant that never uses the offline queue sees one
-- nullable column it never reads.
-- ============================================================================

ALTER TABLE automotive_vehicle_offline_requests
    ADD COLUMN acknowledged_at timestamptz,
    ADD COLUMN acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- The panel's "needs a decision" list is (branch, unacknowledged conflict), so
-- give it an index rather than a filtered scan of every queued request.
CREATE INDEX idx_automotive_offline_request_open_conflicts
    ON automotive_vehicle_offline_requests (business_id, location_id)
    WHERE status = 'conflict' AND acknowledged_at IS NULL;

-- A pending request has nothing to acknowledge; a row cannot be acknowledged
-- before it was requested. Enforced here as well as in the service, because the
-- column is what the count above keys on.
ALTER TABLE automotive_vehicle_offline_requests
    ADD CONSTRAINT automotive_offline_request_acknowledged_shape
        CHECK (acknowledged_at IS NULL OR (status = 'conflict' AND acknowledged_at >= requested_at));
