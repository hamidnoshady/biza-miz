-- ============================================================================
-- 0265_tenant_backup_service.sql — issue #903 §7, Superadmin-owned storage.
--
-- The tenant-facing surfaces added by 0264 are useless without somewhere for a
-- managed deployment to put the bytes, and the epic is explicit about who owns
-- that: **only Superadmin**. A singleton row holds the platform-owned
-- S3-compatible destination, the enablement switches and the defaults every
-- business inherits. Tenants never read this table (`platform_only` policy) and
-- never receive any of its values; `src/lib/tenant-backup-storage.ts` turns it
-- into a server-side adapter and reports only "configured / not configured".
--
-- Two columns carry secrets (access key id and secret). They are stored
-- **sealed** with the platform key-encryption key, the same custody that wraps
-- tenant artifact keys, so a database dump without the KEK does not hand over
-- the fleet's object-storage credentials. A deployment with no KEK can still
-- run Local backups; it cannot enable the managed cloud service — the adapter
-- refuses rather than storing a credential in the clear.
--
-- Precedence is deliberate and recorded here: a **site** install that already
-- owns its own bucket keeps using its per-business configuration (nothing moves
-- for existing self-hosted customers); **Cloud** and **Hybrid** profiles use
-- this row's destination and prefix, and the local half of Hybrid stays local.
-- ============================================================================

CREATE TABLE platform_tenant_backup_service (
    id                  boolean PRIMARY KEY DEFAULT true CHECK (id),

    -- Cloud/Hybrid business backups uploaded by the platform. `managed_cloud`
    -- false means "not sold on this deployment": Cloud tenants get no cloud
    -- copy, Hybrid keeps its local half only, and no request path may call out.
    managed_cloud       boolean NOT NULL DEFAULT false,
    -- Whether a Hybrid installation may hold a local copy at all. Local-only
    -- installs are governed by their deployment profile, not this flag.
    hybrid_enabled      boolean NOT NULL DEFAULT false,

    -- Platform-owned destination. Never serialized to a tenant response.
    endpoint            text NOT NULL DEFAULT '',
    region              text NOT NULL DEFAULT 'us-east-1',
    bucket              text NOT NULL DEFAULT '',
    -- Prefix strategy: business artifacts live under
    -- `${key_prefix}tenants/<scope tag>/`, derived server-side from the business
    -- id. A tenant cannot choose or influence it.
    key_prefix          text NOT NULL DEFAULT 'managed-tenant-backups/',

    -- Sealed with the platform KEK (`src/lib/tenancy-secrets.ts` envelope).
    -- Empty means "not configured"; the adapter reports that as unavailable
    -- rather than falling back to a plaintext credential.
    access_key_sealed   text NOT NULL DEFAULT '',
    secret_key_sealed   text NOT NULL DEFAULT '',
    access_key_hint     text NOT NULL DEFAULT '',

    -- Defaults a business inherits. A plan allowance can widen storage, never
    -- the schedule floor or the retention ceiling.
    default_interval_hours integer NOT NULL DEFAULT 24
                           CHECK (default_interval_hours IN (1, 2, 3, 4, 6, 8, 12, 24)),
    default_retention_days integer NOT NULL DEFAULT 30 CHECK (default_retention_days BETWEEN 1 AND 3650),
    max_retention_days     integer NOT NULL DEFAULT 365 CHECK (max_retention_days BETWEEN 1 AND 3650),
    -- Cloud copies kept per business, independent of the age-based retention.
    cloud_keep_count       integer NOT NULL DEFAULT 30 CHECK (cloud_keep_count BETWEEN 1 AND 500),
    -- Quotas and transport limits, enforced server-side on every upload.
    max_artifact_bytes     bigint NOT NULL DEFAULT 5368709120 CHECK (max_artifact_bytes > 0),
    upload_chunk_bytes     integer NOT NULL DEFAULT 8388608 CHECK (upload_chunk_bytes > 0),
    -- Bounded concurrency for the upload queue (issue's "bounded concurrency").
    max_parallel_uploads   integer NOT NULL DEFAULT 2 CHECK (max_parallel_uploads BETWEEN 1 AND 16),
    -- Recovery copies that retention may never prune.
    protected_recovery_copies integer NOT NULL DEFAULT 1 CHECK (protected_recovery_copies BETWEEN 0 AND 10),

    -- Operator-facing state, not secrets: when the destination was last proved
    -- reachable, and the last provider-neutral failure code.
    last_checked_at     timestamptz,
    last_check_ok       boolean,
    last_error_code     text,
    updated_by          uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_tenant_backup_service (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE platform_tenant_backup_service ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_tenant_backup_service FORCE ROW LEVEL SECURITY;
-- Platform-only: no tenant policy may ever return this row.
CREATE POLICY platform_only ON platform_tenant_backup_service FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

COMMENT ON TABLE platform_tenant_backup_service IS
    'Superadmin-owned destination/defaults for managed tenant backups. Secrets sealed with the platform KEK; never returned to a tenant. Issue #903 §7.';
COMMENT ON COLUMN platform_tenant_backup_service.key_prefix IS
    'Server-side prefix strategy. Business paths are derived from the business id, never supplied by a request.';

-- ---------------------------------------------------------------------------
-- Upload staging ledger.
--
-- A resumable upload is bytes on the app server before it is a backup. This
-- table is the durable half of that state: which staged object, how many bytes
-- have arrived, and whether it has been verified. It exists so a restart mid
-- upload resumes instead of starting over, and so a staged object can be swept
-- when its session expires.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_backup_upload_sessions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Client-supplied opaque session id (one per upload attempt).
    session_token      text NOT NULL,
    expected_bytes     bigint NOT NULL CHECK (expected_bytes > 0),
    received_bytes     bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
    chunks_received    integer NOT NULL DEFAULT 0 CHECK (chunks_received >= 0),
    sha256             text,
    -- Server-side staging file name, never serialized.
    staging_ref        text NOT NULL,
    state              text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'complete', 'abandoned', 'expired')),
    created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL DEFAULT now() + interval '1 day',
    CONSTRAINT tenant_backup_upload_sessions_token UNIQUE (business_id, session_token),
    CONSTRAINT tenant_backup_upload_sessions_bounds CHECK (received_bytes <= expected_bytes)
);

CREATE INDEX idx_tenant_backup_upload_sessions_open
    ON tenant_backup_upload_sessions (business_id, state, updated_at DESC);

ALTER TABLE tenant_backup_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_backup_upload_sessions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
