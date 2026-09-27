-- 0185_durable_pairing_and_sync_recovery.sql
--
-- A pulled event must remain operationally recoverable after the transport
-- cursor moves on, and a desktop pairing must survive a lost response or a
-- local crash without leaving an active cloud credential behind.

-- ---------------------------------------------------------------------------
-- Canonical sync dead letters
-- ---------------------------------------------------------------------------
-- `sync_event_dead_letters` is the one operator-facing reconciliation model.
-- The old server_sync_dead_letters rows stored a replayable pull envelope in a
-- second, non-actionable table. Bring that envelope into the canonical table;
-- payloads remain server-only and diagnostics expose only their digest.

ALTER TABLE sync_event_dead_letters
  ADD COLUMN source text NOT NULL DEFAULT 'domain'
    CHECK (source IN ('domain', 'server_pull')),
  ADD COLUMN remote_event_id bigint,
  ADD COLUMN payload jsonb,
  ADD COLUMN occurred_at timestamptz,
  ADD COLUMN actor_user_id text,
  ADD COLUMN actor_role text;

ALTER TABLE sync_event_dead_letters
  DROP CONSTRAINT IF EXISTS sync_event_dead_letters_identity_unique;
ALTER TABLE sync_event_dead_letters
  ADD CONSTRAINT sync_event_dead_letters_identity_unique
    UNIQUE (business_id, client_event_id, event_type, schema_version, source);

CREATE INDEX idx_sync_event_dead_letters_pull_replay
  ON sync_event_dead_letters (business_id, remote_event_id)
  WHERE source = 'server_pull' AND status = 'open';

INSERT INTO sync_event_dead_letters (
  business_id, location_id, site_device_id, client_event_id, event_type,
  schema_version, payload_sha256, error_code, source, remote_event_id,
  payload, occurred_at, actor_user_id, actor_role, status, retry_count,
  first_seen_at, last_seen_at
)
SELECT
  legacy.business_id,
  CASE
    WHEN legacy.location_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN legacy.location_id::uuid
    ELSE NULL
  END,
  NULL,
  legacy.client_event_id,
  legacy.event_type,
  1,
  md5(legacy.payload::text) || md5('server-sync:' || legacy.payload::text),
  left(legacy.error, 240),
  'server_pull',
  legacy.remote_event_id,
  legacy.payload,
  legacy.created_at,
  NULL,
  NULL,
  'open',
  0,
  legacy.created_at,
  legacy.created_at
FROM server_sync_dead_letters legacy
ON CONFLICT (business_id, client_event_id, event_type, schema_version, source)
DO UPDATE SET
  remote_event_id = EXCLUDED.remote_event_id,
  payload = EXCLUDED.payload,
  occurred_at = EXCLUDED.occurred_at,
  error_code = EXCLUDED.error_code,
  last_seen_at = GREATEST(sync_event_dead_letters.last_seen_at, EXCLUDED.last_seen_at),
  status = CASE
    WHEN sync_event_dead_letters.status = 'discarded' THEN 'discarded'
    ELSE 'open'
  END;

DROP TABLE server_sync_dead_letters;

-- ---------------------------------------------------------------------------
-- Resumable pairing sessions
-- ---------------------------------------------------------------------------
-- Pending credentials never authenticate normal server-sync traffic. The
-- snapshot and the one-time token are encrypted at rest so the same install
-- can resume a lost response without a second credential being minted.

ALTER TABLE site_devices
  DROP CONSTRAINT IF EXISTS site_devices_status_check;
ALTER TABLE site_devices
  ADD CONSTRAINT site_devices_status_check
    CHECK (status IN ('pending', 'active', 'disabled', 'revoked'));

CREATE TABLE pairing_sessions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  install_pairing_code_id  uuid NOT NULL UNIQUE REFERENCES install_pairing_codes(id) ON DELETE RESTRICT,
  business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id              uuid NOT NULL,
  site_device_id           uuid NOT NULL REFERENCES site_devices(id) ON DELETE RESTRICT,
  installation_id          text NOT NULL CHECK (char_length(trim(installation_id)) BETWEEN 8 AND 200),
  device_name              text NOT NULL CHECK (char_length(trim(device_name)) BETWEEN 1 AND 120),
  state                    text NOT NULL CHECK (state IN (
    'issued', 'redeeming', 'snapshot_ready', 'downloaded',
    'local_commit_pending', 'completed', 'expired', 'abandoned', 'revoked'
  )),
  sync_token_ciphertext    text NOT NULL,
  snapshot_ciphertext      text,
  expires_at               timestamptz NOT NULL,
  downloaded_at            timestamptz,
  completed_at             timestamptz,
  revoked_at               timestamptz,
  last_error_code          text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pairing_sessions_location_business_fk
    FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE CASCADE,
  CONSTRAINT pairing_sessions_device_business_fk
    FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE RESTRICT
);

CREATE INDEX idx_pairing_sessions_pending_expiry
  ON pairing_sessions (expires_at, updated_at)
  WHERE state IN ('redeeming', 'snapshot_ready', 'downloaded', 'local_commit_pending');
CREATE INDEX idx_pairing_sessions_business
  ON pairing_sessions (business_id, created_at DESC);

ALTER TABLE pairing_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pairing_sessions FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
