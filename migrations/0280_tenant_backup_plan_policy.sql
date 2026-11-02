-- ============================================================================
-- 0280_tenant_backup_plan_policy.sql — Issue #903 §3: the plan-shaped half of
-- the backup policy, and the two thresholds that make "protected" measurable.
--
-- `platform_tenant_backup_service` (0265) holds one fleet default; 0269 added a
-- per-business override. The epic asks for a third layer — **default and
-- per-plan automatic schedules, retention, capacity, alerts and disaster-recovery
-- thresholds** — because a plan is the unit the product is sold in: every
-- business on «حرفه‌ای» should back up every 6 hours, every business on the base
-- plan nightly, without an operator touching them one by one.
--
-- Two rules keep this from becoming a second, unbounded policy system:
--
--   * **NULL means inherit.** A missing column is not a zero: the resolver must
--     be able to tell "this plan chose 6 hours" from "nobody has said anything",
--     exactly as it does for the per-business override.
--   * **A plan may only tighten.** Cadence and capacity may be stricter than the
--     fleet's; retention may extend only up to the fleet's own ceiling; the
--     alert window may only shorten, the failure streak only get stricter, and
--     drills only get more frequent. A plan is a sales tier, not a way to sell
--     weaker protection, so the resolver clamps rather than trusting this table.
--
-- The same migration adds the four threshold columns to the fleet row, because
-- alerts and drills need a default before any plan exists:
--
--   alert_stale_hours       how long without a success counts as stale
--                           (NULL = derived from the cadence: interval + grace)
--   alert_failure_streak    consecutive failures before the Owner is told
--                           (1 = the pre-#903 behaviour, kept as the default)
--   drill_interval_hours    how often the recovery drill re-proves restorability
--   dr_rpo_hours            the recovery-point objective this fleet promises;
--                           the operator diagnosis reports a breach against it
--
-- Both objects are platform-owned. A business is *subject* to a plan policy and
-- must never read or infer it, so the table carries the same `platform_only`
-- policy as the fleet row: a tenant connection sees no rows at all.
--
-- Forward-only and additive: no drops, no rewrites, no deletes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Fleet-level alert and disaster-recovery thresholds
-- ---------------------------------------------------------------------------
ALTER TABLE platform_tenant_backup_service
    ADD COLUMN IF NOT EXISTS alert_stale_hours integer
        CHECK (alert_stale_hours IS NULL OR alert_stale_hours BETWEEN 1 AND 8760),
    ADD COLUMN IF NOT EXISTS alert_failure_streak integer NOT NULL DEFAULT 1
        CHECK (alert_failure_streak BETWEEN 1 AND 10),
    ADD COLUMN IF NOT EXISTS drill_interval_hours integer NOT NULL DEFAULT 24
        CHECK (drill_interval_hours BETWEEN 1 AND 168),
    ADD COLUMN IF NOT EXISTS dr_rpo_hours integer
        CHECK (dr_rpo_hours IS NULL OR dr_rpo_hours BETWEEN 1 AND 720);

COMMENT ON COLUMN platform_tenant_backup_service.alert_stale_hours IS
    'Hours without a successful run before the Owner alert says "stale". NULL derives it from the cadence (interval + grace). Issue #903 §3.';
COMMENT ON COLUMN platform_tenant_backup_service.alert_failure_streak IS
    'Consecutive failed runs that turn a retry into an alert. 1 = alert on the first failure, the pre-#903 behaviour.';
COMMENT ON COLUMN platform_tenant_backup_service.drill_interval_hours IS
    'How often the scheduled recovery drill re-proves one artifact restorable. A plan may drill more often, never less.';
COMMENT ON COLUMN platform_tenant_backup_service.dr_rpo_hours IS
    'Recovery-point objective in hours. NULL = not promised, so the console reports it as unset rather than met.';

-- ---------------------------------------------------------------------------
-- 2. The per-plan policy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_backup_plan_policy (
    -- The sales tier, not a business: `billing_plans.key` is the catalogue's own
    -- identity and deleting a plan takes its policy with it.
    plan_key                text PRIMARY KEY REFERENCES billing_plans(key) ON DELETE CASCADE,

    -- Schedule, retention and capacity. NULL inherits the fleet row.
    interval_hours          integer CHECK (interval_hours IS NULL OR interval_hours IN (1, 2, 3, 4, 6, 8, 12, 24)),
    retention_days          integer CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
    cloud_keep_count        integer CHECK (cloud_keep_count IS NULL OR cloud_keep_count BETWEEN 1 AND 500),
    protected_recovery_copies integer CHECK (protected_recovery_copies IS NULL OR protected_recovery_copies BETWEEN 0 AND 10),
    max_artifact_bytes      bigint  CHECK (max_artifact_bytes IS NULL OR max_artifact_bytes > 0),

    -- Alerting. A plan may shorten the stale window and tighten the streak.
    alert_stale_hours       integer CHECK (alert_stale_hours IS NULL OR alert_stale_hours BETWEEN 1 AND 8760),
    alert_failure_streak    integer CHECK (alert_failure_streak IS NULL OR alert_failure_streak BETWEEN 1 AND 10),

    -- Disaster recovery. A plan may drill more often and promise a shorter
    -- recovery point; the resolver never lets it promise less.
    drill_interval_hours    integer CHECK (drill_interval_hours IS NULL OR drill_interval_hours BETWEEN 1 AND 168),
    dr_rpo_hours            integer CHECK (dr_rpo_hours IS NULL OR dr_rpo_hours BETWEEN 1 AND 720),

    -- Operator copy: why this plan differs. Never serialized to a tenant.
    note                    text NOT NULL DEFAULT '',
    updated_by              uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_backup_plan_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_plan_policy FORCE ROW LEVEL SECURITY;
-- Platform-only, like the fleet row and the per-business override: the whole
-- rule is the bypass, so there is no tenant clause to widen into.
CREATE POLICY platform_only ON tenant_backup_plan_policy FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

COMMENT ON TABLE tenant_backup_plan_policy IS
    'Superadmin-owned per-plan backup policy (schedule, retention, capacity, alert and DR thresholds). NULL inherits platform_tenant_backup_service; a plan may only tighten. Never returned to a tenant. Issue #903 §3.';

-- The scheduler resolves one business's policy by its plan, and the console
-- lists every plan; the primary key already serves both.
