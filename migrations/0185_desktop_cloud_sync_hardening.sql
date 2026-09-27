-- 0185_desktop_cloud_sync_hardening.sql
--
-- Desktop ↔ cloud pairing is an enrollment, not a single destructive exchange.
-- A code now reserves a pending site identity, prepares a snapshot, and is only
-- consumed after the newly bootstrapped desktop acknowledges activation.  The
-- same migration upgrades site credentials to support a short staged rotation
-- window and adds an auditable, per-device sync-run journal.

ALTER TABLE install_pairing_codes
  ADD COLUMN IF NOT EXISTS enrollment_state text NOT NULL DEFAULT 'issued'
    CHECK (enrollment_state IN ('issued', 'reserved', 'snapshot_prepared', 'active', 'failed')),
  ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS site_device_id uuid REFERENCES site_devices(id) ON DELETE SET NULL;

UPDATE install_pairing_codes
   SET enrollment_state = CASE WHEN redeemed_at IS NULL THEN 'issued' ELSE 'active' END
 WHERE enrollment_state = 'issued';

CREATE INDEX IF NOT EXISTS idx_pairing_codes_pending_enrollment
  ON install_pairing_codes (reservation_expires_at)
  WHERE enrollment_state IN ('reserved', 'snapshot_prepared');

ALTER TABLE site_devices
  DROP CONSTRAINT IF EXISTS site_devices_status_check;
ALTER TABLE site_devices
  ADD CONSTRAINT site_devices_status_check
  CHECK (status IN ('pending', 'active', 'disabled', 'revoked'));

-- The original table used site_device_id as its primary key, which made an
-- overlap period technically impossible.  Credentials remain hash-only; the
-- optional ciphertext exists only for a short staged hand-off and is encrypted
-- with the platform's existing integration-secret key, never exposed in owner
-- diagnostics or logs.
ALTER TABLE site_sync_credentials
  DROP CONSTRAINT IF EXISTS site_sync_credentials_pkey;
ALTER TABLE site_sync_credentials
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'staged', 'revoked')),
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS token_ciphertext text;
ALTER TABLE site_sync_credentials
  ADD CONSTRAINT site_sync_credentials_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX IF NOT EXISTS site_sync_credentials_one_active
  ON site_sync_credentials (site_device_id)
  WHERE state = 'active' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_site_sync_credentials_lookup
  ON site_sync_credentials (token_hash)
  WHERE state IN ('active', 'staged') AND revoked_at IS NULL;

CREATE TABLE sync_runs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    site_device_id        uuid REFERENCES site_devices(id) ON DELETE SET NULL,
    location_id           uuid REFERENCES locations(id) ON DELETE SET NULL,
    direction             text NOT NULL CHECK (direction IN ('push', 'pull', 'activation')),
    status                text NOT NULL CHECK (status IN ('running', 'ok', 'error', 'skipped')),
    remote_identity       text,
    start_cursor          bigint,
    end_cursor            bigint,
    events_attempted      integer NOT NULL DEFAULT 0 CHECK (events_attempted >= 0),
    events_applied        integer NOT NULL DEFAULT 0 CHECK (events_applied >= 0),
    events_deferred       integer NOT NULL DEFAULT 0 CHECK (events_deferred >= 0),
    events_conflicted     integer NOT NULL DEFAULT 0 CHECK (events_conflicted >= 0),
    events_dead_lettered  integer NOT NULL DEFAULT 0 CHECK (events_dead_lettered >= 0),
    http_status           integer,
    retry_count           integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    duration_ms           integer,
    bytes_sent            bigint,
    bytes_received        bigint,
    error_code            text,
    error_detail          text,
    started_at            timestamptz NOT NULL DEFAULT now(),
    completed_at          timestamptz
);
CREATE INDEX idx_sync_runs_device_recent
  ON sync_runs (business_id, site_device_id, started_at DESC);
CREATE INDEX idx_sync_runs_business_recent
  ON sync_runs (business_id, started_at DESC);

ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_runs FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
