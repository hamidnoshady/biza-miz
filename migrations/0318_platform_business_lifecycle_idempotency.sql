-- ============================================================================
-- 0318_platform_business_lifecycle_idempotency.sql — issue #1431.
--
-- The Superadmin MCP archive/restore tools make the audit trail their durable
-- idempotency ledger: a retry with the same actor + key reads the original
-- successful `business.archived` / `business.active` row and replays it instead
-- of mutating the tenant a second time. Those lifecycle rows are written with
-- `payload.idempotencyKey` and `payload.outcome = 'succeeded'`.
--
-- `platform_audit_log` grows with every privileged console/MCP action, so the
-- retry lookup must not scan it in full. This partial expression index covers
-- exactly the two lifecycle actions and only rows that carry a key. It is
-- additive; existing rows and every other audit query are untouched.
--
-- The status UPDATE itself is still the console's conditional
-- `setBusinessStatus(..., { expectFrom })`, so this index protects retries,
-- not the concurrency boundary (that is the `WHERE status = $from` CAS).
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_platform_audit_log_lifecycle_idempotency
    ON platform_audit_log (platform_admin_id, (payload->>'idempotencyKey'))
    WHERE action IN ('business.archived', 'business.active')
      AND payload ? 'idempotencyKey';
