-- Migration 0238 — issue #974: Full Offline mandatory Cloud activation,
-- device/business validation & refresh, online-only support, and outbound
-- owner-consented Superadmin remote support sessions.
--
-- Architectural boundary:
--   Full Offline (`deployment.profile = 'local'`) installations NEVER write
--   `site_devices`, `site_sync_credentials`, or `server_sync.config`, so they
--   never trigger `sync_events` outbox accumulation on Cloud or enable Hybrid
--   two-way operational transaction replication. Instead, they enroll into
--   dedicated `local_installations` + `local_installation_credentials` (`LOC1-`
--   audience) using one-time `OFL1-` enrollment tokens (`local_enrollment_codes`).

-- ── 1. Cloud-side Full Offline enrollment tokens ─────────────────────────────

CREATE TABLE local_enrollment_codes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id         uuid NOT NULL,
    code_hash           text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    issued_by_user_id   uuid,
    issued_by_admin_id  uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    expires_at          timestamptz NOT NULL,
    redeemed_at         timestamptz,
    redeemed_ip         text,
    revoked_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT local_enrollment_codes_location_fk
      FOREIGN KEY (location_id, business_id)
      REFERENCES locations(id, business_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_local_enrollment_codes_live_per_location
    ON local_enrollment_codes (business_id, location_id)
    WHERE redeemed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX idx_local_enrollment_codes_business
    ON local_enrollment_codes (business_id, created_at DESC);

-- ── 2. Cloud-side Full Offline installation registry ─────────────────────────

CREATE TABLE local_installations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    public_id               text NOT NULL UNIQUE DEFAULT ('loc_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id             uuid NOT NULL,
    installation_id         text NOT NULL CHECK (char_length(btrim(installation_id)) BETWEEN 8 AND 200),
    display_name            text NOT NULL DEFAULT 'Windows Business Suite (Full Offline)',
    status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'disabled', 'revoked')),
    enrollment_code_id      uuid REFERENCES local_enrollment_codes(id) ON DELETE SET NULL,
    app_version             text,
    schema_version          text,
    last_seen_at            timestamptz,
    last_validated_at       timestamptz,
    last_business_revision  text,
    last_health_summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
    offline_lease_days      integer CHECK (offline_lease_days IS NULL OR offline_lease_days BETWEEN 1 AND 365),
    revoked_at              timestamptz,
    revoked_reason          text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, business_id),
    CONSTRAINT local_installations_location_fk
      FOREIGN KEY (location_id, business_id)
      REFERENCES locations(id, business_id) ON DELETE CASCADE
);

-- One physical installation identity cannot be bound to two active businesses.
CREATE UNIQUE INDEX uq_local_installations_active_binding
    ON local_installations (installation_id)
    WHERE status <> 'revoked';

CREATE INDEX idx_local_installations_business
    ON local_installations (business_id, created_at DESC);

-- ── 3. Cloud-side Full Offline installation credentials (hash-only, staged) ──

CREATE TABLE local_installation_credentials (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    local_installation_id   uuid NOT NULL,
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    token_hash              text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    -- Encrypted handoff ciphertext kept ONLY while `pending` (crash-safe
    -- enrollment resume) or `staged` (24-hour rotation handoff); cleared to
    -- NULL the moment the installation acknowledges receipt.
    token_ciphertext        text,
    state                   text NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'active', 'staged', 'revoked')),
    valid_until             timestamptz,
    session_expires_at      timestamptz,
    rotated_at              timestamptz,
    acknowledged_at         timestamptz,
    revoked_at              timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT local_installation_credentials_installation_fk
      FOREIGN KEY (local_installation_id, business_id)
      REFERENCES local_installations(id, business_id) ON DELETE CASCADE
);

CREATE INDEX idx_local_installation_credentials_lookup
    ON local_installation_credentials (token_hash)
    WHERE revoked_at IS NULL;

-- ── 4. Cloud-side remote support sessions & commands for Full Offline ────────

CREATE TABLE local_support_sessions (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id                 uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    local_installation_id       uuid NOT NULL,
    admin_id                    uuid NOT NULL REFERENCES platform_admins(id) ON DELETE RESTRICT,
    operator_name               text NOT NULL,
    ticket_id                   uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
    reason                      text NOT NULL CHECK (char_length(btrim(reason)) >= 10),
    mode                        text NOT NULL DEFAULT 'read_only'
                                CHECK (mode IN ('read_only', 'controlled', 'recovery_only')),
    state                       text NOT NULL DEFAULT 'pending_owner_consent'
                                CHECK (state IN (
                                  'pending_owner_consent',
                                  'active',
                                  'paused_disconnected',
                                  'denied',
                                  'ended',
                                  'revoked',
                                  'expired'
                                )),
    requested_duration_minutes  integer NOT NULL DEFAULT 30
                                CHECK (requested_duration_minutes BETWEEN 5 AND 60),
    consent_expires_at          timestamptz NOT NULL,
    approved_at                 timestamptz,
    approved_by_local_user_id   uuid,
    expires_at                  timestamptz,
    last_site_heartbeat_at      timestamptz,
    ended_at                    timestamptz,
    ended_by                    text,
    end_reason                  text,
    session_nonce               text NOT NULL,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, business_id),
    CONSTRAINT local_support_sessions_installation_fk
      FOREIGN KEY (local_installation_id, business_id)
      REFERENCES local_installations(id, business_id) ON DELETE CASCADE
);

