-- ============================================================================
-- 0264_managed_tenant_backup.sql — issue #903, managed tenant backup service.
--
-- This is the durable half of the managed-backup slice. Four tables, each with
-- one job, and none of them a second commercial authority:
--
--   1. `tenant_backup_artifacts` — the tenant's own artifact inventory, one row
--      per *destination* (`local` / `cloud`) so a Hybrid mirror is two rows that
--      share one `artifact_id`. The row is what the tenant UI lists (through the
--      pure policy in `src/lib/tenant-backup-inventory.ts`) and what every
--      download/verify/restore request re-resolves against. `storage_ref` (the
--      object key or file name) lives here and is NEVER serialized to a tenant:
--      the browser only ever receives the opaque, business-bound reference from
--      `tenant-backup-artifact-ref.ts`.
--
--   2. `backup_key_versions` — managed encryption custody. The per-business
--      artifact secret is stored **wrapped** under the platform key-encryption
--      key, one row per version, so rotation never strands an old archive. The
--      column is named `subject_business_id`, not `business_id`, for the reason
--      `kavenegar_service_alerts` documents: this row belongs to the platform's
--      custody records and a tenant must never be able to read it at all. It
--      carries a `platform_only` policy, so a tenant-scoped connection sees zero
--      rows even if a query forgets a filter.
--
--   3. `tenant_backup_restore_jobs` — the dry-run preview and (future) apply
--      journal for the central tenant-only logical restore. A preview is
--      recorded because #903 requires the operator to be able to answer "who saw
--      what, and what did they approve" later. `blockers` stores the codes from
--      `tenant-restore-preview.ts`, never rewritten into a friendlier story.
--
--   4. `tenant_backup_storage_samples` — retained managed-cloud bytes over time.
--      `backup.storage_byte_day`'s meter aggregates `byte_time`; the samples are
--      the evidence for the quantity the billing runtime receives, so a tenant
--      can ask why a storage charge looks the way it does. Local-only bytes
--      never appear here.
--
-- Forward-only and additive: no existing table changes meaning, no row is
-- rewritten, nothing is dropped. Existing `backup_runs` history stays exactly as
-- it is; the new inventory is populated from new runs (and, where a run is known
-- to be an artifact, by an explicit backfill — never by reclassifying a SQL/XLSX
-- export as a restorable backup).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tenant artifact inventory
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_backup_artifacts (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The LOGICAL backup. Both destinations of a Hybrid mirror share it, which
    -- is what lets the inventory show one backup at two places without double
    -- counting it, and what the billing settlement deduplicates on.
    artifact_id        uuid NOT NULL,
    destination        text NOT NULL CHECK (destination IN ('local', 'cloud')),
    format             text NOT NULL CHECK (format IN ('physical_dump', 'logical_snapshot')),
    origin             text NOT NULL CHECK (origin IN ('scheduled', 'manual', 'uploaded')),
    state              text NOT NULL DEFAULT 'verifying' CHECK (state IN (
                           'pending_upload', 'uploading', 'verifying', 'ready', 'failed', 'expired'
                       )),
    payload_bytes      bigint CHECK (payload_bytes >= 0),
    stored_bytes       bigint CHECK (stored_bytes >= 0),
    sha256             text,
    -- The signed manifest (`backup-manifest.ts`). Stored as jsonb so an operator
    -- query can aggregate completeness without a second table, and validated in
    -- application code before it is ever embedded in a new artifact.
    manifest           jsonb,
    manifest_signature text,
    encryption_scheme  text NOT NULL DEFAULT 'managed_envelope_v1' CHECK (encryption_scheme IN (
                           'managed_envelope_v1', 'legacy_passphrase_v1'
                       )),
    -- Custody generation protecting this artifact. NULL only for legacy
    -- passphrase artifacts, which are labelled as such rather than reclassified.
    key_version        integer CHECK (key_version > 0),
    completeness       text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete', 'partial')),
    -- Server-only: the object key in managed storage, or the local file name.
    -- Never serialized; see `tenant-backup-artifact-ref.ts` for what the tenant
    -- actually receives.
    storage_ref        text NOT NULL,
    captured_at        timestamptz NOT NULL,
    verified_at        timestamptz,
    retention_until    timestamptz,
    last_restore_at    timestamptz,
    -- An already-mapped, provider-neutral failure code. Internal errors (bucket
    -- names, endpoints, stack text) never land here.
    failure_code       text,
    run_id             uuid REFERENCES backup_runs(id) ON DELETE SET NULL,
    created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- Idempotency: a retried upload/publish cannot create a second row for the
    -- same object, and a mirror keeps exactly one row per destination.
    CONSTRAINT tenant_backup_artifacts_one_per_destination
        UNIQUE (business_id, destination, storage_ref),
    -- A managed artifact must name the key version that protects it; a legacy
    -- one must not pretend to have one.
    CONSTRAINT tenant_backup_artifacts_key_version_check CHECK (
        (encryption_scheme = 'managed_envelope_v1' AND key_version IS NOT NULL) OR
        (encryption_scheme = 'legacy_passphrase_v1' AND key_version IS NULL)
    )
);

CREATE INDEX idx_tenant_backup_artifacts_business_time
    ON tenant_backup_artifacts (business_id, captured_at DESC);
CREATE INDEX idx_tenant_backup_artifacts_business_state
    ON tenant_backup_artifacts (business_id, state);
-- The inventory groups a mirror by artifact id, and the restore path resolves
-- "the other destination of this backup" from it.
CREATE INDEX idx_tenant_backup_artifacts_artifact
    ON tenant_backup_artifacts (business_id, artifact_id);
