-- 0228_support_companion_foundation.sql
--
-- Issue #984 — ticket-driven diagnostics, on-site access tokens, attended
-- remote assistance and Support AI: the server-side records the standalone
-- Windows companion and the superadmin ticket workspace share.
--
-- What this migration owns:
--   * `support_installations` — a verified Windows installation bound to one
--     site device, with a generation counter for fencing (a token/session
--     naming an older generation is rejected, never silently re-bound).
--   * Diagnostic requests, runs and artifact *metadata* — linked to the same
--     ticket, never embedded in message text, never overwriting history.
--   * A global signed repair catalog plus per-ticket repair runs/receipts.
--   * Attended assistance sessions + event journal (separate from
--     `impersonation_grants`; neither grant authorises the other).
--   * On-site access token issuance + redemption journals. Fingerprints and
--     hashes only — reusable token/code plaintext is NEVER stored here.
--   * A durable customer consent/Stop journal and ticket-scoped Support AI
--     conversations with their own tool-event audit and cost attribution.
--
-- Tenancy: every business table carries a denormalised `business_id` (the
-- `support_ticket_messages` shape) with ENABLE+FORCE RLS and the standard
-- `tenant_isolation` policy in THIS migration. Parents expose
-- UNIQUE(id, business_id) so children bind with composite foreign keys —
-- a run/report/session/token row can never link another business's
-- ticket/installation/request. The repair catalog is platform-global (no
-- tenant data), like the other `platform_*`/`support_repair_catalog` policy
-- tables: no RLS, platform capability enforcement at the API boundary.
--
-- This migration adds records only. The native companion, the remote media
-- transport and provider qualification are follow-ups (see ISSUE_984_PLAN.md).

-- ── Verified Windows installations ──────────────────────────────────────────

CREATE TABLE support_installations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id         uuid REFERENCES locations(id) ON DELETE SET NULL,
    site_device_id      uuid NOT NULL,
    generation          integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
    display_name        text NOT NULL DEFAULT '',
    platform            text NOT NULL DEFAULT 'windows' CHECK (platform = 'windows'),
    os_build            text,
    main_version        text,
    companion_version   text,
    schema_compat       text,
    enrollment_state    text NOT NULL DEFAULT 'pending'
                        CHECK (enrollment_state IN ('pending', 'active', 'disabled', 'revoked')),
    capabilities        jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_contact_at     timestamptz,
    revoked_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_installations_device_fk
      FOREIGN KEY (site_device_id, business_id)
      REFERENCES site_devices(id, business_id) ON DELETE CASCADE,
    CONSTRAINT support_installations_location_fk
      FOREIGN KEY (location_id, business_id)
      REFERENCES locations(id, business_id) ON DELETE SET NULL,
    CONSTRAINT uq_support_installations_business_device UNIQUE (business_id, site_device_id),
    CONSTRAINT uq_support_installations_id_business UNIQUE (id, business_id)
);
CREATE INDEX idx_support_installations_business ON support_installations (business_id, updated_at DESC);

-- ── Diagnostic requests + runs + artifacts ─────────────────────────────────

CREATE TABLE support_diagnostic_requests (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    ticket_id               uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    location_id             uuid REFERENCES locations(id) ON DELETE SET NULL,
    installation_id         uuid NOT NULL,
    installation_generation integer NOT NULL CHECK (installation_generation >= 1),
    initiated_by            text NOT NULL CHECK (initiated_by IN ('operator', 'member', 'support_ai')),
    operator_admin_id       uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    member_user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
    modules                 text[] NOT NULL DEFAULT '{}',
    reason                  text NOT NULL DEFAULT '',
    allowed_operations      text[] NOT NULL DEFAULT '{diagnostics.run}',
    expires_at              timestamptz NOT NULL,
    idempotency_key         text NOT NULL,
    state                   text NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'delivered', 'opened', 'consented', 'declined',
                                              'running', 'partial', 'completed', 'failed', 'cancelled', 'expired')),
    -- Immutable incident snapshot: ticket/business/device/operator/scope as
    -- observed at request time, so later changes never rewrite history.
    context_snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_diagnostic_requests_installation_fk
      FOREIGN KEY (installation_id, business_id)
      REFERENCES support_installations(id, business_id) ON DELETE CASCADE,
    CONSTRAINT support_diagnostic_requests_location_fk
      FOREIGN KEY (location_id, business_id)
      REFERENCES locations(id, business_id) ON DELETE SET NULL,
    CONSTRAINT uq_support_diagnostic_requests_idem UNIQUE (business_id, idempotency_key),
    CONSTRAINT uq_support_diagnostic_requests_id_business UNIQUE (id, business_id)
);
CREATE INDEX idx_support_diagnostic_requests_ticket ON support_diagnostic_requests (ticket_id, created_at DESC);
CREATE INDEX idx_support_diagnostic_requests_installation
    ON support_diagnostic_requests (installation_id, state) WHERE state IN ('pending', 'delivered');

