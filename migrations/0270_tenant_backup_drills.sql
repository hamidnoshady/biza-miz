-- ============================================================================
-- 0270_tenant_backup_drills.sql — Issue #903 §12: a drill that runs on a
-- schedule and leaves evidence, not a script nobody starts.
--
-- `npm run backup:drill` proved a backup could be opened, but only when a human
-- remembered to run it. A recovery capability nobody exercises is a hypothesis:
-- the artifact that needs a key version rotated out from under it, or a business
-- whose archive stopped parsing after a schema change, keeps looking healthy for
-- months. This table is where the scheduled drill writes what it proved.
--
-- Two deliberate choices:
--
--   * **Visible to the business it is about.** Unlike the fleet policy and the
--     restore approvals (0269), a drill result is the tenant's own health
--     information: «was my last backup actually restorable?». So the policy is
--     tenant-scoped for SELECT and platform-only for writes — a tenant can read
--     its own evidence but can never manufacture it, because a drill row is
--     exactly the kind of claim a false write would make worthless.
--
--   * **Skipped is recorded, not smoothed over.** `missing_steps` keeps the steps
--     the drill could not prove (the platform never holds the tenant's recovery
--     passphrase, so `portable_envelope` is routinely skipped). A run that proves
--     everything it is allowed to prove is `ok` with a non-empty `missing_steps`;
--     pretending those steps passed would be the one lie this table exists to
--     prevent.
--
-- Forward-only and additive.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_backup_drills (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The artifact the drill exercised. Text, not a FK: the artifact row is the
    -- inventory's business, and a drill must still be readable after retention
    -- removed the artifact it tested (that is precisely the interesting case).
    artifact_ref   text NOT NULL,

    -- Who asked: the scheduler, an operator, or CI. A failing schedule and a
    -- failing manual attempt are different facts.
    source         text NOT NULL DEFAULT 'schedule'
                   CHECK (source IN ('schedule', 'manual', 'ci')),

    ok             boolean NOT NULL,
    -- Steps the run did not prove. Empty on a full pass; a drill that skipped
    -- the portable envelope because the platform does not hold the passphrase
    -- lists it here and still reports `ok` — the verdict is about what it was
    -- asked to prove, and this column is what it was not.
    missing_steps  text[] NOT NULL DEFAULT '{}',
    -- The per-step detail, for the console. Small by construction: six rows.
    steps          jsonb NOT NULL DEFAULT '[]'::jsonb,

    started_at     timestamptz NOT NULL,
    finished_at    timestamptz NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tenant_backup_drills_window CHECK (finished_at >= started_at)
);

-- The console asks "when was this business last drilled, and did it pass?" — so
-- the index is (business, newest first), which is also what the idempotency
-- check reads before starting another run.
CREATE INDEX IF NOT EXISTS tenant_backup_drills_recent
    ON tenant_backup_drills (business_id, finished_at DESC);

ALTER TABLE tenant_backup_drills ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_drills FORCE ROW LEVEL SECURITY;

-- A tenant reads its own drill history (that is the "does my backup actually
-- restore?" evidence the console shows it); writes are the platform's alone.
--
-- Two policies would be the obvious spelling — `tenant_read_drills` FOR SELECT
-- plus a platform-only FOR ALL — but the tenancy gate in
-- integration/tenant-isolation.integration.test.ts treats every `business_id`
-- table as tenant data with exactly one permissive, gate-approved
-- `tenant_isolation` policy, precisely so a table cannot quietly carry a second
-- permissive policy that widens access. So the read scope is the standard
-- policy and the *writes* are subtracted with RESTRICTIVE policies, which AND
-- with it (the same shape migration 0262 uses to hide internal supplier cost):
-- a tenant connection satisfies the permissive policy only for its own rows,
-- and satisfies no write policy at all without the bypass flag.
DROP POLICY IF EXISTS tenant_read_drills ON tenant_backup_drills;
DROP POLICY IF EXISTS tenant_isolation ON tenant_backup_drills;
CREATE POLICY tenant_isolation ON tenant_backup_drills FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Writes are platform-only: a drill result is evidence, and evidence a tenant
-- can write is not evidence. RESTRICTIVE, so the permissive policy above cannot
-- hand a tenant INSERT/UPDATE/DELETE, and no app-layer CHECK is trusted.
DROP POLICY IF EXISTS platform_write_insert ON tenant_backup_drills;
CREATE POLICY platform_write_insert ON tenant_backup_drills AS RESTRICTIVE FOR INSERT
    WITH CHECK (app_rls_bypass());
DROP POLICY IF EXISTS platform_write_update ON tenant_backup_drills;
CREATE POLICY platform_write_update ON tenant_backup_drills AS RESTRICTIVE FOR UPDATE
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());
DROP POLICY IF EXISTS platform_write_delete ON tenant_backup_drills;
CREATE POLICY platform_write_delete ON tenant_backup_drills AS RESTRICTIVE FOR DELETE
    USING (app_rls_bypass());

COMMENT ON TABLE tenant_backup_drills IS
    'One row per automated or manual recovery drill. Tenant-readable for its own business; written only by the platform. Issue #903 §12.';
COMMENT ON COLUMN tenant_backup_drills.missing_steps IS
    'Steps the drill did not prove. Non-empty does not imply failure: the platform never holds the tenant recovery passphrase.';
COMMENT ON COLUMN tenant_backup_drills.artifact_ref IS
    'Text, not a foreign key: a drill must remain readable after retention removed the artifact it tested.';