-- Retention sweeps scan by expiry; a partial index keeps that cheap while most
-- artifacts are not yet expiring.
CREATE INDEX idx_tenant_backup_artifacts_retention
    ON tenant_backup_artifacts (retention_until)
    WHERE retention_until IS NOT NULL;

ALTER TABLE tenant_backup_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_backup_artifacts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON COLUMN tenant_backup_artifacts.storage_ref IS
    'Provider object key or local file name. Server-only: never serialize to a tenant. Issue #903.';
COMMENT ON COLUMN tenant_backup_artifacts.artifact_id IS
    'The logical backup shared by its local and cloud rows, so a mirror is one backup, not two.';

-- ---------------------------------------------------------------------------
-- 2. Managed encryption custody (platform-only)
-- ---------------------------------------------------------------------------
CREATE TABLE backup_key_versions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Ownership of the custody record, not a tenancy scope: the row is the
    -- platform's, and the tenant cannot read it. Named `subject_business_id` on
    -- purpose (see the header) so the tenancy sweep treats it as a subject key
    -- rather than as a tenant-owned table.
    subject_business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    version            integer NOT NULL CHECK (version > 0),
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'revoked')),
    -- AES-256-GCM, key derived from the KEK with a purpose-bound HKDF-style
    -- derivation. The artifact secret itself is never stored in plaintext, in a
    -- log, or in a response.
    wrapped            text NOT NULL,
    nonce              text NOT NULL,
    auth_tag           text NOT NULL,
    kek_source         text NOT NULL DEFAULT 'environment',
    created_at         timestamptz NOT NULL DEFAULT now(),
    retired_at         timestamptz,
    revoked_at         timestamptz,
    CONSTRAINT backup_key_versions_one_per_version UNIQUE (subject_business_id, version)
);

-- At most one ACTIVE generation per business: sealing a new artifact must have a
-- single unambiguous key, and a rotation is a transaction that retires the old
-- one in the same step.
CREATE UNIQUE INDEX backup_key_versions_one_active
    ON backup_key_versions (subject_business_id)
    WHERE status = 'active';
CREATE INDEX backup_key_versions_subject
    ON backup_key_versions (subject_business_id, version DESC);

ALTER TABLE backup_key_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_key_versions FORCE ROW LEVEL SECURITY;
-- No tenant policy by design: a wrapped key is platform custody material. Only
-- `withoutTenantScope`/platform callers read this table.
CREATE POLICY platform_only ON backup_key_versions FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

COMMENT ON TABLE backup_key_versions IS
    'Wrapped per-business artifact secrets, one row per custody generation. Platform-only; never exposed to a tenant API. Issue #903 §5.';

-- ---------------------------------------------------------------------------
-- 3. Tenant-only restore preview / apply journal
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_backup_restore_jobs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Opaque, business-bound reference the browser sent; re-resolved against the
    -- inventory on every request, exactly like the legacy restore path.
    artifact_ref       text NOT NULL,
    artifact_row_id    uuid,
    mode               text NOT NULL CHECK (mode IN ('preview', 'apply')),
    phase              text NOT NULL DEFAULT 'previewed' CHECK (phase IN (
                           'previewed', 'approved', 'checkpointed', 'applying',
                           'succeeded', 'failed', 'rolled_back'
                       )),
    -- Codes from `tenant-restore-preview.ts`, stored verbatim so a preview can be
    -- replayed honestly rather than re-derived from a changed code path.
    blockers           jsonb NOT NULL DEFAULT '[]'::jsonb,
    preview            jsonb,
    -- Who approved, and the platform approval reference when an operator (not
    -- the Owner) is applying. Never a key, a path or an artifact payload.
    approval_ref       text,
    actor_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    checkpoint_ref     text,
    journal_id         text,
    failure_code       text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz
);

CREATE INDEX idx_tenant_backup_restore_jobs_business_time
    ON tenant_backup_restore_jobs (business_id, created_at DESC);
-- One open apply per business: the row backs the same exclusive intent the
-- distributed restore lock enforces at execution time.
CREATE UNIQUE INDEX tenant_backup_restore_jobs_one_open_apply
    ON tenant_backup_restore_jobs (business_id)
    WHERE mode = 'apply' AND phase IN ('approved', 'checkpointed', 'applying');

ALTER TABLE tenant_backup_restore_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_restore_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_backup_restore_jobs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE tenant_backup_restore_jobs IS
    'Preview/apply journal for the central tenant-only logical restore. Never a physical whole-database restore. Issue #903 §4.';

-- ---------------------------------------------------------------------------
-- 4. Retained managed-cloud bytes over time (byte-day meter evidence)
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_backup_storage_samples (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    sampled_at         timestamptz NOT NULL DEFAULT now(),
    -- Managed cloud bytes only. Local copies carry no cloud storage charge.
    cloud_bytes        bigint NOT NULL CHECK (cloud_bytes >= 0),
    artifact_count     integer NOT NULL DEFAULT 0 CHECK (artifact_count >= 0),
    CONSTRAINT tenant_backup_storage_samples_one_per_instant
        UNIQUE (business_id, sampled_at)
);

CREATE INDEX idx_tenant_backup_storage_samples_business_time
    ON tenant_backup_storage_samples (business_id, sampled_at DESC);

ALTER TABLE tenant_backup_storage_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_storage_samples FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_backup_storage_samples FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE tenant_backup_storage_samples IS
    'Time series behind the backup.storage_byte_day meter: retained managed-cloud bytes per business. Local bytes are never recorded. Issue #903 §7.';
