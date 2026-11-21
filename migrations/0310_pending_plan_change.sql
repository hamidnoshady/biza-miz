-- ============================================================================
-- 0310_pending_plan_change.sql — ESH-193 / #1378, deferred plan transitions.
--
-- A customer who buys a different plan while a paid period is still running
-- must not lose the time they already paid for, and must not be charged twice
-- for the same day. Under the neutral proration policy the change is therefore
-- *scheduled* for the paid-period boundary:
--
--   * the current plan keeps serving until `current_period_end`;
--   * the purchase is paid now and recorded as the pending plan;
--   * the renewal tick applies it at the boundary, without a second debit,
--     and opens the next paid period from that instant.
--
-- This is deliberately additive and inert: every column is nullable, and a
-- subscription with no pending row behaves exactly as before. Enrolment in a
-- paid policy is still separate (0309); this migration buys time, not policy.
--
-- Rollback: drop the four columns and the partial index. A pending change that
-- has not been applied is cancelled by doing so; an applied one is ordinary
-- history and is untouched.
-- ============================================================================

ALTER TABLE business_subscriptions
    ADD COLUMN IF NOT EXISTS pending_plan_key     text REFERENCES billing_plans(key),
    ADD COLUMN IF NOT EXISTS pending_term_months  integer,
    ADD COLUMN IF NOT EXISTS pending_effective_at timestamptz,
    ADD COLUMN IF NOT EXISTS pending_payment_id   uuid REFERENCES billing_payments(id) ON DELETE SET NULL;

-- All four move together; a half-written pending change is refused.
ALTER TABLE business_subscriptions
    DROP CONSTRAINT IF EXISTS business_subscriptions_pending_all_or_none;
ALTER TABLE business_subscriptions
    ADD CONSTRAINT business_subscriptions_pending_all_or_none CHECK (
        (pending_plan_key IS NULL AND pending_term_months IS NULL
         AND pending_effective_at IS NULL AND pending_payment_id IS NULL)
        OR (pending_plan_key IS NOT NULL AND pending_term_months IN (1, 3, 12)
            AND pending_effective_at IS NOT NULL)
    );

-- One due pending change per business is the renewal tick's lookup.
CREATE INDEX IF NOT EXISTS idx_business_subscriptions_pending_due
    ON business_subscriptions (pending_effective_at)
 WHERE pending_plan_key IS NOT NULL;

COMMENT ON COLUMN business_subscriptions.pending_plan_key IS
    'The plan a paid cross-plan purchase will move to at current_period_end (ESH-193). Applied by the renewal tick, never charged twice.';