CREATE TABLE support_diagnostic_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    request_id          uuid NOT NULL,
    ticket_id           uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    installation_id     uuid NOT NULL,
    state               text NOT NULL DEFAULT 'running'
                        CHECK (state IN ('running', 'partial', 'completed', 'failed', 'cancelled', 'declined')),
    collector_versions  jsonb NOT NULL DEFAULT '{}'::jsonb,
    coverage            jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Redacted before persistence: health codes, versions, counts, sanitized
    -- shapes. No raw config/secrets, personal payloads or physical dumps.
    findings            jsonb NOT NULL DEFAULT '[]'::jsonb,
    severity_overall    text NOT NULL DEFAULT 'unknown'
                        CHECK (severity_overall IN ('ok', 'warning', 'failed', 'unknown')),
    observed_at         timestamptz,
    received_at         timestamptz NOT NULL DEFAULT now(),
    upload_state        text NOT NULL DEFAULT 'not_sent'
                        CHECK (upload_state IN ('local_only', 'not_sent', 'uploading', 'received', 'failed')),
    server_ack_at       timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_diagnostic_runs_request_fk
      FOREIGN KEY (request_id, business_id)
      REFERENCES support_diagnostic_requests(id, business_id) ON DELETE CASCADE,
    CONSTRAINT support_diagnostic_runs_installation_fk
      FOREIGN KEY (installation_id, business_id)
      REFERENCES support_installations(id, business_id) ON DELETE CASCADE,
    CONSTRAINT uq_support_diagnostic_runs_id_business UNIQUE (id, business_id)
);
CREATE INDEX idx_support_diagnostic_runs_ticket ON support_diagnostic_runs (ticket_id, created_at DESC);
CREATE INDEX idx_support_diagnostic_runs_request ON support_diagnostic_runs (request_id, created_at DESC);

CREATE TABLE support_diagnostic_artifacts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    run_id              uuid NOT NULL,
    ticket_id           uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    name                text NOT NULL,
    kind                text NOT NULL DEFAULT 'report',
    mime_type           text NOT NULL DEFAULT 'application/json',
    size_bytes          bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    sha256              text NOT NULL,
    -- External object key; bytes never live in ticket message text.
    storage_key         text NOT NULL,
    manifest            jsonb NOT NULL DEFAULT '{}'::jsonb,
    redaction_summary   jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at          timestamptz,
    deleted_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_diagnostic_artifacts_run_fk
      FOREIGN KEY (run_id, business_id)
      REFERENCES support_diagnostic_runs(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_support_diagnostic_artifacts_ticket ON support_diagnostic_artifacts (ticket_id, created_at DESC);

-- ── Signed repair catalog (global) + repair runs ────────────────────────────

CREATE TABLE support_repair_catalog (
    recipe_id       text NOT NULL,
    version         integer NOT NULL CHECK (version >= 1),
    title           text NOT NULL,
    description     text NOT NULL DEFAULT '',
    risk            text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
    compatibility   jsonb NOT NULL DEFAULT '{}'::jsonb,
    preconditions   jsonb NOT NULL DEFAULT '[]'::jsonb,
    effects         jsonb NOT NULL DEFAULT '[]'::jsonb,
    postchecks      jsonb NOT NULL DEFAULT '[]'::jsonb,
    backup_policy   text NOT NULL DEFAULT 'none' CHECK (backup_policy IN ('none', 'checkpoint', 'verified_backup')),
    -- The exact bounded action, canonicalised; `recipe_hash` is sha256 of it.
    recipe          jsonb NOT NULL DEFAULT '{}'::jsonb,
    recipe_hash     text NOT NULL,
    publisher_admin_id uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    published_at    timestamptz,
    active          boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_support_repair_catalog PRIMARY KEY (recipe_id, version)
);

CREATE TABLE support_repair_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    ticket_id           uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    installation_id     uuid NOT NULL,
    request_id          uuid,
    run_id              uuid,
    recipe_id           text NOT NULL,
    recipe_version      integer NOT NULL,
    -- Pinned at propose time; execution refuses a catalog entry whose
    -- current hash differs (a recipe edited after approval is a new recipe).
    recipe_hash         text NOT NULL,
    actor               text NOT NULL CHECK (actor IN ('operator', 'support_ai')),
    operator_admin_id   uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    state               text NOT NULL DEFAULT 'proposed'
                        CHECK (state IN ('proposed', 'dry_run_ready', 'awaiting_approval', 'authorized',
                                          'executing', 'verifying', 'succeeded', 'rolled_back',
                                          'failed', 'recovery_required', 'declined', 'blocked', 'cancelled')),
    consent_ref         jsonb NOT NULL DEFAULT '{}'::jsonb,
    precondition_results jsonb NOT NULL DEFAULT '[]'::jsonb,
    backup_ref          text,
    before_findings     jsonb NOT NULL DEFAULT '[]'::jsonb,
    after_findings      jsonb NOT NULL DEFAULT '[]'::jsonb,
    verification        jsonb NOT NULL DEFAULT '{}'::jsonb,
    receipt             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_repair_runs_installation_fk
      FOREIGN KEY (installation_id, business_id)
      REFERENCES support_installations(id, business_id) ON DELETE CASCADE,
    CONSTRAINT support_repair_runs_request_fk
      FOREIGN KEY (request_id, business_id)
      REFERENCES support_diagnostic_requests(id, business_id) ON DELETE SET NULL,
    CONSTRAINT support_repair_runs_run_fk
      FOREIGN KEY (run_id, business_id)
      REFERENCES support_diagnostic_runs(id, business_id) ON DELETE SET NULL,
    CONSTRAINT uq_support_repair_runs_id_business UNIQUE (id, business_id)
);
CREATE INDEX idx_support_repair_runs_ticket ON support_repair_runs (ticket_id, created_at DESC);

