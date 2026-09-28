-- 0187_desktop_release_management.sql
--
-- Device-level desktop runtime telemetry and the canonical Desktop release
-- catalogue.  A Desktop release is ordered by SemVer; commit SHA/build id are
-- provenance only.  Runtime reports are authenticated through the existing
-- location-scoped site credential and are stored against that exact device.
--
-- This also retires migration 0038's unused generic-S3 updater singleton.  It
-- had no runtime/publisher consumer and retained a plaintext access secret.

CREATE TABLE platform_releases (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version                    text NOT NULL,
    build_commit               text NOT NULL,
    build_id                   text NOT NULL,
    channel                    text NOT NULL CHECK (channel IN ('stable', 'beta', 'internal')),
    status                     text NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'published', 'paused', 'withdrawn')),
    rollout_state              text NOT NULL DEFAULT 'internal'
                                 CHECK (rollout_state IN ('internal', 'pilot', 'percentage', 'full', 'paused')),
    rollout_percentage         integer NOT NULL DEFAULT 0 CHECK (rollout_percentage BETWEEN 0 AND 100),
    released_at                timestamptz,
    minimum_supported_version  text,
    mandatory                  boolean NOT NULL DEFAULT false,
    installer_url              text NOT NULL,
    installer_sha256           text NOT NULL CHECK (installer_sha256 ~ '^[0-9a-f]{64}$'),
    installer_size             bigint NOT NULL CHECK (installer_size > 0),
    manifest_signature         text NOT NULL CHECK (char_length(manifest_signature) >= 80),
    signature_required         boolean NOT NULL DEFAULT true,
    expected_publisher         text NOT NULL CHECK (char_length(trim(expected_publisher)) > 0),
    migration_version          integer CHECK (migration_version IS NULL OR migration_version > 0),
    minimum_schema_version     integer CHECK (minimum_schema_version IS NULL OR minimum_schema_version > 0),
    maximum_schema_version     integer CHECK (maximum_schema_version IS NULL OR maximum_schema_version > 0),
    backup_required            boolean NOT NULL DEFAULT true,
    release_notes              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(release_notes) = 'array'),
    recovery_notes             text,
    known_good_release_id      uuid REFERENCES platform_releases(id) ON DELETE SET NULL,
    created_by                 uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT platform_releases_channel_version_unique UNIQUE (channel, version),
    CONSTRAINT platform_releases_schema_range CHECK (
      maximum_schema_version IS NULL OR minimum_schema_version IS NULL OR
      maximum_schema_version >= minimum_schema_version
    ),
    CONSTRAINT platform_releases_release_time CHECK (status = 'draft' OR released_at IS NOT NULL),
    CONSTRAINT platform_releases_rollout_percentage CHECK (
      (rollout_state = 'full' AND rollout_percentage = 100) OR
      (rollout_state = 'percentage' AND rollout_percentage BETWEEN 1 AND 99) OR
      (rollout_state = 'pilot' AND rollout_percentage BETWEEN 1 AND 20) OR
      (rollout_state IN ('internal', 'paused') AND rollout_percentage = 0)
    )
);
CREATE INDEX idx_platform_releases_target
  ON platform_releases (channel, released_at DESC)
  WHERE status = 'published' AND rollout_state <> 'paused';

CREATE TABLE site_device_runtime_status (
    site_device_id          uuid PRIMARY KEY REFERENCES site_devices(id) ON DELETE CASCADE,
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id             uuid NOT NULL,
    app_version             text,
    commit_sha              text,
    build_id                text,
    schema_version          integer CHECK (schema_version IS NULL OR schema_version > 0),
    electron_version        text,
    platform                text,
    release_channel         text NOT NULL DEFAULT 'stable'
                              CHECK (release_channel IN ('stable', 'beta', 'internal')),
    client_checked_at       timestamptz,
    reported_at             timestamptz NOT NULL DEFAULT now(),
    update_state            text,
    update_target_version   text,
    last_error_code         text,
    last_error_message      text,
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT site_device_runtime_device_business_fk
      FOREIGN KEY (site_device_id, business_id)
      REFERENCES site_devices(id, business_id) ON DELETE CASCADE,
    CONSTRAINT site_device_runtime_location_business_fk
      FOREIGN KEY (location_id, business_id)
      REFERENCES locations(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_site_device_runtime_business
  ON site_device_runtime_status (business_id, reported_at DESC);
CREATE INDEX idx_site_device_runtime_channel
  ON site_device_runtime_status (release_channel, app_version);

CREATE TABLE site_device_update_events (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_device_id        uuid NOT NULL REFERENCES site_devices(id) ON DELETE CASCADE,
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- UUID provenance only: tenant exports can be restored without copying the
    -- deployment-global release catalogue into a standalone database.
    release_id            uuid,
    installed_version     text,
    target_version        text,
    state                 text NOT NULL,
    error_code            text,
    detail                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
    client_occurred_at    timestamptz,
    reported_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT site_device_update_events_device_business_fk
      FOREIGN KEY (site_device_id, business_id)
      REFERENCES site_devices(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_site_device_update_events_device
  ON site_device_update_events (business_id, site_device_id, reported_at DESC);

ALTER TABLE site_device_runtime_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_device_runtime_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON site_device_runtime_status FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE site_device_update_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_device_update_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON site_device_update_events FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

DROP TABLE platform_update_config;
