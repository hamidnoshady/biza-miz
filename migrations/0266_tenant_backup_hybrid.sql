-- ============================================================================
-- 0266_tenant_backup_hybrid.sql — Issue #903 §5: Hybrid mode made correct.
--
-- A Hybrid install is a café machine with its own database, its own local
-- backups, and a managed copy in the platform bucket whenever the network
-- allows. Three things have to be true for that to be honest:
--
--   1. **Nothing is lost while offline.** A finished artifact that cannot be
--      uploaded waits in a durable queue, in order, with a bounded retry count —
--      not "retried next tick if someone remembers".
--   2. **Liveness is a fact, not a guess.** The tenant inventory must be able to
--      say "your site was last seen 3 minutes ago" or "unknown" instead of
--      implying a mirror that may not exist. `tenant_backup_site_heartbeat`
--      holds the last recorded contact and the queue depth at that moment.
--   3. **A rebuilt or restored site cannot overwrite newer state with older
--      state.** Every artifact carries the sync *generation* of the install
--      that produced it; the platform records the generation it has already
--      accepted for the business and refuses anything older. This is the fence:
--      re-registering an old laptop does not roll the cloud copy back in time.
--
-- Forward-only and additive. Both tables are tenant-scoped and carry an RLS
-- policy in this same migration, so a business sees only its own queue and its
-- own heartbeat.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Upload queue (one row per artifact awaiting managed upload)
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_backup_upload_queue (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The local artifact this row is about; the same artifact queues once.
    artifact_name      text NOT NULL,
    -- Generation of the install that produced it (see
    -- tenant_backup_site_heartbeat.site_generation).
    generation         bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    state              text NOT NULL DEFAULT 'queued'
                       CHECK (state IN ('queued', 'uploading', 'done', 'dead', 'superseded')),
    attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at    timestamptz NOT NULL DEFAULT now(),
    last_error_code    text,
    enqueued_at        timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    CONSTRAINT tenant_backup_upload_queue_artifact UNIQUE (business_id, artifact_name)
);

CREATE INDEX idx_tenant_backup_upload_queue_due
    ON tenant_backup_upload_queue (business_id, next_attempt_at)
    WHERE state IN ('queued', 'uploading');

ALTER TABLE tenant_backup_upload_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_upload_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_backup_upload_queue FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. Site heartbeat + accepted sync generation
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_backup_site_heartbeat (
    business_id        uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    -- The install's own generation counter. A fresh install starts at a new
    -- value; a laptop that restored an old database comes back with an older
    -- one, which is exactly what the fence detects.
    site_generation    bigint NOT NULL DEFAULT 0 CHECK (site_generation >= 0),
    -- Highest generation the platform has already accepted for this business.
    accepted_generation bigint NOT NULL DEFAULT 0 CHECK (accepted_generation >= 0),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    queue_depth        integer NOT NULL DEFAULT 0 CHECK (queue_depth >= 0),
    last_error_code    text,
    app_version        text,
    updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_backup_site_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_backup_site_heartbeat FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_backup_site_heartbeat FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
