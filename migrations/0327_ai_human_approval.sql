-- GH #1567 F7 — mandatory human approval for AI-initiated financial and stock
-- writes (every business type).
--
-- The approval is bound to the proposal row it was given on:
--   * payload    — proposal_payload_hash is stamped at proposal time; the
--                  approver's presented hash, the stored payload and the
--                  payload the executor runs must all hash to it;
--   * actor      — approved_by is the human whose authority the executor runs
--                  under, and must equal it;
--   * tenant     — every read and write is keyed by business_id (FORCE RLS on
--                  ai_action_audit already);
--   * expiry     — approval_expires_at bounds how long a proposal can wait;
--                  an approval must be spent within minutes of being given;
--   * replay     — approval_consumed_at is set by one CAS at the executor
--                  boundary; a second execution finds it spent.
-- Columns only: existing rows keep NULLs and are treated as "no approval
-- recorded", which the executor guard refuses for gated actions.

ALTER TABLE ai_action_audit
    ADD COLUMN IF NOT EXISTS approval_class        text,
    ADD COLUMN IF NOT EXISTS proposal_payload_hash text,
    ADD COLUMN IF NOT EXISTS approval_expires_at   timestamptz,
    ADD COLUMN IF NOT EXISTS approved_by           text,
    ADD COLUMN IF NOT EXISTS approved_at           timestamptz,
    ADD COLUMN IF NOT EXISTS approved_payload_hash text,
    ADD COLUMN IF NOT EXISTS approval_consumed_at  timestamptz;

ALTER TABLE ai_action_audit DROP CONSTRAINT IF EXISTS ai_action_audit_approval_class_check;
ALTER TABLE ai_action_audit
    ADD CONSTRAINT ai_action_audit_approval_class_check
    CHECK (approval_class IS NULL OR approval_class IN ('sale', 'refund', 'payment', 'posting', 'stock', 'purchase'));

-- A consumed approval always names who gave it and over which payload.
ALTER TABLE ai_action_audit DROP CONSTRAINT IF EXISTS ai_action_audit_approval_consumed_check;
ALTER TABLE ai_action_audit
    ADD CONSTRAINT ai_action_audit_approval_consumed_check
    CHECK (approval_consumed_at IS NULL OR (approved_by IS NOT NULL AND approved_payload_hash IS NOT NULL AND approved_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_ai_action_audit_pending_approval
    ON ai_action_audit (business_id, approval_expires_at)
    WHERE status = 'proposed' AND approval_class IS NOT NULL;