CREATE INDEX idx_local_support_sessions_installation
    ON local_support_sessions (local_installation_id, state, created_at DESC);

CREATE INDEX idx_local_support_sessions_business
    ON local_support_sessions (business_id, created_at DESC);

CREATE TABLE local_support_commands (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    session_id              uuid NOT NULL,
    local_installation_id   uuid NOT NULL,
    admin_id                uuid NOT NULL REFERENCES platform_admins(id) ON DELETE RESTRICT,
    command_type            text NOT NULL CHECK (command_type IN (
                              'inspect_system_diagnostics',
                              'inspect_audit_log',
                              'inspect_printer_and_hardware_status',
                              'inspect_operational_summary',
                              'trigger_cloud_revalidation',
                              'clear_stuck_print_jobs',
                              'run_local_backup_check'
                            )),
    payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
    state                   text NOT NULL DEFAULT 'queued'
                            CHECK (state IN ('queued', 'delivered', 'completed', 'rejected', 'expired')),
    result                  jsonb,
    error_code              text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    delivered_at            timestamptz,
    completed_at            timestamptz,
    CONSTRAINT local_support_commands_session_fk
      FOREIGN KEY (session_id, business_id)
      REFERENCES local_support_sessions(id, business_id) ON DELETE CASCADE,
    CONSTRAINT local_support_commands_installation_fk
      FOREIGN KEY (local_installation_id, business_id)
      REFERENCES local_installations(id, business_id) ON DELETE CASCADE
);

CREATE INDEX idx_local_support_commands_session
    ON local_support_commands (session_id, created_at ASC);

-- ── 5. Site-side durable local Cloud activation & remote support records ─────

CREATE TABLE local_cloud_activations (
    business_id                     uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    installation_id                 text NOT NULL CHECK (char_length(btrim(installation_id)) BETWEEN 8 AND 200),
    cloud_business_id               uuid NOT NULL,
    cloud_location_id               uuid,
    cloud_origin                    text NOT NULL,
    cloud_installation_public_id    text NOT NULL,
    credential_id                   uuid,
    credential_ciphertext           text,
    staged_credential_ciphertext    text,
    pending_ack                     boolean NOT NULL DEFAULT false,
    state                           text NOT NULL DEFAULT 'not_enrolled'
                                    CHECK (state IN (
                                      'not_enrolled',
                                      'validating',
                                      'active',
                                      'validation_pending',
                                      'locked_invalid'
                                    )),
    lock_reason                     text,
    last_error_code                 text,
    last_attempt_at                 timestamptz,
    last_verified_at                timestamptz,
    consecutive_failures            integer NOT NULL DEFAULT 0,
    next_retry_at                   timestamptz,
    policy_version                  integer NOT NULL DEFAULT 1,
    entitlement_version             integer NOT NULL DEFAULT 1,
    business_revision               text,
    business_digest                 text,
    last_business_updated_at        timestamptz,
    entitlement_snapshot            jsonb NOT NULL DEFAULT '{}'::jsonb,
    policy_snapshot                 jsonb NOT NULL DEFAULT '{}'::jsonb,
    lease_public_key                text,
    lease_payload                   jsonb,
    lease_signature                 text,
    lease_expires_at                timestamptz,
    enforce_offline_lease           boolean NOT NULL DEFAULT false,
    max_observed_clock_at           timestamptz NOT NULL DEFAULT now(),
    enrolled_at                     timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE local_remote_support_sessions (
    id                          uuid PRIMARY KEY,
    business_id                 uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    operator_name               text NOT NULL,
    ticket_id                   uuid,
    reason                      text NOT NULL,
    mode                        text NOT NULL CHECK (mode IN ('read_only', 'controlled', 'recovery_only')),
    state                       text NOT NULL CHECK (state IN (
                                  'pending_owner_consent',
                                  'active',
                                  'paused_disconnected',
                                  'denied',
                                  'ended',
                                  'revoked',
                                  'expired'
                                )),
    requested_duration_minutes  integer NOT NULL,
    consent_expires_at          timestamptz NOT NULL,
    approved_at                 timestamptz,
    approved_by_user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    expires_at                  timestamptz,
    last_cloud_contact_at       timestamptz,
    ended_at                    timestamptz,
    end_reason                  text,
    session_nonce               text NOT NULL,
    executed_command_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_local_remote_support_sessions_business
    ON local_remote_support_sessions (business_id, state, created_at DESC);

-- ── 6. Same-migration Row-Level Security ─────────────────────────────────────

ALTER TABLE local_enrollment_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_enrollment_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_enrollment_codes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE local_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_installations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE local_installation_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_installation_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_installation_credentials FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE local_support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_support_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_support_sessions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE local_support_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_support_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_support_commands FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE local_cloud_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_cloud_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_cloud_activations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE local_remote_support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_remote_support_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_remote_support_sessions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