-- ── Attended assistance sessions + events ───────────────────────────────────

CREATE TABLE support_assistance_sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    ticket_id           uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    installation_id     uuid NOT NULL,
    operator_admin_id   uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    requested_caps      text[] NOT NULL DEFAULT '{}',
    approved_caps       text[] NOT NULL DEFAULT '{}',
    state               text NOT NULL DEFAULT 'requested'
                        CHECK (state IN ('requested', 'awaiting_local_consent', 'approved', 'connecting',
                                          'active_view', 'active_control',
                                          'ended', 'revoked', 'expired', 'failed')),
    reason              text NOT NULL DEFAULT '',
    consent_proof       jsonb NOT NULL DEFAULT '{}'::jsonb,
    policy_version      text NOT NULL DEFAULT 'v1',
    -- Qualified-engine binding; `provider: "none"` until Phase 0 selects one.
    engine_binding      jsonb NOT NULL DEFAULT '{"provider":"none"}'::jsonb,
    lease_epoch         integer NOT NULL DEFAULT 0,
    lease_expires_at    timestamptz,
    started_at          timestamptz,
    ended_at            timestamptz,
    end_reason          text,
    participants        jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_assistance_sessions_installation_fk
      FOREIGN KEY (installation_id, business_id)
      REFERENCES support_installations(id, business_id) ON DELETE CASCADE,
    CONSTRAINT uq_support_assistance_sessions_id_business UNIQUE (id, business_id)
);
CREATE INDEX idx_support_assistance_sessions_ticket ON support_assistance_sessions (ticket_id, created_at DESC);
CREATE INDEX idx_support_assistance_sessions_active
    ON support_assistance_sessions (installation_id, state)
    WHERE state IN ('requested', 'awaiting_local_consent', 'approved', 'connecting', 'active_view', 'active_control');

CREATE TABLE support_assistance_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    session_id  uuid NOT NULL,
    seq         bigint NOT NULL,
    kind        text NOT NULL,
    actor       text NOT NULL DEFAULT '',
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_assistance_events_session_fk
      FOREIGN KEY (session_id, business_id)
      REFERENCES support_assistance_sessions(id, business_id) ON DELETE CASCADE,
    CONSTRAINT uq_support_assistance_events_seq UNIQUE (session_id, seq)
);

-- ── On-site access token issuance + redemption ─────────────────────────────

