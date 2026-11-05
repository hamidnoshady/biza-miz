-- ============================================================================
-- 0269_tenant_backup_overrides.sql — Issue #903 §3: what Superadmin decides per
-- business, and who approves a destructive restore.
--
-- Two capabilities the epic names and the schema could not yet express.
--
--   1. **Per-business policy overrides.** `platform_tenant_backup_service` holds
--      the fleet defaults (interval, retention ceiling, keep count, quotas). A
--      single business sometimes needs a different cadence or a longer retention
--      — a workshop with a legal 90-day requirement, a site that fits in one
--      hour. Without this table the only lever was to change the fleet, which
--      changes every tenant. Overrides are *bounded by the fleet*, never free:
--      the resolver clamps retention to `max_retention_days` and the keep count
--      to `cloud_keep_count`, so an override can tighten or extend inside the
--      platform's own ceiling but can never invent one.
--
--   2. **Recovery approvals.** For a business whose owner wants a second pair of
--      eyes on a destructive restore, an approval is a Superadmin's named,
--      expiring, single-use consent for one artifact. It is off by default
--      (`require_restore_approval` false), so no existing restore changes
--      behaviour; when it is on, the apply route refuses without one.
--
-- Both tables are platform-owned: a business may be *subject* to a policy or an
-- approval, but must never read, write or infer either. They carry the same
-- `platform_only` policy as the fleet row, so a tenant connection sees no rows
-- at all rather than a redacted view.
--
-- Forward-only and additive.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-business policy overrides
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_backup_business_policy (
    -- Named `subject_business_id`, not `business_id`: this row is the platform's
    -- (same reason `backup_key_versions` and `kavenegar_service_alerts` do it).
    -- The generic tenancy check treats every `business_id` table as tenant data
    -- that needs a single permissive `tenant_isolation` policy — and this row
    -- must never be reachable from a tenant connection at all.
    subject_business_id      uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,

    -- NULL means "inherit the fleet default". A NULL column is not a zero: the
    -- resolver must be able to tell "the operator chose 12 hours" from "nobody
    -- has said anything", and treating a missing value as an override would
    -- silently pin every business to whatever the default was on the day.
    interval_hours           integer CHECK (interval_hours IS NULL OR interval_hours IN (1, 2, 3, 4, 6, 8, 12, 24)),
    retention_days           integer CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
    keep_count               integer CHECK (keep_count IS NULL OR keep_count BETWEEN 1 AND 500),
    protected_recovery_copies integer CHECK (protected_recovery_copies IS NULL OR protected_recovery_copies BETWEEN 0 AND 10),
    -- Quota: a plan allowance can widen storage for one business without
    -- touching the fleet's own ceiling.
    max_artifact_bytes       bigint  CHECK (max_artifact_bytes IS NULL OR max_artifact_bytes > 0),

    -- Whether a destructive restore needs a Superadmin approval (see part 2).
    -- Defaults to false so enabling this table changes nothing by itself.
    require_restore_approval boolean NOT NULL DEFAULT false,

    -- Why the override exists. Operator copy, shown in the console; never
    -- serialized to a tenant.
    note                     text NOT NULL DEFAULT '',
    updated_by               uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_backup_business_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_business_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON tenant_backup_business_policy;
CREATE POLICY platform_only ON tenant_backup_business_policy FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

COMMENT ON TABLE tenant_backup_business_policy IS
    'Superadmin-owned per-business overrides of the managed backup policy. Platform-only: a tenant is subject to it but never reads it. Issue #903 §3.';
COMMENT ON COLUMN tenant_backup_business_policy.interval_hours IS
    'NULL inherits the fleet default. Clamped to the fleet set by the resolver, never free-form.';

-- ---------------------------------------------------------------------------
-- 2. Recovery approvals (one named consent per artifact)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_backup_restore_approvals (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Same reasoning as tenant_backup_business_policy above: the business is the
    -- subject of the consent, never a scope a tenant can reach.
    subject_business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The opaque artifact reference the approval is for. Kept as text: the same
    -- reference the tenant route resolves, so an approval cannot be re-pointed.
    artifact_ref  text NOT NULL,

    approved_by   uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    approved_at   timestamptz NOT NULL DEFAULT now(),
    -- Consent does not live forever: an approval nobody used within its window
    -- is not permission tomorrow.
    expires_at    timestamptz NOT NULL,
    -- Single use. The apply route sets this only after a restore actually
    -- committed, so a failed attempt never burns the Owner's approval.
    consumed_at   timestamptz,
    consumed_journal_id uuid,

    note          text NOT NULL DEFAULT '',

    CONSTRAINT tenant_backup_restore_approvals_window CHECK (expires_at > approved_at)
);

CREATE INDEX IF NOT EXISTS tenant_backup_restore_approvals_lookup
    ON tenant_backup_restore_approvals (subject_business_id, artifact_ref, expires_at DESC);

ALTER TABLE tenant_backup_restore_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_restore_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON tenant_backup_restore_approvals;
CREATE POLICY platform_only ON tenant_backup_restore_approvals FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

COMMENT ON TABLE tenant_backup_restore_approvals IS
    'Superadmin consent for one destructive tenant restore: named, expiring, single use. Platform-only. Issue #903 §3.';
COMMENT ON COLUMN tenant_backup_restore_approvals.consumed_at IS
    'Set only after a restore committed; a failed attempt leaves the approval usable.';