CREATE TABLE support_access_tokens (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    ticket_id               uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    installation_id         uuid NOT NULL,
    installation_generation integer NOT NULL CHECK (installation_generation >= 1),
    issuer_admin_id         uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    -- sha256 of the issued token/code. Plaintext is shown once at issuance
    -- and never stored, logged, or embedded in tickets/reports.
    fingerprint             text NOT NULL,
    purpose                 text NOT NULL CHECK (purpose IN ('online_code', 'offline_onsite')),
    scope                   jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason                  text NOT NULL DEFAULT '',
    online_code_hash        text,
    key_id                  text,
    not_before              timestamptz NOT NULL DEFAULT now(),
    expires_at              timestamptz NOT NULL,
    max_uses                integer NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
    use_count               integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    state                   text NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'redeemed', 'consumed', 'expired', 'revoked')),
    revoked_at              timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_access_tokens_installation_fk
      FOREIGN KEY (installation_id, business_id)
      REFERENCES support_installations(id, business_id) ON DELETE CASCADE,
    CONSTRAINT uq_support_access_tokens_id_business UNIQUE (id, business_id)
);
CREATE INDEX idx_support_access_tokens_ticket ON support_access_tokens (ticket_id, created_at DESC);
CREATE INDEX idx_support_access_tokens_fingerprint ON support_access_tokens (fingerprint);

CREATE TABLE support_token_redemptions (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id                 uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    token_id                    uuid NOT NULL,
    -- sha256 of the technician device-key / session binding, never the key.
    technician_binding_hash     text,
    installation_challenge      text,
    result                      text NOT NULL CHECK (result IN ('accepted', 'rejected')),
    reject_reason               text,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_token_redemptions_token_fk
      FOREIGN KEY (token_id, business_id)
      REFERENCES support_access_tokens(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_support_token_redemptions_token ON support_token_redemptions (token_id, created_at DESC);

-- ── Customer consent / Stop journal ─────────────────────────────────────────

CREATE TABLE support_consent_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    ticket_id       uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL,
    subject         text NOT NULL CHECK (subject IN ('diagnostics', 'repair', 'remote_view', 'remote_control', 'support_ai')),
    decision        text NOT NULL CHECK (decision IN ('granted', 'denied', 'revoked', 'expired')),
    granted_by      text NOT NULL DEFAULT 'customer' CHECK (granted_by IN ('customer', 'operator', 'system')),
    scope           jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_consent_events_installation_fk
      FOREIGN KEY (installation_id, business_id)
      REFERENCES support_installations(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_support_consent_events_ticket ON support_consent_events (ticket_id, created_at DESC);

-- ── Ticket-scoped Support AI ────────────────────────────────────────────────

CREATE TABLE support_ai_conversations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    ticket_id       uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    installation_id uuid,
    operator_admin_id uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    model_profile   text NOT NULL DEFAULT 'support-default',
    mode            text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'instant', 'deep_research')),
    state           text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'closed')),
    spend_limit_rial bigint NOT NULL DEFAULT 0 CHECK (spend_limit_rial >= 0),
    -- Platform/support attribution. The tenant wallet is never touched.
    spend_rial      bigint NOT NULL DEFAULT 0 CHECK (spend_rial >= 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_ai_conversations_installation_fk
      FOREIGN KEY (installation_id, business_id)
      REFERENCES support_installations(id, business_id) ON DELETE SET NULL,
    CONSTRAINT uq_support_ai_conversations_id_business UNIQUE (id, business_id)
);
CREATE INDEX idx_support_ai_conversations_ticket ON support_ai_conversations (ticket_id, created_at DESC);

CREATE TABLE support_ai_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL,
    role            text NOT NULL CHECK (role IN ('operator', 'assistant', 'system')),
    -- Stored redacted; hidden model reasoning is never persisted.
    content         text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_ai_messages_conversation_fk
      FOREIGN KEY (conversation_id, business_id)
      REFERENCES support_ai_conversations(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_support_ai_messages_conversation ON support_ai_messages (conversation_id, created_at);

CREATE TABLE support_ai_tool_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL,
    message_id      uuid REFERENCES support_ai_messages(id) ON DELETE SET NULL,
    tool_name       text NOT NULL,
    args_redacted   jsonb NOT NULL DEFAULT '{}'::jsonb,
    result_summary  text NOT NULL DEFAULT '',
    permission      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_ai_tool_events_conversation_fk
      FOREIGN KEY (conversation_id, business_id)
      REFERENCES support_ai_conversations(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_support_ai_tool_events_conversation ON support_ai_tool_events (conversation_id, created_at);

-- ── RLS: same-migration tenant isolation on every business table ────────────

ALTER TABLE support_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_installations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_diagnostic_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_diagnostic_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_diagnostic_requests FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_diagnostic_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_diagnostic_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_diagnostic_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_diagnostic_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_diagnostic_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_diagnostic_artifacts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_repair_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_repair_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_repair_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_assistance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_assistance_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_assistance_sessions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_assistance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_assistance_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_assistance_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_access_tokens FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_token_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_token_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_token_redemptions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_consent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_consent_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ai_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_ai_conversations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ai_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_ai_messages FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_ai_tool_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ai_tool_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_ai_tool_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
